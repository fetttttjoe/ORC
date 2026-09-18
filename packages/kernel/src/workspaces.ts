import { EVENT_KIND, groupByWorkspace, openFeedbackTopics, PAYLOAD_SCHEMAS, TERMINAL_TASK_STATUS, TASK_STATUS, WORKSPACE_STATE } from '@orc/contracts'
import type { EventRecord, FeedbackEvent, TaskNode, Workspace, WorkspaceHealth, WorkspaceState } from '@orc/contracts'
import type { State } from './projections'

// Pure derivations over the fold — no db, no git, no clock — so the rule the CLI prints, the MCP
// door returns and the console draws is ONE function, not three readings that drift.
// The projection import is TYPE-only and erases at compile time, so this file still has no runtime
// dependency on the projection it reads: it stays callable from a test that hands it a literal. The
// contracts import is NOT type-only, because workspaceHealth reads event payloads and every payload
// read in this repo goes through a zod schema — a cast to get the type-only property back would be
// exactly the defect the rule exists to prevent.

// Active only: an archived workspace must not swallow a new checkout at the same path (the
// operator archived it precisely because that path is done). Exact cwd — callers pass the
// resolved project/worktree dir, never a subdirectory.
export function workspaceByCwd(workspaces: ReadonlyMap<string, Workspace>, cwd: string): Workspace | undefined {
  for (const w of workspaces.values()) if (w.archivedAt === null && w.cwd === cwd) return w
  return undefined
}

// null only for an ORPHAN — a task naming a workspace the fold never saw. That is a defect in the
// log (every task is created after its workspace exists), so callers surface it, never paper over it.
export function workspaceCwdFor(task: Pick<TaskNode, 'workspaceId'>, workspaces: ReadonlyMap<string, Workspace>): string | null {
  return workspaces.get(task.workspaceId)?.cwd ?? null
}

// Every task has a workspace; a task naming an unknown id is a fold defect and is reported by
// orphanTasks(state) rather than dropped into a group it does not belong to.
export function tasksByWorkspace(state: Pick<State, 'tasks' | 'workspaces'>): Array<{ workspace: Workspace; tasks: TaskNode[] }> {
  return groupByWorkspace(state.workspaces.values(), state.tasks.values()).map(g => ({ workspace: g.workspace, tasks: g.items }))
}

// Tasks whose workspaceId the fold never saw — shown by `orc tasks` under a loud "orphaned"
// heading, never hidden: a task the grouped view silently dropped is a task the operator cannot
// find, and the missing workspace record is the bug they need to see.
export function orphanTasks(state: Pick<State, 'tasks' | 'workspaces'>): TaskNode[] {
  return [...state.tasks.values()].filter(t => !state.workspaces.has(t.workspaceId))
}

// ── Transitions ───────────────────────────────────────────────────────────────────────────────
// ONE transition function per workspace fact, applied by BOTH the fold (projections.ts) and the
// kernel method that appends the event — the same discipline applyOperationEvent already enforces
// for the operation journal, and for the same reason: the record a caller gets back must be the
// record the next fold of that log produces. Spelled twice, they can drift.

export function applyRetitle(w: Workspace, title: string): Workspace {
  return { ...w, title }
}

// `archived` is a PARAMETER, not two transitions — restore is this call with the flag off, so it
// cannot drift from archive. `at` is the archive stamp and is ignored on restore: a restored
// workspace has no archive time, and keeping the old one would make an active record read as archived.
export function applyArchived(w: Workspace, archived: boolean, at: string): Workspace {
  return { ...w, archivedAt: archived ? at : null }
}

// ── Health ────────────────────────────────────────────────────────────────────────────────────
// ONE verdict per workspace, derived from the fold, so `orc ws ls`, `workspace_list` and
// `project_status` print the same word for the same checkout. Three surfaces each deciding for
// themselves what "stale" means is three answers to a question the operator asks once.
//
// The VOCABULARY (WORKSPACE_STATE, WorkspaceHealth, WorkspaceWithHealth) lives in contracts, beside
// WorkspaceKind: the browser bundle reads a workspace's health off the wire and cannot import this
// package. What stays here is the POLICY — which rung wins, and how the rows are ordered.

// What only the FILESYSTEM can answer, taken by the caller and handed in. This module stays pure —
// no existsSync, no git — because the state table is the part that has to be testable against a
// literal, and a probe inside it would need a real checkout on disk for every row.
// `clean` is three-valued for the reason isClean is: null means git declined to answer (the
// directory is not a checkout, or is gone), which is a different fact from "has uncommitted work".
export interface WorkspaceProbes { dirExists: boolean; clean: boolean | null }

// The workspace an event is ABOUT, or null when it is about no workspace. The four workspace kinds
// are the only ones that name one, and each names it in its own field — read through
// PAYLOAD_SCHEMAS, never off an untyped property, so a malformed payload contributes nothing
// instead of throwing. Spelled as the fold's own switch: a lookup table keyed by kind would need a
// cast to index it with an arbitrary EventKind, which is the defect this repo does not ship.
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

/**
 * Is anyone still owed an answer in this workspace?
 *
 * A `feedback_requested` with no later `feedback_provided` on the same (task, topic) is a step
 * parked inside DBOS.recv waiting on a person — invisible in the task's status, which stays
 * `blocked` or `running` while nothing moves.
 *
 * The RULE is feedback-open.ts's, shared with Kernel.openRequest, which asks a narrower question of
 * the same events: WHICH question is open on ONE task, with the envelope a reply has to resume.
 * This asks "is anything open anywhere in this checkout" across many tasks at once. The spelling
 * is code, not a comment, so the keyset is testable.
 *
 * Scoped BEFORE the rule rather than after it: the keys it returns are the pure module's own
 * spelling, so the only place to test membership of this workspace's tasks is the events going in.
 */
function hasOpenQuestion(events: ReadonlyArray<FeedbackEvent>, taskIds: ReadonlySet<string>): boolean {
  return openFeedbackTopics(events.filter(e => e.taskId !== null && taskIds.has(e.taskId))).size > 0
}

/**
 * One workspace's state, from the fold plus what only the caller can see (the filesystem, the note
 * read model). Pure: same inputs, same verdict, on any machine.
 *
 * The rungs are an if-else CHAIN and their order IS the rule — each one names why it sits where it
 * does. `events` is the project's log in log order; `notesByWorkspace` counts STILL-PROVISIONAL
 * notes per workspace, and is null when the read model could not be asked at all.
 *
 * ponytail: two passes over the whole log per workspace, so listing a project costs
 * O(workspaces × events) — nothing at a handful of checkouts, and unmeasured past that. The upgrade
 * is to bucket the events by workspace ONCE in the caller and hand each call its own slice; this
 * takes an array rather than a log precisely so that stays the caller's change, not this file's.
 */
export function workspaceHealth(
  state: Pick<State, 'tasks' | 'workspaces' | 'workspaceMerges'>,
  events: ReadonlyArray<Pick<EventRecord, 'taskId' | 'ts' | 'kind' | 'payload'>>,
  notesByWorkspace: ReadonlyMap<string, number> | null,
  w: Workspace,
  probes: WorkspaceProbes,
): WorkspaceHealth {
  const tasks = [...state.tasks.values()].filter(t => t.workspaceId === w.id)
  const taskIds = new Set(tasks.map(t => t.id))
  const open = tasks.filter(t => !TERMINAL_TASK_STATUS.has(t.status))
  // A workspace with nothing pending counts 0; one we could not COUNT is null. The two must not
  // collapse, or "the read model is down" would render as "nothing pending here".
  const provisionalNotes = notesByWorkspace === null ? null : notesByWorkspace.get(w.id) ?? 0

  let lastActivityAt: string | null = null
  for (const e of events) {
    const mine = e.taskId !== null ? taskIds.has(e.taskId) : workspaceEventId(e) === w.id
    // ISO-8601 UTC from the log (EventRecord.ts is always Date.toISOString()), so a lexicographic
    // max IS the chronological one — and unlike Date.parse it cannot turn an unreadable stamp into
    // a NaN that silently loses every comparison.
    if (mine && (lastActivityAt === null || e.ts > lastActivityAt)) lastActivityAt = e.ts
  }

  // Read ONCE, above the rungs, because it is both: the `merged` RUNG below consumes it, and the
  // `merged` FLAG carries it past every rung that shadows that one. A landed workspace whose task is
  // running reads `active`, and a reader with only the state column could not tell that from a
  // workspace that never landed — which is the one question the workspace transaction exists to
  // answer, so it travels beside the state rather than being encoded in it.
  const merged = state.workspaceMerges.has(w.id)
  const base = { lastActivityAt, taskCount: tasks.length, openTaskCount: open.length, merged, provisionalNotes, ...probes }
  // Something IS moving here — the one state that needs no further reading.
  if (tasks.some(t => t.status === TASK_STATUS.running)) return { state: WORKSPACE_STATE.active, ...base }
  // Below `active` on purpose: a gate in a checkout where another task is already working is not
  // where the operator should be sent first.
  if (tasks.some(t => t.status === TASK_STATUS.awaiting_approval) || hasOpenQuestion(events, taskIds))
    return { state: WORKSPACE_STATE.waiting, ...base }
  // Above `dangling`, which is what makes "dangling = NOT merged AND …" structural rather than a
  // second condition someone could forget: `ws merge` REMOVES the worktree, so a landed workspace
  // fails the dirExists probe as a matter of course and would otherwise be reported as the one
  // thing it is not — abandoned.
  if (merged) return { state: WORKSPACE_STATE.merged, ...base }
  // Work that will never land unless someone acts: the checkout is gone with the branch unmerged,
  // or nothing is open in it any more while knowledge written there still waits on a merge.
  // `provisionalNotes !== null` keeps ignorance from reading as evidence.
  if (!probes.dirExists || (open.length === 0 && provisionalNotes !== null && provisionalNotes > 0))
    return { state: WORKSPACE_STATE.dangling, ...base }
  return { state: WORKSPACE_STATE.idle, ...base }
}

// Attention first, finished business last — the order every door lists workspaces in. An archived
// record sorts below ALL of them whatever its state: the operator archived that path on purpose,
// and a dangling archived workspace outranking a live one is exactly backwards.
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
