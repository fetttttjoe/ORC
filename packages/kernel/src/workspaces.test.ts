import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, TASK_STATUS, WORKSPACE_KIND, WORKSPACE_STATE, type EventRecord, type TaskNode, type TaskStatus, type Workspace, type WorkspaceHealth } from '@orc/contracts'
import { fold, type State } from './projections'
import { applyArchived, applyRetitle, compareWorkspaceHealth, orphanTasks, tasksByWorkspace, workspaceByCwd, workspaceCwdFor, workspaceHealth, type WorkspaceProbes } from './workspaces'

// Workspace.id is z.uuid(), so the fold's parse SKIPS a record whose id is a short label — every
// assertion here would then read an empty map and pass for the wrong reason. Labels map to fixed
// uuids so the assertions stay readable and the fold actually sees the records.
const ID = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  old: '33333333-3333-4333-8333-333333333333',
  ghost: '44444444-4444-4444-8444-444444444444', // never created — the orphan case
} as const

const ws = (id: string, cwd: string, extra: Partial<Workspace> = {}): Workspace => ({
  id, title: id, cwd, branch: 'main', baseBranch: null, kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: true,
  createdAt: '2026-09-14T00:00:00.000Z', archivedAt: null, ...extra,
})
let seq = 0
const ev = (kind: EventRecord['kind'], payload: Record<string, unknown>, taskId: string | null = null, ts = '2026-09-14T00:00:00.000Z'): EventRecord =>
  ({ seq: ++seq, projectId: 'p', idempotencyKey: null, taskId, stepId: null, runToken: null, kind, payload, usage: null, ts })

describe('workspace fold', () => {
  it('created → retitled → archived → restored', () => {
    const a = ws(ID.a, '/repo')
    const s = fold([
      ev(EVENT_KIND.workspace_created, { workspace: a }),
      ev(EVENT_KIND.workspace_retitled, { workspaceId: ID.a, title: 'Renamed' }),
      ev(EVENT_KIND.workspace_archived, { workspaceId: ID.a, archived: true, at: '2026-09-14T01:00:00.000Z' }),
    ])
    expect(s.workspaces.get(ID.a)).toMatchObject({ title: 'Renamed', archivedAt: '2026-09-14T01:00:00.000Z' })
    const restored = fold([
      ev(EVENT_KIND.workspace_created, { workspace: a }),
      ev(EVENT_KIND.workspace_archived, { workspaceId: ID.a, archived: false, at: 'y' }),
    ])
    expect(restored.workspaces.get(ID.a)?.archivedAt).toBeNull()
  })
  it('a malformed payload is skipped, never thrown (one poison event must not wedge the fold)', () => {
    expect(fold([ev(EVENT_KIND.workspace_created, { workspace: { id: 'bad' } })]).workspaces.size).toBe(0)
  })
  it('a retitle/archive naming an unknown workspace is a no-op, and a malformed one is skipped', () => {
    const s = fold([
      ev(EVENT_KIND.workspace_created, { workspace: ws(ID.a, '/repo') }),
      ev(EVENT_KIND.workspace_retitled, { workspaceId: ID.b, title: 'Ghost' }),          // never created
      ev(EVENT_KIND.workspace_archived, { workspaceId: ID.b, archived: true, at: 'z' }), // never created
      ev(EVENT_KIND.workspace_retitled, { workspaceId: ID.a }),                          // no title
      ev(EVENT_KIND.workspace_archived, { workspaceId: ID.a, at: 'z' }),                 // no `archived` flag
    ])
    expect(s.workspaces.size).toBe(1) // an unknown id never MINTS a record — only workspace_created does
    expect(s.workspaces.get(ID.a)).toMatchObject({ title: ID.a, archivedAt: null })
  })
  it('workspace_merged folds into its own map; a malformed merge is skipped too', () => {
    const s = fold([
      ev(EVENT_KIND.workspace_created, { workspace: ws(ID.a, '/repo') }),
      ev(EVENT_KIND.workspace_merged, { workspaceId: ID.a, mergeCommit: 'abc123', trunk: 'main', at: '2026-09-14T02:00:00.000Z' }),
      ev(EVENT_KIND.workspace_merged, { workspaceId: ID.b, trunk: 'main' }), // no mergeCommit
    ])
    expect(s.workspaceMerges.get(ID.a)).toMatchObject({ mergeCommit: 'abc123', trunk: 'main' })
    expect(s.workspaceMerges.has(ID.b)).toBe(false)
    // the merge is its own fact: it never touches the workspace record the derivations read
    expect(s.workspaces.get(ID.a)?.archivedAt).toBeNull()
  })
})

// The transitions the fold applies and the kernel returns are ONE function each — the pair below is
// what stops `retitleWorkspace`'s answer from drifting from what the next fold of the same log says.
describe('workspace transitions', () => {
  it('retitle and archive/restore leave the source record untouched', () => {
    const w = ws(ID.a, '/repo')
    expect(applyRetitle(w, 'Renamed')).toMatchObject({ id: ID.a, title: 'Renamed', cwd: '/repo' })
    expect(applyArchived(w, true, 'z').archivedAt).toBe('z')
    expect(applyArchived({ ...w, archivedAt: 'z' }, false, 'y').archivedAt).toBeNull() // restore ignores `at`
    expect(w).toMatchObject({ title: ID.a, archivedAt: null }) // pure: the input is never mutated
  })
})

const task = (id: string, workspaceId: string, status: TaskStatus = TASK_STATUS.draft): TaskNode =>
  ({ id, parentId: null, type: 'generic', title: id, spec: '', status, zone: [], budgetUSD: null, depth: 0, createdAt: 'x', workspaceId })

describe('derivations', () => {
  const state = fold([
    ev(EVENT_KIND.workspace_created, { workspace: ws(ID.a, '/repo') }),
    ev(EVENT_KIND.workspace_created, { workspace: ws(ID.b, '/repo/.orc/worktrees/x', { kind: WORKSPACE_KIND.worktree, managed: true }) }),
    ev(EVENT_KIND.workspace_created, { workspace: ws(ID.old, '/gone', { archivedAt: 'z' }) }),
    ev(EVENT_KIND.task_created, { task: task('t1', ID.a) }, 't1'),
    ev(EVENT_KIND.task_created, { task: task('t2', ID.b) }, 't2'),
    ev(EVENT_KIND.task_created, { task: task('t3', ID.ghost) }, 't3'),   // names a workspace the fold never saw
  ])
  it('workspaceByCwd matches an ACTIVE workspace by exact cwd only', () => {
    expect(workspaceByCwd(state.workspaces, '/repo')?.id).toBe(ID.a)
    expect(workspaceByCwd(state.workspaces, '/repo/packages')).toBeUndefined() // a subdir is not the workspace; callers pass the resolved dir
    expect(workspaceByCwd(state.workspaces, '/gone')).toBeUndefined()          // archived does not match — adoption may re-create
  })
  it('workspaceCwdFor reads the task\'s workspace; null only for an orphan', () => {
    expect(workspaceCwdFor(task('t2', ID.b), state.workspaces)).toBe('/repo/.orc/worktrees/x')
    expect(workspaceCwdFor(task('t3', ID.ghost), state.workspaces)).toBeNull()
  })
  it('tasksByWorkspace groups by creation order; an orphan is reported separately, never hidden', () => {
    const groups = tasksByWorkspace(state)
    expect(groups.map(g => g.workspace.id)).toEqual([ID.a, ID.b, ID.old])
    expect(groups.flatMap(g => g.tasks.map(t => t.id))).toEqual(['t1', 't2'])
    expect(orphanTasks(state).map(t => t.id)).toEqual(['t3'])
  })
})

// ── health ────────────────────────────────────────────────────────────────────────────────────
// A TABLE, one row per state, because the table IS the contract: the CLI, the MCP door and the
// console all render this one verdict, so a rung that stopped being reachable (shadowed by the rung
// above it) would otherwise pass every per-surface test while nothing ever printed that word again.
// Hand-built states rather than folded ones: reaching `running` / `awaiting_approval` through the
// fold would need a run's whole event chain, which tests the fold, not this rule.

const WS_A = ws(ID.a, '/repo')
const stateOf = (tasks: TaskNode[], merged = false): Pick<State, 'tasks' | 'workspaces' | 'workspaceMerges'> => ({
  tasks: new Map(tasks.map(t => [t.id, t])),
  workspaces: new Map([[ID.a, WS_A], [ID.b, ws(ID.b, '/other')]]),
  workspaceMerges: merged
    ? new Map([[ID.a, { workspaceId: ID.a, mergeCommit: 'abc123', trunk: 'main', at: '2026-09-14T02:00:00.000Z' }]])
    : new Map(),
})
const LIVE: WorkspaceProbes = { dirExists: true, clean: true }
const GONE: WorkspaceProbes = { dirExists: false, clean: null }
const askedT1 = ev(EVENT_KIND.feedback_requested, { topic: 'cwd', question: 'which cwd?' }, 't1')
const answeredT1 = ev(EVENT_KIND.feedback_provided, { topic: 'cwd', text: 'this one', author: { source: 'cli', workspaceId: ID.a } }, 't1')

const CASES: Array<{
  name: string
  state: Pick<State, 'tasks' | 'workspaces' | 'workspaceMerges'>
  events?: EventRecord[]
  notes?: ReadonlyMap<string, number> | null
  probes?: WorkspaceProbes
  expected: WorkspaceHealth['state']
  // The `merged` FLAG, asserted per row rather than derived from the row's own state: the flag and
  // the state are two different answers, and a row that only checked the state could not tell a
  // shadowed merge (`active` with merged: true) from one that never happened.
  merged?: true
}> = [
  {
    // running beats awaiting_approval: something IS moving in this checkout
    name: 'active — a task is running',
    state: stateOf([task('t1', ID.a, TASK_STATUS.running), task('t2', ID.a, TASK_STATUS.awaiting_approval)]),
    expected: WORKSPACE_STATE.active,
  },
  {
    // The precedence row the flag exists for. `merged` is a FACT about whether the work landed;
    // `state` is where the operator's attention goes — and every rung above `merged` shadows it, so
    // without the flag a landed workspace that is running again is indistinguishable from one that
    // never merged at all. "Has this work landed?" is the question the whole workspace transaction
    // exists to answer, and the state column cannot answer it.
    name: 'active — a merged workspace with a running task; the flag survives the rung that shadows it',
    state: stateOf([task('t1', ID.a, TASK_STATUS.running)], true),
    expected: WORKSPACE_STATE.active,
    merged: true,
  },
  {
    name: 'waiting — a task is awaiting_approval and none is running',
    state: stateOf([task('t1', ID.a, TASK_STATUS.awaiting_approval)]),
    expected: WORKSPACE_STATE.waiting,
  },
  {
    name: 'waiting — a feedback_requested with no answer on its topic',
    state: stateOf([task('t1', ID.a, TASK_STATUS.blocked)]),
    events: [askedT1],
    expected: WORKSPACE_STATE.waiting,
  },
  {
    // the same question ANSWERED is not a gate — without this row, "waiting" could be spelled
    // "has ever asked" and every workspace that ever ran a gated step would read as waiting forever
    name: 'idle — the question was answered on its topic',
    state: stateOf([task('t1', ID.a, TASK_STATUS.blocked)]),
    events: [askedT1, answeredT1],
    expected: WORKSPACE_STATE.idle,
  },
  {
    // merged beats dangling — its worktree is REMOVED by `ws merge`, so `!dirExists` is the normal
    // end state of a landed workspace, not a warning
    name: 'merged — the merge fact is recorded, even with the checkout gone',
    state: stateOf([task('t1', ID.a, TASK_STATUS.done)], true),
    probes: GONE,
    expected: WORKSPACE_STATE.merged,
    merged: true,
  },
  {
    name: 'dangling — unmerged and its checkout is gone',
    state: stateOf([task('t1', ID.a, TASK_STATUS.done)]),
    probes: GONE,
    expected: WORKSPACE_STATE.dangling,
  },
  {
    name: 'dangling — nothing open left, but knowledge is still pending in it',
    state: stateOf([task('t1', ID.a, TASK_STATUS.done)]),
    notes: new Map([[ID.a, 2]]),
    expected: WORKSPACE_STATE.dangling,
  },
  {
    // an OPEN task means the work is simply unfinished — provisional notes are expected there
    name: 'idle — pending knowledge but a task is still open',
    state: stateOf([task('t1', ID.a, TASK_STATUS.draft)]),
    notes: new Map([[ID.a, 2]]),
    expected: WORKSPACE_STATE.idle,
  },
  {
    // NEVER INVENT DANGLING FROM IGNORANCE: a null count is "the read model could not be asked",
    // and treating it as > 0 would send an operator to merge a workspace with nothing pending
    name: 'idle — an uncountable note corpus is not evidence of anything pending',
    state: stateOf([task('t1', ID.a, TASK_STATUS.done)]),
    notes: null,
    expected: WORKSPACE_STATE.idle,
  },
  {
    name: 'idle — a checkout on disk, nothing running, nothing pending',
    state: stateOf([task('t1', ID.a, TASK_STATUS.done)]),
    expected: WORKSPACE_STATE.idle,
  },
]

describe('workspaceHealth', () => {
  for (const c of CASES)
    it(c.name, () => {
      const h = workspaceHealth(c.state, c.events ?? [], c.notes === undefined ? new Map() : c.notes, WS_A, c.probes ?? LIVE)
      expect(h.state).toBe(c.expected)
      expect(h.merged).toBe(c.merged === true)
    })

  it('a question open on ANOTHER workspace\'s task never makes this one wait', () => {
    const state = stateOf([task('t1', ID.a, TASK_STATUS.done), task('t9', ID.b, TASK_STATUS.blocked)])
    const asked = ev(EVENT_KIND.feedback_requested, { topic: 'cwd', question: 'which cwd?' }, 't9')
    expect(workspaceHealth(state, [asked], new Map(), WS_A, LIVE).state).toBe(WORKSPACE_STATE.idle)
  })

  it('counts the workspace\'s tasks and carries the probes and the note count through', () => {
    const state = stateOf([task('t1', ID.a, TASK_STATUS.done), task('t2', ID.a, TASK_STATUS.draft), task('t9', ID.b)])
    expect(workspaceHealth(state, [], new Map([[ID.a, 3]]), WS_A, { dirExists: true, clean: false })).toMatchObject({
      taskCount: 2, openTaskCount: 1, provisionalNotes: 3, dirExists: true, clean: false,
    })
  })

  it('lastActivityAt is the max ts across the workspace\'s task events AND its own workspace events', () => {
    const state = stateOf([task('t1', ID.a, TASK_STATUS.done), task('t9', ID.b)])
    const events = [
      ev(EVENT_KIND.workspace_created, { workspace: WS_A }, null, '2026-09-10T00:00:00.000Z'),
      ev(EVENT_KIND.task_created, { task: task('t1', ID.a) }, 't1', '2026-09-11T00:00:00.000Z'),
      // this workspace's own retitle is LATER than anything its tasks did — a workspace with no
      // task activity at all must still date from something, or `ws ls` prints a blank age
      ev(EVENT_KIND.workspace_retitled, { workspaceId: ID.a, title: 'Renamed' }, null, '2026-09-12T00:00:00.000Z'),
      // another workspace's record and another workspace's task are both LATER and must not count
      ev(EVENT_KIND.workspace_retitled, { workspaceId: ID.b, title: 'Other' }, null, '2026-09-20T00:00:00.000Z'),
      ev(EVENT_KIND.task_created, { task: task('t9', ID.b) }, 't9', '2026-09-21T00:00:00.000Z'),
    ]
    expect(workspaceHealth(state, events, new Map(), WS_A, LIVE).lastActivityAt).toBe('2026-09-12T00:00:00.000Z')
  })

  it('lastActivityAt is null when the log shows nothing for this workspace — never a fabricated stamp', () => {
    expect(workspaceHealth(stateOf([]), [], new Map(), WS_A, LIVE).lastActivityAt).toBeNull()
  })
})

// The one ordering every door sorts by, so the terminal, the MCP door and the console agree about
// what the operator sees first. Attention first, finished business last.
describe('compareWorkspaceHealth', () => {
  const of = (state: WorkspaceHealth['state'], archivedAt: string | null = null) =>
    ({ workspace: ws(ID.a, '/repo', { archivedAt }), health: { state } })
  it('orders dangling → waiting → active → idle → merged, with archived records last', () => {
    const rows = [
      of(WORKSPACE_STATE.merged), of(WORKSPACE_STATE.idle), of(WORKSPACE_STATE.active),
      of(WORKSPACE_STATE.dangling, 'z'), of(WORKSPACE_STATE.waiting), of(WORKSPACE_STATE.dangling),
    ]
    expect([...rows].sort(compareWorkspaceHealth).map(r => `${r.health.state}${r.workspace.archivedAt ? ' [archived]' : ''}`))
      .toEqual(['dangling', 'waiting', 'active', 'idle', 'merged', 'dangling [archived]'])
  })
})
