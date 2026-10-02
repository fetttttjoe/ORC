import { describe, expect, it } from 'bun:test'
import {
  AUTHOR_SOURCE, Door, EDGE_DIRECTION, LINK_KIND, MemoryScope, NOTE_TIER, SignalOutcome, planScope, slugId,
  type MemoryAuthor, MemoryNote, type MemoryNoteDraft, type MemoryStore,
} from '@orc/contracts'
import { bindStepMemory } from './step'
import { noopMemoryStore } from './test-helpers'
import { authorFixture, semanticNoteFixture, TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'

// The step reads and writes from inside its own run, so the origin is that run's chat.
const AUTHOR: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.agent, taskId: 'task-1', stepId: 'implement', runToken: 'rt-1', origin: { chatId: 'run:task-1:implement', door: Door.supervisor } })

// A store double that records what was asked of it; everything else is the minimum the binding touches.
function fakeStore(opts: { notes?: Record<string, MemoryNote> } = {}) {
  const writes: MemoryNoteDraft[] = []
  // Who each write claimed to be. MemoryAuthor.workspaceId is captured at write time and never
  // recoverable afterwards, so "the binding wrote as the author it was handed" needs the author,
  // not just the draft.
  const writeAuthors: MemoryAuthor[] = []
  const store: MemoryStore = {
    ...noopMemoryStore(),
    recordAccess: async () => {},
    write: async (note, author) => { writes.push(note); writeAuthors.push(author); return MemoryNote.parse({ ...semanticNoteFixture(), ...note }) },
    get: async id => opts.notes?.[id] ?? null,
  }
  return { store, writes, writeAuthors }
}

const bind = (f: ReturnType<typeof fakeStore>, over: Partial<Parameters<typeof bindStepMemory>[0]> = {}) =>
  bindStepMemory({
    store: f.store, author: AUTHOR, taskId: 'task-1',
    step: { id: 'implement', title: 'Refactor authentication middleware', dependsOn: [] },
    ...over,
  })

describe('capture', () => {
  it('writes an expirable plan-scoped episodic note keyed by step id', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({ outcome: SignalOutcome.success, summary: 'x'.repeat(600) })
    const note = f.writes[0]
    expect(note?.id).toBe(slugId('step implement'))
    expect(note?.scope).toBe(planScope('task-1'))
    expect(note?.tier).toBe(NOTE_TIER.episodic)
    expect(note?.tags).toEqual(['ambient'])
    expect(note?.summary).toHaveLength(500)
  })

  // partial is an interim round, not a settled outcome (rounds share a runToken, so the ambient
  // idempotency key would collide across rounds and an interim summary would swallow the final
  // one) — the durable note is written only by the terminal signal.
  it('a partial signal writes no ambient note', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({ outcome: SignalOutcome.partial, summary: 'healed 14/26 — remaining ids in worklist' })
    expect(f.writes).toEqual([])
  })

  it('a failure gets its OWN id so a later success cannot overwrite the lesson', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({ outcome: SignalOutcome.failure, summary: 'the API returned 500' })
    expect(f.writes[0]?.id).toBe(slugId('failed step implement'))
    expect(f.writes[0]?.id).not.toBe(slugId('step implement'))
    expect(f.writes[0]?.tags).toEqual(['ambient', 'failure'])
  })

  // Without these the graph gained a node per step and no edges at all.
  it('links depends_on to the ambient notes of the steps this one consumed', async () => {
    const f = fakeStore()
    const b = bindStepMemory({
      store: f.store, author: AUTHOR, taskId: 'task-1',
      step: { id: 'implement', title: 'Implement', dependsOn: ['analyze', 'design'] },
    })
    await b.memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
    expect(f.writes[0]?.links).toEqual([
      { id: slugId('step analyze'), kind: LINK_KIND.depends_on },
      { id: slugId('step design'), kind: LINK_KIND.depends_on },
    ])
  })

  it('links derived_from every durable note the step read', async () => {
    const f = fakeStore({ notes: { 'first-read': semanticNoteFixture({ id: 'first-read' }), 'from-read': semanticNoteFixture({ id: 'from-read' }) } })
    const b = bind(f)
    const read = b.tools.find(t => t.name === 'memory_read')
    await read?.execute({ id: 'first-read' }, 'call-1')
    await read?.execute({ id: 'from-read' }, 'call-2')
    await b.memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
    expect(f.writes[0]?.links).toEqual([
      { id: 'first-read', kind: LINK_KIND.derived_from },
      { id: 'from-read', kind: LINK_KIND.derived_from },
    ])
  })

  // recordAccess fires on a HIT only, and names the seed the agent traversed from — so a step that
  // navigated the graph pulled that note just as deliberately as one that read it.
  it('a traversal seed counts as provenance, like a read', async () => {
    const f = fakeStore({ notes: { 'area-memory': semanticNoteFixture({ id: 'area-memory' }) } })
    // set before binding: the tracking decorator spreads the store, so later reassignment is unseen
    f.store.neighbors = async () => [{ id: 'x', title: 'x', summary: '', via: LINK_KIND.refines, depth: 1, score: 1, direction: EDGE_DIRECTION.out, activation: 0, from: 'area-memory', workspaceId: TEST_WORKSPACE_ID }]
    const b = bind(f)
    await b.tools.find(t => t.name === 'memory_neighbors')?.execute({ seed: 'area-memory' }, 'c1')
    await b.memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
    expect(f.writes[0]?.links).toEqual([{ id: 'area-memory', kind: LINK_KIND.derived_from }])
  })

  it('a plan-scope read is this run\'s own scaffolding, not durable provenance', async () => {
    const f = fakeStore({ notes: { local: semanticNoteFixture({ id: 'local' }) } })
    const b = bind(f)
    const read = b.tools.find(t => t.name === 'memory_read')
    await read?.execute({ id: 'local', scope: planScope('task-1') }, 'call-1')
    await b.memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
    expect(f.writes[0]?.links).toEqual([])
  })

  it('ambientCapture false writes nothing', async () => {
    const f = fakeStore()
    await bind(f, { ambientCapture: false }).memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
    expect(f.writes).toEqual([])
  })

  it('a throwing store never turns an already-signalled step into a failure', async () => {
    const f = fakeStore()
    f.store.write = async () => { throw new Error('surreal down') }
    await bind(f).memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
  })
})

// The semantic arm scores across the WHOLE note table, so plan notes from OTHER tasks compete for
// the same top-N slots as durable project knowledge. Scoping the query is what stops one busy
// project's decompositions from crowding out the knowledge a step reads.
describe('lane scoping', () => {
  // A split child executes a decomposition its PARENT authored, so the lanes run through every ancestor.
  it('the step\'s memory_search tool is confined to its own, its ancestors\' and the project lane', async () => {
    const filters: unknown[] = []
    const f = fakeStore()
    f.store.search = async (_q, filter) => { filters.push(filter?.scope); return [] }
    const b = bind(f, { ancestorTaskIds: ['task-parent'] })
    await b.tools.find(t => t.name === 'memory_search')?.execute({ query: 'anything' }, 'c1')
    expect(filters).toEqual([[planScope('task-1'), planScope('task-parent'), MemoryScope.project]])
  })
})

// The step's author travels WHOLE. The binding is handed a complete MemoryAuthor by the
// composition root (runtime.ts stepTools, whose workspaceId comes off the running TaskNode), and it
// must not rebuild, default or narrow it on the way to the store: a workspace can only be known at
// write time, so a note filed under the wrong one is wrong forever.
describe('the author a step writes as', () => {
  it('reaches every write unchanged — the model\'s own memory_write and the ambient capture alike', async () => {
    const f = fakeStore()
    const b = bind(f)
    await b.tools.find(t => t.name === 'memory_write')?.execute({ id: 'from-the-model', title: 'From the model' }, 'w1')
    await b.memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
    expect(f.writeAuthors.length).toBe(2) // the tool call and the ambient note
    for (const a of f.writeAuthors) expect(a).toEqual(AUTHOR)
  })
})

// Two ways a step's derived_from edges got polluted, both observed on a real run.
describe('provenance hygiene', () => {
  it('does not cite a note the step itself authored', async () => {
    const f = fakeStore({ notes: { 'my-own-note': semanticNoteFixture({ id: 'my-own-note' }) } })
    const b = bind(f)
    await b.tools.find(t => t.name === 'memory_write')?.execute({ id: 'my-own-note', title: 'Mine' }, 'w1')
    await b.tools.find(t => t.name === 'memory_read')?.execute({ id: 'my-own-note' }, 'r1')
    await b.memory.capture({ outcome: SignalOutcome.success, summary: 'done' })
    expect(f.writes.at(-1)?.links).toEqual([])
  })
})
