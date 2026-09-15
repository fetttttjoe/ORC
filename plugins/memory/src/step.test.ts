import { describe, expect, it } from 'bun:test'
import {
  LINK_KIND, MEMORY_ACCESS, MEMORY_USE, MemoryScope, NOTE_TIER, SIGNAL_OUTCOME, planScope, slugId,
  type ClaimHit, type MemoryAuthor, type MemoryNote, type MemoryNoteDraft, type MemoryStore, type NoteSummary,
} from '@orc/contracts'
import { bindStepMemory, deriveQueryTerms, preloadQuery } from './step'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'

const AUTHOR: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 'task-1', stepId: 'implement', runToken: 'rt-1' }

const summary = (over: Partial<NoteSummary> = {}): NoteSummary => ({
  id: 'area-memory', scope: MemoryScope.project, title: 'Memory area',
  tier: NOTE_TIER.semantic, categories: [], tags: [], summary: 'How memory works.',
  hits: 0, lastAccessedAt: null, sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID, ...over,
})

interface Recorded { id: string; scope: string | undefined; mode: string }

// A store double that records what was asked of it. `search` answers per query so the fallback
// ladder is observable; everything else is the minimum the binding touches.
function fakeStore(opts: {
  search?: (query: string) => NoteSummary[]
  searchClaims?: (query: string) => ClaimHit[]
  notes?: Record<string, MemoryNote>
} = {}) {
  const accesses: Recorded[] = []
  const writes: MemoryNoteDraft[] = []
  // Who each write claimed to be. MemoryAuthor.workspaceId is captured at write time and never
  // recoverable afterwards, so "the binding wrote as the author it was handed" needs the author,
  // not just the draft.
  const writeAuthors: MemoryAuthor[] = []
  const queries: string[] = []
  const claimQueries: string[] = []
  const outcomes: { entries: ReadonlyArray<{ id: string; outcome: string }>; base?: string }[] = []
  const store: MemoryStore = {
    search: async query => { queries.push(query); return opts.search?.(query) ?? [] },
    searchClaims: async query => { claimQueries.push(query); return opts.searchClaims?.(query) ?? [] },
    claimsFor: async () => [],
    setArchived: async () => {}, setArchivedAll: async () => {},
    topics: async () => [],
    topicClaims: async () => [],
    recordAccess: async (id, scope, mode) => { accesses.push({ id, scope, mode }) },
    write: async (note, author) => { writes.push(note); writeAuthors.push(author); return note as unknown as MemoryNote },
    get: async id => opts.notes?.[id] ?? null,
    useStats: async () => null,
    recordOutcomes: async (entries, _author, o) => { outcomes.push({ entries, ...(o?.idempotencyKeyBase && { base: o.idempotencyKeyBase }) }) },
    list: async () => [],
    neighbors: async () => [],
    remove: async () => {},
    verify: async () => ({ revision: 'headrev', at: '2026-07-30T00:00:00.000Z', by: 'cli' }),
  }
  return { store, accesses, writes, writeAuthors, queries, claimQueries, outcomes }
}

const bind = (f: ReturnType<typeof fakeStore>, over: Partial<Parameters<typeof bindStepMemory>[0]> = {}) =>
  bindStepMemory({
    store: f.store, author: AUTHOR, taskId: 'task-1',
    step: { id: 'implement', title: 'Refactor authentication middleware', instructions: 'do the thing', dependsOn: [] },
    ...over,
  })

describe('preloadQuery / deriveQueryTerms', () => {
  it('the intent query is title + instructions, bounded', () => {
    expect(preloadQuery({ title: 'A', instructions: 'B' })).toBe('A\nB')
    expect(preloadQuery({ title: 'x'.repeat(400), instructions: 'y'.repeat(400) })).toHaveLength(600)
  })

  it('keyword fallback keeps at most three distinctive words', () => {
    expect(deriveQueryTerms('Refactor the authentication middleware handling')).toEqual(['refactor', 'authentication', 'middleware'])
    expect(deriveQueryTerms('this step task')).toEqual([]) // all stopwords or too short
  })
})

describe('recall', () => {
  it('queries the full intent first and stops once it has hits', async () => {
    const f = fakeStore({ search: () => [summary()] })
    const { notes } = await bind(f).memory.recall(500)
    expect(notes.map(n => n.id)).toEqual(['area-memory'])
    // one query string, asked of BOTH arms — the claim arm and the note arm see the same intent
    expect(f.queries).toEqual(['Refactor authentication middleware\ndo the thing'])
    // the claim arm is asked the SAME intent, not a separate one
    expect(f.claimQueries).toEqual(f.queries)
  })

  it('falls back to distinctive title terms, then to the single longest, when each comes up empty', async () => {
    const f = fakeStore({ search: q => (q === 'authentication' ? [summary()] : []) })
    const { notes } = await bind(f).memory.recall(500)
    expect(notes.map(n => n.id)).toEqual(['area-memory'])
    expect(f.queries).toEqual([
      'Refactor authentication middleware\ndo the thing',
      'refactor authentication middleware',
      'authentication',
    ])
  })

  // memory_search records nothing by design, so without this the retrieval path that runs on EVERY
  // step earned no activation and left no provenance for consolidation.
  it('records a preload access for every note it surfaced', async () => {
    const f = fakeStore({ search: () => [summary(), summary({ id: 'area-kernel' })] })
    await bind(f).memory.recall(500)
    expect(f.accesses).toEqual([
      { id: 'area-memory', scope: MemoryScope.project, mode: MEMORY_ACCESS.preload },
      { id: 'area-kernel', scope: MemoryScope.project, mode: MEMORY_ACCESS.preload },
    ])
  })

  it('a zero budget searches nothing', async () => {
    const f = fakeStore({ search: () => [summary()] })
    expect(await bind(f).memory.recall(0)).toEqual({ claims: [], notes: [] })
    expect(f.queries).toEqual([])
    expect(f.claimQueries).toEqual([])
  })

  it('recalls claims alongside notes, and records ONE access per owning note', async () => {
    const hit = (claimId: string, noteId: string) =>
      ({ claimId, noteId, scope: 'project', title: noteId, text: `statement ${claimId}`, validFrom: '2026-07-26T00:00:00.000Z', sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID })
    // two claims on ONE note plus a note-arm hit for the same note: the activation signal counts
    // notes, so a preload must not charge that note three times
    const f = fakeStore({ searchClaims: () => [hit('c1', 'area-memory'), hit('c2', 'area-memory')], search: () => [summary()] })
    const { claims, notes } = await bind(f).memory.recall(500)
    expect(claims.map(c => c.claimId)).toEqual(['c1', 'c2'])
    expect(notes.map(n => n.id)).toEqual(['area-memory'])
    expect(f.accesses.filter(a => a.mode === MEMORY_ACCESS.preload)).toHaveLength(1)
  })

  it('claimsCiting keeps one row per NOTE asserting a shared statement', async () => {
    // A claim id hashes the claim's text, so two notes stating the same sentence about the same
    // file share it. Deduping on that id alone surfaced one note and silently withheld the other —
    // the retirement nudge then named half the notes the edit had falsified.
    const same = 'cluster.ts owns the pure algorithm'
    const shared = (noteId: string): ClaimHit =>
      ({ claimId: 'dup12', noteId, scope: 'project', title: noteId, text: same, validFrom: '2026-07-26T00:00:00.000Z', sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID })
    const f = fakeStore({ searchClaims: () => [shared('area-memory'), shared('area-cluster')] })
    const at = await bind(f).memory.claimsCiting(['plugins/memory/src/cluster.ts'])
    expect(at.map(h => h.noteId).sort()).toEqual(['area-cluster', 'area-memory'])
  })

  it('claims alone are enough — the fallback chain stops without any note hit', async () => {
    const f = fakeStore({
      searchClaims: () => [{ claimId: 'c1', noteId: 'n', scope: 'project', title: 'N', text: 'a statement', validFrom: '2026-07-26T00:00:00.000Z', sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID }],
      search: () => [],
    })
    const { claims, notes } = await bind(f).memory.recall(500)
    expect(claims).toHaveLength(1)
    expect(notes).toEqual([])
    expect(f.claimQueries).toHaveLength(1) // stopped at the first candidate, did not degrade further
  })

  it('a throwing store degrades to no notes rather than failing the step', async () => {
    const f = fakeStore()
    f.store.search = async () => { throw new Error('surreal down') }
    expect(await bind(f).memory.recall(500)).toEqual({ claims: [], notes: [] })
  })

  // A HANGING store is not a throwing store: the catch above never fires on a promise that stays
  // pending, and a dead SurrealDB socket pends forever (measured: connect() still pending after
  // 400s; live 2026-08-04, a step recovered mid-boot wedged in recall with zero events for 10+
  // minutes). The degrade contract must hold against hangs too — bounded, then no notes.
  it('a hanging store degrades to no notes instead of wedging the step forever', async () => {
    const f = fakeStore()
    f.store.searchClaims = () => new Promise(() => {}) // pending forever
    const b = bindStepMemory({
      store: f.store, author: AUTHOR, taskId: 'task-1',
      step: { id: 'implement', title: 'Refactor authentication middleware', instructions: 'do the thing', dependsOn: [] },
      recallTimeoutMs: 50,
    })
    expect(await b.memory.recall(500)).toEqual({ claims: [], notes: [] })
  })

  it('claimsCiting is bounded the same way — a hang folds to nothing-at-risk', async () => {
    const f = fakeStore()
    f.store.searchClaims = () => new Promise(() => {})
    const b = bindStepMemory({
      store: f.store, author: AUTHOR, taskId: 'task-1',
      step: { id: 'implement', title: 'Refactor authentication middleware', instructions: 'do the thing', dependsOn: [] },
      recallTimeoutMs: 50,
    })
    expect(await b.memory.claimsCiting(['plugins/memory/src/cluster.ts'])).toEqual([])
  })
})

describe('capture', () => {
  it('writes an expirable plan-scoped episodic note keyed by step id', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({ outcome: 'success', summary: 'x'.repeat(600) })
    const note = f.writes[0]
    expect(note?.id).toBe(slugId('step implement'))
    expect(note?.scope).toBe(planScope('task-1'))
    expect(note?.tier).toBe(NOTE_TIER.episodic)
    expect(note?.tags).toEqual(['ambient'])
    expect(note?.summary).toHaveLength(500)
  })

  // The signal's knowledge report becomes memory_outcome events through the store — the one seam,
  // no extra tool calls. Deduped per side (an agent restating an id must not double-count), keyed
  // on the run so an at-least-once retry cannot either.
  it('records the signal knowledge as outcome events, deduped and keyed on the run', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({
      outcome: 'success', summary: 'done',
      knowledge: { useful: ['area-auth', 'area-auth', 'area-net'], deadEnd: ['old-map'] },
    })
    expect(f.outcomes).toEqual([{
      entries: [
        { id: 'area-auth', outcome: MEMORY_USE.useful },
        { id: 'area-net', outcome: MEMORY_USE.useful },
        { id: 'old-map', outcome: MEMORY_USE.dead_end },
      ],
      base: 'rt-1:knowledge',
    }])
  })

  it('knowledge records survive ambientCapture: false — evidence is a different concern than step notes', async () => {
    const f = fakeStore()
    await bind(f, { ambientCapture: false }).memory.capture({
      outcome: 'success', summary: 'done', knowledge: { useful: ['area-auth'], deadEnd: [] },
    })
    expect(f.outcomes).toHaveLength(1)
    expect(f.writes).toHaveLength(0) // the knob still silences the ambient note itself
  })

  // A partial round's knowledge is evidence like any other (per-id idempotency keys make a later
  // round's repeat of the same id a dedupe, not a double-count) — but its ambient note is SKIPPED:
  // rounds share a runToken, so the ambient idempotency key collides and the interim summary would
  // swallow the final one. The final signal writes the durable note.
  it('a partial signal records knowledge but writes no ambient note', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({
      outcome: SIGNAL_OUTCOME.partial, summary: 'healed 14/26 — remaining ids in worklist',
      knowledge: { useful: ['area-auth'], deadEnd: [] },
    })
    expect(f.outcomes).toHaveLength(1)
    expect(f.writes).toHaveLength(0)
  })

  it('a signal with no knowledge records nothing — absence costs nothing', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.outcomes).toEqual([])
  })

  it('a failure gets its OWN id so a later success cannot overwrite the lesson', async () => {
    const f = fakeStore()
    await bind(f).memory.capture({ outcome: 'failure', summary: 'the API returned 500' })
    expect(f.writes[0]?.id).toBe(slugId('failed step implement'))
    expect(f.writes[0]?.id).not.toBe(slugId('step implement'))
    expect(f.writes[0]?.tags).toEqual(['ambient', 'failure'])
  })

  // Without these the graph gained a node per step and no edges at all.
  it('links depends_on to the ambient notes of the steps this one consumed', async () => {
    const f = fakeStore()
    const b = bindStepMemory({
      store: f.store, author: AUTHOR, taskId: 'task-1',
      step: { id: 'implement', title: 'Implement', instructions: 'do', dependsOn: ['analyze', 'design'] },
    })
    await b.memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.writes[0]?.links).toEqual([
      { id: slugId('step analyze'), kind: LINK_KIND.depends_on },
      { id: slugId('step design'), kind: LINK_KIND.depends_on },
    ])
  })

  it('links derived_from every durable note the step pulled — preload and tool reads alike', async () => {
    const f = fakeStore({ search: () => [summary({ id: 'from-preload' })], notes: { 'from-read': {} as MemoryNote } })
    const b = bind(f)
    await b.memory.recall(500)
    const read = b.tools.find(t => t.name === 'memory_read')
    await read?.execute({ id: 'from-read' }, 'call-1')
    await b.memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.writes[0]?.links).toEqual([
      { id: 'from-preload', kind: LINK_KIND.derived_from },
      { id: 'from-read', kind: LINK_KIND.derived_from },
    ])
  })

  // recordAccess fires on a HIT only, and names the seed the agent traversed from — so a step that
  // navigated the graph pulled that note just as deliberately as one that read it.
  it('a traversal seed counts as provenance, like a read', async () => {
    const f = fakeStore({ notes: { 'area-memory': {} as MemoryNote } })
    // set before binding: the tracking decorator spreads the store, so later reassignment is unseen
    f.store.neighbors = async () => [{ id: 'x', title: 'x', summary: '', via: LINK_KIND.refines, depth: 1, score: 1, direction: 'out', activation: 0, from: 'area-memory', workspaceId: TEST_WORKSPACE_ID }]
    const b = bind(f)
    await b.tools.find(t => t.name === 'memory_neighbors')?.execute({ seed: 'area-memory' }, 'c1')
    await b.memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.writes[0]?.links).toEqual([{ id: 'area-memory', kind: LINK_KIND.derived_from }])
  })

  it('a plan-scope read is this run\'s own scaffolding, not durable provenance', async () => {
    const f = fakeStore({ notes: { local: {} as MemoryNote } })
    const b = bind(f)
    const read = b.tools.find(t => t.name === 'memory_read')
    await read?.execute({ id: 'local', scope: planScope('task-1') }, 'call-1')
    await b.memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.writes[0]?.links).toEqual([])
  })

  it('ambientCapture false writes nothing', async () => {
    const f = fakeStore()
    await bind(f, { ambientCapture: false }).memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.writes).toEqual([])
  })

  it('a throwing store never turns an already-signalled step into a failure', async () => {
    const f = fakeStore()
    f.store.write = async () => { throw new Error('surreal down') }
    await bind(f).memory.capture({ outcome: 'success', summary: 'done' })
  })
})

// The semantic arm scores across the WHOLE note table, so plan notes from OTHER tasks compete for
// the same top-N slots as durable project knowledge. Scoping the query is what stops one busy
// project's decompositions from crowding out the knowledge every step is supposed to be handed.
describe('lane scoping', () => {
  it('recall sees this task\'s plan scope and the durable project lane', async () => {
    const filters: unknown[] = []
    const f = fakeStore()
    f.store.search = async (_q, filter) => { filters.push(filter?.scope); return [summary()] }
    await bind(f).memory.recall(500)
    expect(filters).toEqual([[planScope('task-1'), MemoryScope.project]])
  })

  // A split child executes a decomposition its PARENT authored, and `plan-<child>` is a different
  // scope from `plan-<parent>` — without the ancestor lanes the child cannot see its own subplan.
  it('recall also sees every ANCESTOR plan scope, nearest first', async () => {
    const filters: unknown[] = []
    const f = fakeStore()
    f.store.search = async (_q, filter) => { filters.push(filter?.scope); return [summary()] }
    await bind(f, { ancestorTaskIds: ['task-parent', 'task-root'] }).memory.recall(500)
    expect(filters).toEqual([[
      planScope('task-1'), planScope('task-parent'), planScope('task-root'), MemoryScope.project,
    ]])
  })

  // The model's OWN search had no scope at all, so it was still exposed to the starvation recall
  // was just fixed for. One rule, both retrieval paths.
  it('the step\'s memory_search tool is confined to the same lanes', async () => {
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
    await b.memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.writeAuthors.length).toBe(2) // the tool call and the ambient note
    for (const a of f.writeAuthors) expect(a).toEqual(AUTHOR)
  })
})

// Two ways a step's derived_from edges got polluted, both observed on a real run.
describe('provenance hygiene', () => {
  it('does not cite a note the step itself authored', async () => {
    const f = fakeStore({ notes: { 'my-own-note': {} as MemoryNote } })
    const b = bind(f)
    await b.tools.find(t => t.name === 'memory_write')?.execute({ id: 'my-own-note', title: 'Mine' }, 'w1')
    await b.tools.find(t => t.name === 'memory_read')?.execute({ id: 'my-own-note' }, 'r1')
    await b.memory.capture({ outcome: 'success', summary: 'done' })
    expect(f.writes.at(-1)?.links).toEqual([])
  })
})

// Preload is a HINT, not a request: the knowledge protocol tells the agent to search for whatever
// the block lacks. A real run surfaced every note in the project because the token budget was the
// only limiter — which stops being harmless once the corpus is large.
// Currency is the SAME verdict memory_read flags per note and `orc status` reports per corpus —
// deliberately not a second, cheaper comparison. `sourceRevision === HEAD` was tried here and is
// strictly worse: any commit anywhere invalidates every note at once, so the preload would tell
// every step to re-derive everything, which is exactly the cost the preload exists to avoid.
describe('recall reports currency through the shared drift verdict', () => {
  const dated = (id: string, path: string) => summary({ id, sourceRevision: 'rev-a', paths: [path] })

  it('counts a note as drifted when the code it declares has moved', async () => {
    const f = fakeStore({ search: () => [dated('n1', 'src/auth.ts'), dated('n2', 'src/untouched.ts')] })
    const changedSince = async () => new Set(['src/auth.ts'])
    const got = await bind(f, { changedSince }).memory.recall(5000)
    expect(got.currency).toMatchObject({ checkable: 2, drifted: 1 })
  })

  // A note with no declared paths cannot be dated at all, so it must not be counted as current —
  // "nothing checkable" has to stay distinguishable from "checked and clean".
  // The either-clean rule reaches the preload, or it reaches nothing a step actually sees: this is
  // the verdict the block prints, and a note an auditor confirmed AFTER the code moved is current.
  it('does not count a note whose verification is newer than the change', async () => {
    const stamp = { revision: 'rev-b', at: '2026-07-30T00:00:00.000Z', by: 'cli' }
    const f = fakeStore({ search: () => [summary({ id: 'n1', sourceRevision: 'rev-a', paths: ['src/auth.ts'], verified: stamp })] })
    const changedSince = async (rev: string) => new Set(rev === 'rev-a' ? ['src/auth.ts'] : [])
    const got = await bind(f, { changedSince }).memory.recall(5000)
    expect(got.currency).toMatchObject({ checkable: 1, drifted: 0 })
  })

  it('omits currency entirely when nothing could be checked', async () => {
    const f = fakeStore({ search: () => [summary({ id: 'n1', sourceRevision: 'rev-a', paths: [] })] })
    const got = await bind(f, { changedSince: async () => new Set(['src/auth.ts']) }).memory.recall(5000)
    expect(got.currency).toBeUndefined()
  })

  // An unreachable revision is UNKNOWN, not silently dropped: it must surface currency (not fold
  // into the same undefined a genuinely-uncheckable preload produces) and must be counted apart
  // from checkable/drifted, not inside either.
  it('surfaces currency and reports an unreachable revision under unknown, alongside checkable notes', async () => {
    const f = fakeStore({ search: () => [
      dated('n1', 'src/auth.ts'), // checkable, clean
      summary({ id: 'n2', sourceRevision: 'rev-unreachable', paths: ['src/gone.ts'] }), // unreachable
    ] })
    const changedSince = async (rev: string) => (rev === 'rev-unreachable' ? null : new Set<string>())
    const got = await bind(f, { changedSince }).memory.recall(5000)
    expect(got.currency).toBeDefined()
    expect(got.currency).toMatchObject({ checkable: 1, drifted: 0, unknown: 1 })
  })

  // The behavioural flip: when EVERY declared-path note's revision is unreachable (checkable 0,
  // unknown > 0), currency must now be DEFINED — distinct from the 'omits currency entirely' case
  // above, whose note declares no paths at all and is genuinely uncheckable.
  it('surfaces currency when every note has an unreachable revision (checkable 0, unknown > 0)', async () => {
    const f = fakeStore({ search: () => [summary({ id: 'n1', sourceRevision: 'rev-unreachable', paths: ['src/gone.ts'] })] })
    const changedSince = async () => null
    const got = await bind(f, { changedSince }).memory.recall(5000)
    expect(got.currency).toBeDefined()
    expect(got.currency).toMatchObject({ checkable: 0, drifted: 0, unknown: 1 })
  })

  it('omits currency when there is no drift probe at all', async () => {
    const f = fakeStore({ search: () => [dated('n1', 'src/auth.ts')] })
    expect((await bind(f).memory.recall(5000)).currency).toBeUndefined()
  })

  // The probe shells out to git; a step must never fail because a repo could not be read.
  it('omits currency rather than failing the recall when the probe throws', async () => {
    const f = fakeStore({ search: () => [dated('n1', 'src/auth.ts')] })
    const changedSince = async () => { throw new Error('not a repo') }
    const got = await bind(f, { changedSince }).memory.recall(5000)
    expect(got.currency).toBeUndefined()
    expect(got.notes).toHaveLength(1) // the knowledge still arrives
  })
})

// Claims take the budget FIRST, so at the default budget a preload is typically several claims and
// one note. Currency computed from the notes arm alone put most of what the step was handed under a
// verdict that never examined it.
describe('currency covers the claims arm too', () => {
  const claimHit = (noteId: string, path: string) => ({
    claimId: `c-${noteId}`, noteId, scope: 'project', title: 'T', text: 'a statement',
    validFrom: '2026-07-26T00:00:00.000Z', sourceRevision: 'rev-a', paths: [path], workspaceId: TEST_WORKSPACE_ID,
  })

  it('counts a drifted claim owner even when the notes arm is empty', async () => {
    const f = fakeStore({ search: () => [], searchClaims: () => [claimHit('n1', 'src/auth.ts')] })
    const got = await bind(f, { changedSince: async () => new Set(['src/auth.ts']) }).memory.recall(5000)
    expect(got.currency).toMatchObject({ checkable: 1, drifted: 1 })
  })

  // A claim's checkable unit IS its owning note, so several claims from one note must count once —
  // otherwise a single drifted note drowns out every clean note in the ratio.
  it('dedupes by owning note, so five claims from one note count once', async () => {
    const hits = Array.from({ length: 5 }, (_, i) => ({ ...claimHit('n1', 'src/auth.ts'), claimId: `c${i}` }))
    const f = fakeStore({ search: () => [summary({ id: 'n2', sourceRevision: 'rev-a', paths: ['src/clean.ts'] })], searchClaims: () => hits })
    const got = await bind(f, { changedSince: async () => new Set(['src/auth.ts']) }).memory.recall(5000)
    expect(got.currency).toMatchObject({ checkable: 2, drifted: 1 })
  })
})

describe('recall is a bounded hint', () => {
  it('keeps only the best-ranked few, however many the store returns', async () => {
    const many = Array.from({ length: 30 }, (_, i) => summary({ id: `note-${i}` }))
    const f = fakeStore({ search: () => many })
    const { notes } = await bind(f).memory.recall(100_000) // budget far too large to bind
    expect(notes.map(n => n.id)).toEqual(['note-0', 'note-1', 'note-2', 'note-3', 'note-4'])
  })
})
