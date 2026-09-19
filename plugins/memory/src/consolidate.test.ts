import { describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, LINK_KIND, MEMORY_ACCESS, MemoryNote, MemoryNoteInput, NOTE_KIND, NO_CHAT, slugId, type EventRecord, type MemoryAuthor, type MemoryNoteDraft } from '@orc/contracts'
import { eventFixture, must, semanticNoteFixture } from '@orc/contracts/fixtures'
import { TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { AREA_ROOT, CONSOLIDATED_TAG, areaOf, consolidateTask, CONSOLIDATE_EXECUTOR, consolidatedNote, consolidatedNotes, isPlanChild, isSubstantive, taskInfo, type ConsolidationLog, type ConsolidationStore } from './consolidate'

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

  // A consolidation is an OUTCOME, not a decision — they answer different questions with different
  // lifetimes. [Measured 2026-08-04: all 42 notes with kind:'decision' were outcome consolidations,
  // making decision queries return 42 task outcomes and zero architectural choices.]
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
      const sibling = must(notes.find(o => o !== n), 'notes.find(o => o !== n)')
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

// The author the composition root's authorFor builds (runtime.ts / `orc memory consolidate`):
// 'agent' named through `executor`, stamped with the writing task's workspace. Fixed to
// TEST_WORKSPACE_ID here (via `authorFor: () => CONSOLIDATE_AUTHOR`) because these tests are not
// about WHICH workspace gets named — see consolidate-integration.test.ts for that behaviour.
const CONSOLIDATE_AUTHOR: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, executor: CONSOLIDATE_EXECUTOR, origin: NO_CHAT(Door.supervisor) }

describe('consolidateTask provenance', () => {
  // Minimal fakes: consolidateTask reads three event slices off the log and one scoped note list off
  // the store. Nothing here mocks the code under test — the fakes ARE the two collaborators.
  const logOf = (events: EventRecord[]): ConsolidationLog => ({
    after: async (_seq, kinds) => events.filter(e => !kinds || kinds.includes(e.kind)),
  })
  // the fake echoes the draft back as a stored note (parsed, so the shape is the real one): the
  // tests read links and titles off the return
  const stored = (note: MemoryNoteDraft): MemoryNote => MemoryNote.parse({ ...semanticNoteFixture(), ...note })
  const storeOf = (written: MemoryNoteDraft[]): ConsolidationStore => ({
    list: async () => [],
    write: async note => { written.push(note); return stored(note) },
    setArchivedAll: async () => {},
  })
  const created = (taskId: string, title: string): EventRecord =>
    eventFixture({
      taskId, kind: EVENT_KIND.task_created,
      payload: { task: { id: taskId, parentId: null, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-26T00:00:00.000Z' } },
    })
  const accessed = (taskId: string, id: string, mode: string): EventRecord =>
    eventFixture({ taskId, kind: EVENT_KIND.memory_accessed, payload: { id, scope: 'project', mode, author: { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId, origin: { chatId: `run:${taskId}:v1`, door: Door.supervisor } } } })

  const TASK = '11111111-1111-1111-1111-111111111111'

  // The whole point of giving preload its own access mode: a step that leaned on injected context
  // without ever calling memory_read must still record WHAT it stood on. Before preload was
  // journaled this list came back empty, the salience gate declined, and the task left no note.
  it('a preload access is provenance, exactly like a read', async () => {
    const written: MemoryNoteDraft[] = []
    const log = logOf([created(TASK, 'Explain heat'), accessed(TASK, 'area-memory', MEMORY_ACCESS.preload)])
    const note = await consolidateTask(
      { log, store: storeOf(written), authorFor: () => CONSOLIDATE_AUTHOR },
      TASK, await taskInfo(log, TASK),
    )
    expect(note).not.toBeNull()
    expect(written[0]?.links).toEqual([{ id: 'area-memory', kind: LINK_KIND.derived_from }])
  })

  // 'cli' is what a HUMAN at a terminal writes as — every packages/cli memory command passes it.
  // A consolidation is machine output, so claiming 'cli' made every outcome note in the vault read
  // `createdBy: cli`, indistinguishable from one a person typed. That is corrosive exactly where it
  // matters most: a knowledge base whose decisions are supposed to carry "a human approved this"
  // cannot tell those apart from what the machine wrote itself.
  // The author is now the caller's, so what this pins is that it travels through UNCHANGED — a
  // consolidation that rebuilt or defaulted an author here is what the old 'cli' stamp WAS.
  it('writes as the author it was given, never one of its own making', async () => {
    const authors: unknown[] = []
    const store: ConsolidationStore = {
      list: async () => [],
      write: async (note, author) => { authors.push(author); return stored(note) },
      setArchivedAll: async () => {},
    }
    const log = logOf([created(TASK, 'Explain heat'), accessed(TASK, 'area-memory', MEMORY_ACCESS.preload)])
    const note = await consolidateTask(
      { log, store, authorFor: () => CONSOLIDATE_AUTHOR },
      TASK, await taskInfo(log, TASK),
    )
    expect(note).not.toBeNull()
    expect(authors[0]).toEqual(CONSOLIDATE_AUTHOR)
    expect(authors[0]).not.toEqual({ source: 'cli', workspaceId: TEST_WORKSPACE_ID })
  })

  it('an access belonging to a DIFFERENT task is not this task\'s provenance', async () => {
    const written: MemoryNoteDraft[] = []
    const other = '22222222-2222-2222-2222-222222222222'
    const log = logOf([created(TASK, 'Explain heat'), accessed(other, 'area-memory', MEMORY_ACCESS.preload)])
    const note = await consolidateTask(
      { log, store: storeOf(written), authorFor: () => CONSOLIDATE_AUTHOR },
      TASK, await taskInfo(log, TASK),
    )
    // no provenance and no second step -> the salience gate declines, nothing is written
    expect(note).toBeNull()
    expect(written).toEqual([])
  })

  const wrote = (taskId: string, toolName: string, path: string): EventRecord =>
    eventFixture({
      taskId, kind: EVENT_KIND.tool_call,
      payload: { stepId: 's1', runToken: `step:${taskId}:s1:a1`, iteration: 1, toolCallId: 'c1', toolName, input: { path, content: 'x' } },
    })

  it('the outcome note carries the paths the task itself wrote — the WHY layer becomes checkable', async () => {
    const written: MemoryNoteDraft[] = []
    const log = logOf([
      created(TASK, 'Fix the tools'),
      accessed(TASK, 'area-memory', MEMORY_ACCESS.read),
      wrote(TASK, 'fs_write', 'plugins/memory/src/tools.ts'),
      wrote(TASK, 'fs_edit', 'plugins/memory/src/tools.ts'), // dup path folds to one
      wrote('33333333-3333-3333-3333-333333333333', 'fs_write', 'packages/cli/src/main.ts'), // other task's write is not ours
    ])
    await consolidateTask(
      { log, store: storeOf(written), authorFor: () => CONSOLIDATE_AUTHOR },
      TASK, await taskInfo(log, TASK),
    )
    expect(written.length).toBe(1)
    expect(written[0]?.paths).toEqual(['plugins/memory/src/tools.ts'])
  })

  it('a .plan. child writes nothing — the plan lane already holds its outcome', async () => {
    const written: MemoryNoteDraft[] = []
    const child = `${TASK}.plan.toolu_01xyz`
    // consolidateOnCompletion always resolves before calling consolidateTask, even for a plan
    // child (retireStepTrail still needs it) — so this test resolves too, to pin that the
    // plan-child short-circuit wins even when a real TaskInfo was handed in.
    const log = logOf([created(child, 'Author the plan'), accessed(child, 'area-memory', MEMORY_ACCESS.read)])
    const note = await consolidateTask(
      { log, store: storeOf(written), authorFor: () => CONSOLIDATE_AUTHOR },
      child, await taskInfo(log, child),
    )
    expect(note).toBeNull()
    expect(written).toEqual([])
  })
})
