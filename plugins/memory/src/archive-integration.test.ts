import { afterAll, expect, it } from 'bun:test'
import { EVENT_KIND, MemoryWrittenPayload } from '@orc/contracts'
import { createLiveMemory } from './test-helpers'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

/**
 * The archive → restore round trip over a real log + read model.
 *
 * This exists because the first implementation made archival a ONE-WAY DOOR while reporting
 * success: `setArchived` read the note through the read model, archiving deletes that row, so a
 * restore found nothing, returned its idempotent no-op, and printed "restored". Nothing but a
 * round trip against real infrastructure catches that — the unit tests all passed.
 */
it('archives a note out of the read model and restores it from the log', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)

  await live.store.write({ id: 'area-x', title: 'Area X', summary: 'durable knowledge' }, { source: 'cli' })
  await live.projector.catchUp()
  expect(await live.store.get('area-x')).not.toBeNull()

  await live.store.setArchived('area-x', 'project', true, { source: 'cli' })
  await live.projector.catchUp()
  // gone from the read model, so search/neighbours/ranking cannot surface it
  expect(await live.store.get('area-x')).toBeNull()

  await live.store.setArchived('area-x', 'project', false, { source: 'cli' })
  await live.projector.catchUp()
  const back = await live.store.get('area-x')
  expect(back).not.toBeNull()
  // and it comes back as it was — a restore is not a fresh write
  expect(back?.title).toBe('Area X')
  expect(back?.summary).toBe('durable knowledge')
})

it('is idempotent in both directions — archiving twice is not a fault', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.store.write({ id: 'n', title: 'N', summary: 's' }, { source: 'cli' })
  await live.projector.catchUp()
  await live.store.setArchived('n', 'project', true, { source: 'cli' })
  await live.store.setArchived('n', 'project', true, { source: 'cli' }) // no second event
  await live.projector.catchUp()
  expect(await live.store.get('n')).toBeNull()
})

/**
 * A lifecycle move must not rewrite AUTHORSHIP. Task-bound notes carry the taskId of the step that
 * wrote them, and `taskSettled` — the rule that retires plan scaffolding — reads it. Stamping the
 * operator as author erased it, so a restored plan note lost its binding and became permanently
 * unretirable. Measured on the live corpus: three restored notes stopped being candidates.
 */
it('keeps the note\'s own author across archive and restore', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.store.write({ id: 'step-x', scope: 'plan-t1', title: 'Step X', summary: 's' }, { source: 'agent', taskId: 't1' })
  await live.projector.catchUp()

  await live.store.setArchived('step-x', 'plan-t1', true, { source: 'cli' })
  await live.store.setArchived('step-x', 'plan-t1', false, { source: 'cli' })
  await live.projector.catchUp()

  const events = await live.log.after(0, [EVENT_KIND.memory_written])
  const last = events.filter(e => MemoryWrittenPayload.safeParse(e.payload).data?.note.id === 'step-x').at(-1)
  const author = MemoryWrittenPayload.parse(last?.payload).author
  expect(author.taskId).toBe('t1')
  expect(author.source).toBe('agent')
})

/**
 * write() must hand back what it just WROTE. It read the projected row after appending but before
 * the projector drained, so every update returned the previous revision — and memory_write lints
 * what write() returns, so an update introducing a dangling link or a paths-warning body was
 * linted against the note's old content and came back clean.
 */
it('returns the content just written, not the previous revision', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)

  await live.store.write({ id: 'n', title: 'N', summary: 'ONE', body: 'old body' }, { source: 'cli' })
  await live.projector.catchUp()

  const back = await live.store.write({ id: 'n', summary: 'TWO', body: 'new body' }, { source: 'cli' })
  expect(back.summary).toBe('TWO')
  expect(back.body).toBe('new body')
  // provenance still comes from the projected row, which is what it is there for
  expect(back.createdBy).toBe('cli')
})

/**
 * `recheck --apply` archives every retirable note, and each setArchived call opened with a full
 * `log.after(0, KNOWLEDGE_KINDS)` + fold — N log reads and N folds against a log already past 70k
 * events. The batch door folds once.
 *
 * Counting log reads rather than timing: a wall-clock assertion would pass on a fast machine with
 * the quadratic intact.
 */
it('archives many notes with ONE pass over the log, not one per note', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)

  const ids = ['a', 'b', 'c']
  for (const id of ids) await live.store.write({ id, title: id, summary: id }, { source: 'cli' })
  await live.projector.catchUp()

  let reads = 0
  const realAfter = live.log.after.bind(live.log)
  live.log.after = ((...args: Parameters<typeof realAfter>) => { reads += 1; return realAfter(...args) }) as typeof realAfter

  await live.store.setArchivedAll(ids.map(id => ({ id, scope: 'project' })), true, { source: 'cli' })
  // asserted BEFORE catchUp: the projector reads the log too, and counting its pass would hide
  // whether the store made one or three
  expect(reads).toBe(1)
  await live.projector.catchUp()
  for (const id of ids) expect(await live.store.get(id)).toBeNull()
})

it('the batch door is idempotent and skips ids the log never had', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)

  await live.store.write({ id: 'real', title: 'Real', summary: 's' }, { source: 'cli' })
  await live.projector.catchUp()
  // a ghost id alongside a real one must not throw — retiring twice is not a fault, and neither is
  // naming something the log never carried
  await live.store.setArchivedAll([{ id: 'real', scope: 'project' }, { id: 'ghost', scope: 'project' }], true, { source: 'cli' })
  await live.store.setArchivedAll([{ id: 'real', scope: 'project' }], true, { source: 'cli' })
  await live.projector.catchUp()
  expect(await live.store.get('real')).toBeNull()

  await live.store.setArchivedAll([{ id: 'real', scope: 'project' }], false, { source: 'cli' })
  await live.projector.catchUp()
  expect((await live.store.get('real'))?.title).toBe('Real')
})
