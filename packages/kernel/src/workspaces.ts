import { EVENT_KIND, groupByWorkspace, openFeedbackTopics, PAYLOAD_SCHEMAS, TERMINAL_TASK_STATUS, TASK_STATUS, WORKSPACE_STATE } from '@orc/contracts'
import type { EventRecord, FeedbackEvent, TaskNode, Workspace, WorkspaceHealth, WorkspaceState } from '@orc/contracts'
import type { State } from './projections'

// pure over the fold: no db, git or clock, so every door shares one rule

// active only (an archived path is done); exact cwd, never a subdirectory
export function workspaceByCwd(workspaces: ReadonlyMap<string, Workspace>, cwd: string): Workspace | undefined {
  for (const w of workspaces.values()) if (w.archivedAt === null && w.cwd === cwd) return w
  return undefined
}

// null only for an orphan, a log defect: callers surface it, never paper over it
export function workspaceCwdFor(task: Pick<TaskNode, 'workspaceId'>, workspaces: ReadonlyMap<string, Workspace>): string | null {
  return workspaces.get(task.workspaceId)?.cwd ?? null
}

// a task naming an unknown workspace is reported by orphanTasks, not dropped into a group
export function tasksByWorkspace(state: Pick<State, 'tasks' | 'workspaces'>): Array<{ workspace: Workspace; tasks: TaskNode[] }> {
  return groupByWorkspace(state.workspaces.values(), state.tasks.values()).map(g => ({ workspace: g.workspace, tasks: g.items }))
}

// shown under a loud 'orphaned' heading: a silently dropped task is one the operator cannot find
export function orphanTasks(state: Pick<State, 'tasks' | 'workspaces'>): TaskNode[] {
  return [...state.tasks.values()].filter(t => !state.workspaces.has(t.workspaceId))
}

// ONE transition per workspace fact, shared by the fold and the appending kernel method

export function applyRetitle(w: Workspace, title: string): Workspace {
  return { ...w, title }
}

// restore is this call with the flag off; `at` is ignored: an active record has no archive time
export function applyArchived(w: Workspace, archived: boolean, at: string): Workspace {
  return { ...w, archivedAt: archived ? at : null }
}

// one verdict per workspace, shared by every door; the vocabulary lives in contracts

// the filesystem's answers, handed in to keep this pure; clean=null means git declined to answer
export interface WorkspaceProbes { dirExists: boolean; clean: boolean | null }

// read through PAYLOAD_SCHEMAS, so a malformed payload contributes nothing instead of throwing
function workspaceEventId(e: Pick<EventRecord, 'kind' | 'payload'>): string | null {
  switch (e.kind) {
    case EVENT_KIND.workspace_created: {
      const p = PAYLOAD_SCHEMAS.workspace_created.safeParse(e.payload)
      return p.success ? p.data.workspace.id : null
    }
    case EVENT_KIND.workspace_retitled: {
      const p = PAYLOAD_SCHEMAS.workspace_retitled.safeParse(e.payload)
      return p.success ? p.data.workspaceId : null
    }
    case EVENT_KIND.workspace_archived: {
      const p = PAYLOAD_SCHEMAS.workspace_archived.safeParse(e.payload)
      return p.success ? p.data.workspaceId : null
    }
    case EVENT_KIND.workspace_merged: {
      const p = PAYLOAD_SCHEMAS.workspace_merged.safeParse(e.payload)
      return p.success ? p.data.workspaceId : null
    }
    default:
      return null
  }
}

// the rule is feedback-open.ts's, applied to this workspace's tasks' events only
function hasOpenQuestion(events: ReadonlyArray<FeedbackEvent>, taskIds: ReadonlySet<string>): boolean {
  return openFeedbackTopics(events.filter(e => e.taskId !== null && taskIds.has(e.taskId))).size > 0
}

// the rungs are an if-else chain and their order IS the rule; events are in log order
export function workspaceHealth(
  state: Pick<State, 'tasks' | 'workspaces' | 'workspaceMerges'>,
  events: ReadonlyArray<Pick<EventRecord, 'taskId' | 'ts' | 'kind' | 'payload'>>,
  w: Workspace,
  probes: WorkspaceProbes,
): WorkspaceHealth {
  const tasks = [...state.tasks.values()].filter(t => t.workspaceId === w.id)
  const taskIds = new Set(tasks.map(t => t.id))
  const open = tasks.filter(t => !TERMINAL_TASK_STATUS.has(t.status))

  let lastActivityAt: string | null = null
  for (const e of events) {
    const mine = e.taskId !== null ? taskIds.has(e.taskId) : workspaceEventId(e) === w.id
    // ISO-8601 UTC, so the lexicographic max is the chronological one and never NaN
    if (mine && (lastActivityAt === null || e.ts > lastActivityAt)) lastActivityAt = e.ts
  }

  // the `merged` flag outlives the rung: a landed workspace whose task is running reads `active`
  const merged = state.workspaceMerges.has(w.id)
  const base = { lastActivityAt, taskCount: tasks.length, openTaskCount: open.length, merged, ...probes }
  // Something IS moving here — the one state that needs no further reading.
  if (tasks.some(t => t.status === TASK_STATUS.running)) return { state: WORKSPACE_STATE.active, ...base }
  // below `active` on purpose: do not send the operator to a gate in a busy checkout first
  if (tasks.some(t => t.status === TASK_STATUS.awaiting_approval) || hasOpenQuestion(events, taskIds))
    return { state: WORKSPACE_STATE.waiting, ...base }
  // above `dangling`: `ws merge` removes the worktree, so a landed workspace fails dirExists
  if (merged) return { state: WORKSPACE_STATE.merged, ...base }
  // Work that will never land unless someone acts: the checkout is gone with the branch unmerged.
  if (!probes.dirExists) return { state: WORKSPACE_STATE.dangling, ...base }
  return { state: WORKSPACE_STATE.idle, ...base }
}

// attention first, finished last; archived sorts below all of them whatever its state
const STATE_RANK: Record<WorkspaceState, number> = {
  [WORKSPACE_STATE.dangling]: 0,
  [WORKSPACE_STATE.waiting]: 1,
  [WORKSPACE_STATE.active]: 2,
  [WORKSPACE_STATE.idle]: 3,
  [WORKSPACE_STATE.merged]: 4,
}

export function compareWorkspaceHealth(
  a: { workspace: Pick<Workspace, 'archivedAt'>; health: Pick<WorkspaceHealth, 'state'> },
  b: { workspace: Pick<Workspace, 'archivedAt'>; health: Pick<WorkspaceHealth, 'state'> },
): number {
  const archived = Number(a.workspace.archivedAt !== null) - Number(b.workspace.archivedAt !== null)
  return archived !== 0 ? archived : STATE_RANK[a.health.state] - STATE_RANK[b.health.state]
}
