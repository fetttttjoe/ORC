import { describe, expect, it } from 'bun:test'
import { LINK_KIND, MEMORY_ACCESS, MemoryNoteInput, NOTE_KIND, slugId, type EventRecord, type MemoryNoteDraft, type MemoryStore } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import type { EventLog } from '@orc/kernel'
import { AREA_ROOT, CONSOLIDATED_TAG, areaOf, consolidateTask, consolidatedNote, consolidatedNotes, isPlanChild, isSubstantive } from './consolidate'

describe('consolidatedNote', () => {
  it('promotes step outcomes into one durable project note, linked derived_from what the task read', () => {
    const draft = consolidatedNote({
      taskId: 'a1b2c3d4-0000-4000-8000-000000000001',
      taskTitle: 'Explain memory heat',
      steps: [{ title: 'Step A', summary: 'edges strengthen via memory_accessed' }, { title: 'Step B', summary: '   ' }],
      derivedFrom: ['area-memory', 'area-memory', 'projector-re-materialization'], // dup on purpose
      unfinished: [],
      paths: [],
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

  // A consolidation used to claim kind:'decision'. Measured on the live vault 2026-08-04: ALL 42
  // notes carrying that kind were outcome-<uuid> consolidations and not one was an architectural
  // decision — so "read the decisions this project holds" returned 42 task outcomes and zero
  // decisions, which makes a decision record unusable as a record. A note saying what one run DID
  // is not a choice the project committed to; they are different questions with different lifetimes.
  it('is an OUTCOME, never a decision — the two are different questions', () => {
    const draft = consolidatedNote({
      taskId: 'k1', taskTitle: 'Something happened', steps: [{ title: 'a', summary: 'x' }],
      derivedFrom: [], unfinished: [], paths: [],
    })
    expect(draft.kind).toBe(NOTE_KIND.outcome)
    expect(draft.kind).not.toBe(NOTE_KIND.decision)
  })

  // Titles are not unique — a re-run, a recurring chore, or two operators phrasing the same request
  // produce the same one. Keyed on the title, the second task's note landed on the first task's id
  // and overwrote its outcome; the per-task idempotency key means both writes go through, so the
  // first task's record was simply gone.
  it('two tasks sharing a title get two notes, not one overwriting the other', () => {
    const of = (taskId: string): MemoryNoteDraft =>
      consolidatedNote({ taskId, taskTitle: 'Fix the auth bug', steps: [{ title: 'a', summary: 'x' }], derivedFrom: [], unfinished: [], paths: [] })
    expect(of('run-one').id).not.toBe(of('run-two').id)
    expect(of('run-one').id).toBe(of('run-one').id) // still idempotent for the SAME task
  })

  it('with no steps and no provenance still yields a valid (if thin) durable note', () => {
    const draft = consolidatedNote({ taskId: 'empty-1', taskTitle: 'Empty task', steps: [], derivedFrom: [], unfinished: [], paths: [] })
    expect(draft.body).toBe('')
    expect(draft.links).toEqual([])
    expect(draft.summary).toBe('Empty task')
    expect(() => MemoryNoteInput.parse(draft)).not.toThrow()
  })

  it('uses distilled text when provided, keeping the task-keyed id, scope, and links', () => {
    const draft = consolidatedNote(
      { taskId: 'a1b2c3d4-0000-4000-8000-000000000001', taskTitle: 'Explain memory heat', steps: [{ title: 'a', summary: 'raw' }], derivedFrom: ['area-memory'], unfinished: [], paths: [] },
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

describe('areaOf', () => {
  it('monorepo namespaces keep two segments, everything else one, root files fold together', () => {
    expect(areaOf('packages/cli/src/main.ts')).toBe('packages/cli')
    expect(areaOf('plugins/memory/src/tools.ts')).toBe('plugins/memory')
    expect(areaOf('docs/mcp-overview.md')).toBe('docs')
    expect(areaOf('scripts/hooks/commit-msg')).toBe('scripts')
    expect(areaOf('README.md')).toBe(AREA_ROOT)
  })
})

describe('isPlanChild', () => {
  it('a grounded planning child never consolidates — its outcome IS the plan notes', () => {
    expect(isPlanChild('798d7b9c-dca5-4adc-b053-2849b3e71944.plan.toolu_013x')).toBe(true)
    expect(isPlanChild('798d7b9c-dca5-4adc-b053-2849b3e71944')).toBe(false)
    expect(isPlanChild('798d7b9c-dca5-4adc-b053-2849b3e71944.impl.toolu_01ab')).toBe(false)
  })
})

describe('consolidatedNotes — the area split', () => {
  const base = {
    taskId: 'a1b2c3d4-0000-4000-8000-000000000001',
    taskTitle: 'Cross-cutting fix',
    steps: [{ title: 'Step A', summary: 'did the thing' }],
    derivedFrom: ['area-memory'],
    unfinished: [],
  }

  it('a single-area task keeps the legacy id and gains its paths', () => {
    const notes = consolidatedNotes({ ...base, paths: ['plugins/memory/src/tools.ts', 'plugins/memory/src/step.ts'] })
    expect(notes.length).toBe(1)
    expect(notes[0]?.id).toBe(slugId('outcome a1b2c3d4-0000-4000-8000-000000000001'))
    // sorted + deduped — deterministic like every other list the store compares
    expect(notes[0]?.paths).toEqual(['plugins/memory/src/step.ts', 'plugins/memory/src/tools.ts'])
    expect(() => MemoryNoteInput.parse(notes[0])).not.toThrow()
  })

  it('a read-only task stays a single unanchored note — nothing to cite is the honest state', () => {
    const notes = consolidatedNotes({ ...base, paths: [] })
    expect(notes.length).toBe(1)
    expect(notes[0]?.paths).toBeUndefined()
  })

  it('a multi-area task emits one note per area, cross-linked — never a god node', () => {
    // DECIDED 2026-08-03: one note citing every touched subsystem is arch-overview's disease —
    // a degree-81 hub that re-drifts on every commit anywhere. Split by area instead.
    const notes = consolidatedNotes({
      ...base,
      paths: ['plugins/memory/src/tools.ts', 'packages/cli/src/actions.ts', 'packages/cli/src/main.ts'],
    })
    expect(notes.map(n => n.id).sort()).toEqual([
      slugId('outcome a1b2c3d4-0000-4000-8000-000000000001 packages/cli'),
      slugId('outcome a1b2c3d4-0000-4000-8000-000000000001 plugins/memory'),
    ].sort())
    const byArea = new Map(notes.map(n => [n.paths?.[0]?.startsWith('packages') ? 'cli' : 'mem', n]))
    expect(byArea.get('cli')?.paths).toEqual(['packages/cli/src/actions.ts', 'packages/cli/src/main.ts'])
    expect(byArea.get('mem')?.paths).toEqual(['plugins/memory/src/tools.ts'])
    // every area note keeps the shared provenance AND links its siblings
    for (const n of notes) {
      expect(n.links).toEqual(expect.arrayContaining([{ id: 'area-memory', kind: LINK_KIND.derived_from }]))
      const sibling = notes.find(o => o !== n)!
      expect(n.links).toEqual(expect.arrayContaining([{ id: sibling.id, kind: LINK_KIND.relates_to }]))
      expect(n.title).toContain(' — ')
      expect(() => MemoryNoteInput.parse(n)).not.toThrow()
    }
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

  // 'cli' is what a HUMAN at a terminal writes as — every packages/cli memory command passes it,
  // and store.ts defaults to it. A consolidation is machine output, so claiming 'cli' made every
  // outcome note in the vault read `createdBy: cli`, indistinguishable from one a person typed.
  // That is corrosive exactly where it matters most: a knowledge base whose decisions are supposed
  // to carry "a human approved this" cannot tell those apart from what the machine wrote itself.
  it('is attributed to the machine, never to a person at a terminal', async () => {
    const authors: unknown[] = []
    const store: Pick<MemoryStore, 'list' | 'write'> = {
      list: async () => [],
      write: async (note, author) => { authors.push(author); return note as never },
    }
    const note = await consolidateTask(
      { log: logOf([created(TASK, 'Explain heat'), accessed(TASK, 'area-memory', MEMORY_ACCESS.preload)]) as EventLog, store: store as MemoryStore },
      TASK,
    )
    expect(note).not.toBeNull()
    expect(authors[0]).not.toEqual({ source: 'cli' })
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

  const wrote = (taskId: string, toolName: string, path: string): EventRecord =>
    eventFixture({
      taskId, kind: 'tool_call',
      payload: { stepId: 's1', runToken: `step:${taskId}:s1:a1`, iteration: 1, toolCallId: 'c1', toolName, input: { path, content: 'x' } },
    })

  it('the outcome note carries the paths the task itself wrote — the WHY layer becomes checkable', async () => {
    const written: MemoryNoteDraft[] = []
    await consolidateTask(
      { log: logOf([
          created(TASK, 'Fix the tools'),
          accessed(TASK, 'area-memory', MEMORY_ACCESS.read),
          wrote(TASK, 'fs_write', 'plugins/memory/src/tools.ts'),
          wrote(TASK, 'fs_edit', 'plugins/memory/src/tools.ts'), // dup path folds to one
          wrote('33333333-3333-3333-3333-333333333333', 'fs_write', 'packages/cli/src/main.ts'), // other task's write is not ours
        ]) as EventLog, store: storeOf(written) as MemoryStore },
      TASK,
    )
    expect(written.length).toBe(1)
    expect(written[0]?.paths).toEqual(['plugins/memory/src/tools.ts'])
  })

  it('a .plan. child writes nothing — the plan lane already holds its outcome', async () => {
    const written: MemoryNoteDraft[] = []
    const child = `${TASK}.plan.toolu_01xyz`
    const note = await consolidateTask(
      { log: logOf([created(child, 'Author the plan'), accessed(child, 'area-memory', MEMORY_ACCESS.read)]) as EventLog, store: storeOf(written) as MemoryStore },
      child,
    )
    expect(note).toBeNull()
    expect(written).toEqual([])
  })
})
