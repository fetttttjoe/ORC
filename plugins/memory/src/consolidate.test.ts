import { describe, expect, it } from 'bun:test'
import { LINK_KIND, MEMORY_ACCESS, MemoryNoteInput, slugId, type EventRecord, type MemoryNoteDraft, type MemoryStore } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import type { EventLog } from '@orc/kernel'
import { CONSOLIDATED_TAG, consolidateTask, consolidatedNote, isSubstantive } from './consolidate'

describe('consolidatedNote', () => {
  it('promotes step outcomes into one durable project note, linked derived_from what the task read', () => {
    const draft = consolidatedNote({
      taskId: 'a1b2c3d4-0000-4000-8000-000000000001',
      taskTitle: 'Explain memory heat',
      steps: [{ title: 'Step A', summary: 'edges strengthen via memory_accessed' }, { title: 'Step B', summary: '   ' }],
      derivedFrom: ['area-memory', 'area-memory', 'projector-re-materialization'], // dup on purpose
      unfinished: [],
    })
    expect(draft.id).toBe(slugId('outcome a1b2c3d4-0000-4000-8000-000000000001'))
    expect(draft.scope).toBe('project')
    expect(draft.retention).toBe('durable')
    expect(draft.tags).toEqual([CONSOLIDATED_TAG])
    // deduped, typed provenance edges — project→project, so they resolve in the graph
    expect(draft.links).toEqual([
      { id: 'area-memory', kind: LINK_KIND.derived_from },
      { id: 'projector-re-materialization', kind: LINK_KIND.derived_from },
    ])
    // a blank-summary step is dropped from the body; the first real summary seeds the note summary
    expect(draft.body).toBe('- Step A: edges strengthen via memory_accessed')
    expect(draft.summary).toBe('edges strengthen via memory_accessed')
    // validates as a real note draft — no surprises at the store boundary
    expect(() => MemoryNoteInput.parse(draft)).not.toThrow()
  })

  // Titles are not unique — a re-run, a recurring chore, or two operators phrasing the same request
  // produce the same one. Keyed on the title, the second task's note landed on the first task's id
  // and overwrote its outcome; the per-task idempotency key means both writes go through, so the
  // first task's record was simply gone.
  it('two tasks sharing a title get two notes, not one overwriting the other', () => {
    const of = (taskId: string): MemoryNoteDraft =>
      consolidatedNote({ taskId, taskTitle: 'Fix the auth bug', steps: [{ title: 'a', summary: 'x' }], derivedFrom: [], unfinished: [] })
    expect(of('run-one').id).not.toBe(of('run-two').id)
    expect(of('run-one').id).toBe(of('run-one').id) // still idempotent for the SAME task
  })

  it('with no steps and no provenance still yields a valid (if thin) durable note', () => {
    const draft = consolidatedNote({ taskId: 'empty-1', taskTitle: 'Empty task', steps: [], derivedFrom: [], unfinished: [] })
    expect(draft.body).toBe('')
    expect(draft.links).toEqual([])
    expect(draft.summary).toBe('Empty task')
    expect(() => MemoryNoteInput.parse(draft)).not.toThrow()
  })

  it('uses distilled text when provided, keeping the task-keyed id, scope, and links', () => {
    const draft = consolidatedNote(
      { taskId: 'a1b2c3d4-0000-4000-8000-000000000001', taskTitle: 'Explain memory heat', steps: [{ title: 'a', summary: 'raw' }], derivedFrom: ['area-memory'], unfinished: [] },
      { title: 'How memory heat works', summary: 'Edges strengthen on use.', body: '- via records the edge' },
    )
    expect(draft.title).toBe('How memory heat works') // distilled, not "Outcome: …"
    expect(draft.summary).toBe('Edges strengthen on use.')
    expect(draft.body).toBe('- via records the edge') // distilled body, not the extractive bullet
    expect(draft.id).toBe(slugId('outcome a1b2c3d4-0000-4000-8000-000000000001')) // id stays task-keyed → idempotent
    expect(draft.scope).toBe('project')
    expect(draft.links).toEqual([{ id: 'area-memory', kind: LINK_KIND.derived_from }])
    expect(() => MemoryNoteInput.parse(draft)).not.toThrow()
  })
})

describe('isSubstantive', () => {
  it('gates on real work: read project knowledge OR multiple steps; skips trivial single lookups', () => {
    expect(isSubstantive({ steps: [{ title: 'a', summary: 'x' }], derivedFrom: ['area-memory'] })).toBe(true) // has provenance
    expect(isSubstantive({ steps: [{ title: 'a', summary: 'x' }, { title: 'b', summary: 'y' }], derivedFrom: [] })).toBe(true) // composed
    expect(isSubstantive({ steps: [{ title: 'a', summary: 'x' }], derivedFrom: [] })).toBe(false) // trivial single lookup
    expect(isSubstantive({ steps: [], derivedFrom: [] })).toBe(false)
  })
})

describe('consolidateTask provenance', () => {
  // Minimal fakes: consolidateTask reads three event slices off the log and one scoped note list off
  // the store. Nothing here mocks the code under test — the fakes ARE the two collaborators.
  const logOf = (events: EventRecord[]): Pick<EventLog, 'after'> => ({
    after: async (_seq, kinds) => events.filter(e => !kinds || kinds.includes(e.kind)),
  })
  const storeOf = (written: MemoryNoteDraft[]): Pick<MemoryStore, 'list' | 'write'> => ({
    list: async () => [],
    write: async note => { written.push(note); return note as never },
  })
  const created = (taskId: string, title: string): EventRecord =>
    eventFixture({
      taskId, kind: 'task_created',
      payload: { task: { id: taskId, parentId: null, type: 'generic', title, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-26T00:00:00.000Z' } },
    })
  const accessed = (taskId: string, id: string, mode: string): EventRecord =>
    eventFixture({ taskId, kind: 'memory_accessed', payload: { id, scope: 'project', mode, author: { source: 'agent', taskId } } })

  const TASK = '11111111-1111-1111-1111-111111111111'

  // The whole point of giving preload its own access mode: a step that leaned on injected context
  // without ever calling memory_read must still record WHAT it stood on. Before preload was
  // journaled this list came back empty, the salience gate declined, and the task left no note.
  it('a preload access is provenance, exactly like a read', async () => {
    const written: MemoryNoteDraft[] = []
    const note = await consolidateTask(
      { log: logOf([created(TASK, 'Explain heat'), accessed(TASK, 'area-memory', MEMORY_ACCESS.preload)]) as EventLog, store: storeOf(written) as MemoryStore },
      TASK,
    )
    expect(note).not.toBeNull()
    expect(written[0]?.links).toEqual([{ id: 'area-memory', kind: LINK_KIND.derived_from }])
  })

  it('an access belonging to a DIFFERENT task is not this task\'s provenance', async () => {
    const written: MemoryNoteDraft[] = []
    const other = '22222222-2222-2222-2222-222222222222'
    const note = await consolidateTask(
      { log: logOf([created(TASK, 'Explain heat'), accessed(other, 'area-memory', MEMORY_ACCESS.preload)]) as EventLog, store: storeOf(written) as MemoryStore },
      TASK,
    )
    // no provenance and no second step -> the salience gate declines, nothing is written
    expect(note).toBeNull()
    expect(written).toEqual([])
  })
})
