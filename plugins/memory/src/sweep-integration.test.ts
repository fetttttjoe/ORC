import { afterAll, expect, it } from 'bun:test'
import { EVENT_KIND, MemoryWrittenPayload, RETENTION, planScope } from '@orc/contracts'
import { createLiveMemory } from './test-helpers'
import { staleNotes } from './sweep'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

const MEMORY_KINDS = [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted, EVENT_KIND.memory_accessed]

// The whole `orc memory sweep --apply` path over a real log + read model: the policy sees what the
// store actually wrote, the deletion reaches the projection, and the retired content survives in the
// log. `now` is passed 60 days ahead rather than backdating events — event timestamps are the log's
// to stamp, and a test that forged them would be testing a shape production never produces.
it('retires a cold expirable note end-to-end, keeps durable knowledge, and leaves the content in the log', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.store.write(
    { id: 'step-a', scope: planScope('t1'), title: 'Step A', summary: 'did A', retention: RETENTION.expirable },
    { source: 'agent', taskId: 't1' },
  )
  await live.store.write({ id: 'area-x', title: 'Area X', summary: 'durable knowledge' }, { source: 'cli' })
  await live.projector.catchUp()

  const sixtyDaysOn = new Date(Date.now() + 60 * 86_400_000).toISOString()
  const goes = staleNotes(await live.log.after(0, MEMORY_KINDS), { now: sixtyDaysOn, days: 30 })
  expect(goes.map(n => n.id)).toEqual(['step-a']) // the durable note is never a candidate, whatever its age

  for (const n of goes) await live.store.remove(n.id, n.scope, { source: 'cli' })
  await live.projector.catchUp()
  expect(await live.store.get('step-a', planScope('t1'))).toBeNull()
  expect(await live.store.get('area-x')).not.toBeNull()

  // re-sweeping is a no-op: a deleted note is no longer live
  expect(staleNotes(await live.log.after(0, MEMORY_KINDS), { now: sixtyDaysOn, days: 30 })).toEqual([])

  // deletion is an event, not an erasure — the retired note's content is still replayable
  const retired = (await live.log.after(0, [EVENT_KIND.memory_written]))
    .map(e => MemoryWrittenPayload.parse(e.payload).note)
    .filter(n => n.id === 'step-a')
  expect(retired.at(-1)?.summary).toBe('did A')
})

it('a read inside the window keeps a note the TTL would otherwise retire', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.store.write(
    { id: 'step-b', scope: planScope('t2'), title: 'Step B', summary: 'did B', retention: RETENTION.expirable },
    { source: 'agent', taskId: 't2' },
  )
  await live.store.recordAccess('step-b', planScope('t2'), 'read', { source: 'agent', taskId: 't3' })

  const tenDaysOn = new Date(Date.now() + 10 * 86_400_000).toISOString()
  expect(staleNotes(await live.log.after(0, MEMORY_KINDS), { now: tenDaysOn, days: 30 })).toEqual([])
})
