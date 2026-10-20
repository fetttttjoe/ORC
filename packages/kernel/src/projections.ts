import { z } from 'zod'
import {
  ArtifactProducedPayload, EVENT_KIND, FailureClass, FS_WRITE_TOOL_NAMES, OperationStatus, Plan,
  RunOutcome, StepRunStatus, TASK_STATUS, TERMINAL_TASK_STATUS, TaskNode, TaskStatus, TaskType, ZERO_USAGE, addUsage, runOutcomeFor,
  normalizeRelPath,
  OperationCompletedPayload, OperationFailedPayload, OperationStartedPayload, ReactionFailedPayload,
  ProjectIdentity, WorkspaceArchivedPayload, WorkspaceCreatedPayload, WorkspaceMergedPayload, WorkspaceRetitledPayload,
} from '@orc/contracts'
import type { EventRecord, OperationRecord, Usage, Workspace } from '@orc/contracts'
import { applyArchived, applyRetitle } from './workspaces'

export interface TaskPlans {
  versions: Plan[]
  approvedVersion: number | null
}

export interface StepState {
  stepId: string
  runToken: string
  attempt: number
  status: StepRunStatus
  iterations: number
  output: string | null
  failure: { class: FailureClass; message: string } | null
}

export interface RunRecord {
  planVersion: number
  retryIndex: number
  workflowId: string
  cwd: string | null
}

export interface SplitState {
  splitId: string
  taskId: string      // parent
  stepId: string
  runToken: string
  childTaskId: string
  resolved: boolean
}

// a verified output receipt bound to its producing step
export interface ArtifactRecord {
  path: string
  sha256: string
  size: number
  stepId: string | null
  runToken: string | null
  seq: number
}

export interface State {
  tasks: Map<string, TaskNode>
  plans: Map<string, TaskPlans>
  steps: Map<string, Map<string, StepState>>
  runs: Map<string, RunRecord[]>
  usage: Map<string, Usage>
  stepUsage: Map<string, Usage> // keyed `${taskId}\u0000${stepId}` — folded from the same agent_call events as `usage`
  splits: Map<string, SplitState>
  operations: Map<string, OperationRecord>
  artifacts: Map<string, ArtifactRecord[]>
  // a reaction that threw means nobody acted on something the log records as asked
  reactionFailures: Map<string, ReactionFailedPayload[]>
  workspaces: Map<string, Workspace>
  // its own fact, never a Workspace field: workspaceByCwd must keep ignoring whether it landed
  workspaceMerges: Map<string, WorkspaceMergedPayload>
  project: ProjectIdentity | null
}



// the one transition shared by the live journal row and the rebuild fold
export function applyOperationEvent(current: OperationRecord | undefined, e: EventRecord): OperationRecord {
  if (e.kind === EVENT_KIND.operation_started) {
    const p = OperationStartedPayload.parse(e.payload)
    if (!e.taskId || !e.stepId || !e.runToken)
      throw new Error(`operation_started ${p.operationId} is missing task/step/run binding`)
    return {
      projectId: e.projectId, operationId: p.operationId,
      taskId: e.taskId, stepId: e.stepId, runToken: e.runToken,
      kind: p.operationKind, name: p.name,
      status: OperationStatus.started, attempts: p.attempt,
      before: p.before ?? null, after: null, error: null,
      startedSeq: e.seq, finishedSeq: null, startedAt: e.ts, finishedAt: null,
    }
  }
  if (!current) throw new Error(`operation transition ${e.kind} without a started node (seq ${e.seq})`)
  if (e.kind === EVENT_KIND.operation_completed) {
    const p = OperationCompletedPayload.parse(e.payload)
    return { ...current, status: OperationStatus.completed, attempts: p.attempt, after: p.after ?? null, finishedSeq: e.seq, finishedAt: e.ts }
  }
  const p = OperationFailedPayload.parse(e.payload)
  return { ...current, status: OperationStatus.failed, attempts: p.attempt, error: p.error ?? null, finishedSeq: e.seq, finishedAt: e.ts }
}

const OPERATION_KINDS: Set<EventRecord['kind']> = new Set([
  EVENT_KIND.operation_started, EVENT_KIND.operation_completed, EVENT_KIND.operation_failed,
])

// built once: the per-event discriminator read must not construct a schema each time
const OperationIdOnly = OperationStartedPayload.pick({ operationId: true })

// pure rebuild of the journal from the append-only truth
export function foldOperations(events: EventRecord[]): Map<string, OperationRecord> {
  const out = new Map<string, OperationRecord>()
  for (const e of events) {
    if (!OPERATION_KINDS.has(e.kind)) continue
    const id = OperationIdOnly.parse(e.payload).operationId
    out.set(id, applyOperationEvent(out.get(id), e))
  }
  return out
}

export const crashDedupKey = (e: EventRecord): string | null => {
  // excluded kinds share a runToken across distinct events: status changes, operation attempts, waits
  if (!e.runToken || e.kind === EVENT_KIND.task_status_changed || e.kind === EVENT_KIND.rate_limit_wait || OPERATION_KINDS.has(e.kind)) return null
  // name, splitId and path discriminate repeated events that share one runToken
  const f = (key: string): string => {
    const v = e.payload[key]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
  }
  return `${e.runToken}:${e.kind}:${f('iteration')}:${f('toolCallId')}:${f('name')}:${f('splitId')}:${f('path')}`
}

// lenient on purpose: historical events may predate later-added fields; reading stays lenient
const View = {
  task_created: z.object({ task: TaskNode }),
  plan: z.object({ plan: Plan }),
  plan_approved: z.object({ taskId: z.string(), version: z.number() }),
  task_status_changed: z.object({ taskId: z.string(), to: z.enum(TaskStatus) }),
  run_started: z.object({ planVersion: z.number(), retryIndex: z.number(), workflowId: z.string(), cwd: z.string().nullable().catch(null) }),
  step_started: z.object({ stepId: z.string(), attempt: z.number() }),
  agent_call: z.object({ stepId: z.string(), iteration: z.number() }),
  split_proposed: z.object({ splitId: z.string(), taskId: z.string(), stepId: z.string(), runToken: z.string(), childTaskId: z.string() }),
  split_resolved: z.object({ splitId: z.string() }),
  step_completed: z.object({ stepId: z.string(), summary: z.string() }),
  step_failed: z.object({ stepId: z.string(), class: z.enum(FailureClass).catch(FailureClass.agent_error), message: z.string() }),
  workspace_created: WorkspaceCreatedPayload,
  workspace_retitled: WorkspaceRetitledPayload,
  workspace_archived: WorkspaceArchivedPayload,
  workspace_merged: WorkspaceMergedPayload,
}

const stepOf = (state: State, taskId: string, stepId: string): StepState | undefined =>
  state.steps.get(taskId)?.get(stepId)

const setStep = (state: State, taskId: string, s: StepState): void => {
  const m = state.steps.get(taskId) ?? new Map<string, StepState>()
  m.set(s.stepId, s)
  state.steps.set(taskId, m)
}

const stepUsageKey = (taskId: string, stepId: string): string => `${taskId}\u0000${stepId}`

// `seen` is not recoverable from state: without it an incremental fold double-counts replays
export interface FoldAcc {
  state: State
  seen: Set<string>
}

export const emptyFold = (): FoldAcc => ({
  state: { tasks: new Map(), plans: new Map(), steps: new Map(), runs: new Map(), usage: new Map(), stepUsage: new Map(), splits: new Map(), operations: new Map(), artifacts: new Map(), reactionFailures: new Map(), workspaces: new Map(), workspaceMerges: new Map(), project: null },
  seen: new Set(),
})

// mutates `acc` (copy-per-event is O(state)); a malformed payload skips its case, never throws
export function foldInto(acc: FoldAcc, e: EventRecord): FoldAcc {
  const { state, seen } = acc
  {
    const key = crashDedupKey(e)
    if (key !== null) {
      if (seen.has(key)) return acc // crash-boundary duplicate
      seen.add(key)
    }
    switch (e.kind) {
      case EVENT_KIND.task_created: {
        const p = View.task_created.safeParse(e.payload)
        if (p.success) state.tasks.set(p.data.task.id, p.data.task)
        break
      }
      case EVENT_KIND.plan_proposed:
      case EVENT_KIND.plan_edited: {
        const p = View.plan.safeParse(e.payload)
        if (!p.success) break
        const plan = p.data.plan
        const tp = state.plans.get(plan.taskId) ?? { versions: [], approvedVersion: null }
        if (tp.versions.some(v => v.version === plan.version)) break // crash-replayed re-propose
        tp.versions.push(plan)
        state.plans.set(plan.taskId, tp)
        break
      }
      case EVENT_KIND.plan_approved: {
        const p = View.plan_approved.safeParse(e.payload)
        if (!p.success) break
        const tp = state.plans.get(p.data.taskId)
        if (tp) tp.approvedVersion = p.data.version
        break
      }
      case EVENT_KIND.task_status_changed: {
        const p = View.task_status_changed.safeParse(e.payload)
        if (!p.success) break
        const t = state.tasks.get(p.data.taskId)
        if (t) state.tasks.set(p.data.taskId, { ...t, status: p.data.to })
        break
      }
      case EVENT_KIND.run_requested:
        break
      case EVENT_KIND.run_started: {
        const p = View.run_started.safeParse(e.payload)
        if (!p.success || !e.taskId) break
        const runs = state.runs.get(e.taskId) ?? []
        runs.push({ planVersion: p.data.planVersion, retryIndex: p.data.retryIndex, workflowId: p.data.workflowId, cwd: p.data.cwd })
        state.runs.set(e.taskId, runs)
        break
      }
      case EVENT_KIND.step_started: {
        const p = View.step_started.safeParse(e.payload)
        if (!p.success || !e.taskId || !e.runToken) break
        setStep(state, e.taskId, {
          stepId: p.data.stepId, runToken: e.runToken, attempt: p.data.attempt,
          status: StepRunStatus.running, iterations: 0, output: null, failure: null,
        })
        break
      }
      case EVENT_KIND.agent_call: {
        const p = View.agent_call.safeParse(e.payload)
        if (!p.success || !e.taskId) break
        const s = stepOf(state, e.taskId, p.data.stepId)
        if (s && s.runToken === e.runToken) s.iterations = Math.max(s.iterations, p.data.iteration)
        if (e.usage) {
          state.usage.set(e.taskId, addUsage(state.usage.get(e.taskId) ?? ZERO_USAGE, e.usage))
          const sk = stepUsageKey(e.taskId, p.data.stepId)
          state.stepUsage.set(sk, addUsage(state.stepUsage.get(sk) ?? ZERO_USAGE, e.usage))
        }
        break
      }
      case EVENT_KIND.operation_started:
      case EVENT_KIND.operation_completed:
      case EVENT_KIND.operation_failed: {
        // lenient like every fold; foldOperations stays strict so a poison event surfaces loudly
        const id = OperationIdOnly.safeParse(e.payload)
        if (!id.success) break
        try {
          state.operations.set(id.data.operationId, applyOperationEvent(state.operations.get(id.data.operationId), e))
        } catch { /* orphaned/malformed transition — skip, do not wedge */ }
        break // journal only — operation events never drive step-status logic
      }
      case EVENT_KIND.artifact_produced: {
        if (!e.taskId) break
        const p = ArtifactProducedPayload.safeParse(e.payload)
        if (!p.success) break
        const list = state.artifacts.get(e.taskId) ?? []
        list.push({ ...p.data, stepId: e.stepId, runToken: e.runToken, seq: e.seq })
        state.artifacts.set(e.taskId, list)
        break
      }
      case EVENT_KIND.skill_loaded:
      case EVENT_KIND.rate_limit_wait:
      case EVENT_KIND.tool_call:
      case EVENT_KIND.tool_result:
      case EVENT_KIND.signal_received:
      case EVENT_KIND.knowledge_delivered:
      case EVENT_KIND.knowledge_written:
      case EVENT_KIND.knowledge_checked:
      case EVENT_KIND.models_discovered:
      case EVENT_KIND.feedback_requested:
      case EVENT_KIND.feedback_provided:
      case EVENT_KIND.plan_annotated:
      case EVENT_KIND.plan_note_written:
      case EVENT_KIND.analysis_completed:
      case EVENT_KIND.copilot_exchange:
        break // traceability only; no state derivation (ponytail: no fold state until a consumer needs it — read via events.byTask)
      case EVENT_KIND.split_proposed: {
        const p = View.split_proposed.safeParse(e.payload)
        if (!p.success) break
        if (!state.splits.has(p.data.splitId))
          state.splits.set(p.data.splitId, { ...p.data, resolved: false })
        break
      }
      case EVENT_KIND.split_resolved: {
        const p = View.split_resolved.safeParse(e.payload)
        if (!p.success) break
        const s = state.splits.get(p.data.splitId)
        if (s) s.resolved = true
        break
      }
      case EVENT_KIND.step_completed: {
        const p = View.step_completed.safeParse(e.payload)
        if (!p.success || !e.taskId) break
        const s = stepOf(state, e.taskId, p.data.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = StepRunStatus.completed
          s.output = p.data.summary
        }
        break
      }
      case EVENT_KIND.reaction_failed: {
        // lenient: an unparseable diagnosis must not throw away the history around it
        const p = ReactionFailedPayload.safeParse(e.payload)
        if (!p.success || !e.taskId) break
        const list = state.reactionFailures.get(e.taskId) ?? []
        list.push(p.data)
        state.reactionFailures.set(e.taskId, list)
        break
      }
      case EVENT_KIND.step_failed: {
        const p = View.step_failed.safeParse(e.payload)
        if (!p.success || !e.taskId) break
        const s = stepOf(state, e.taskId, p.data.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = StepRunStatus.failed
          s.failure = { class: p.data.class, message: p.data.message }
        }
        break
      }
      case EVENT_KIND.commit_recorded:
        break // traceability only; no state derivation
      case EVENT_KIND.workspace_created: {
        const p = View.workspace_created.safeParse(e.payload)
        if (p.success) state.workspaces.set(p.data.workspace.id, p.data.workspace)
        break
      }
      case EVENT_KIND.workspace_retitled: {
        // the transition lives in workspaces.ts; only the lenient lookup is the fold's own
        const p = View.workspace_retitled.safeParse(e.payload)
        const w = p.success ? state.workspaces.get(p.data.workspaceId) : undefined
        if (p.success && w) state.workspaces.set(w.id, applyRetitle(w, p.data.title))
        break
      }
      case EVENT_KIND.workspace_archived: {
        const p = View.workspace_archived.safeParse(e.payload)
        const w = p.success ? state.workspaces.get(p.data.workspaceId) : undefined
        if (p.success && w) state.workspaces.set(w.id, applyArchived(w, p.data.archived, p.data.at))
        break
      }
      case EVENT_KIND.workspace_merged: {
        const p = View.workspace_merged.safeParse(e.payload)
        if (p.success) state.workspaceMerges.set(p.data.workspaceId, p.data)
        break
      }
      case EVENT_KIND.project_identified: {
        const p = ProjectIdentity.safeParse(e.payload)
        if (p.success) state.project = p.data
        break
      }
      case EVENT_KIND.chat_opened:
        // a chat is its envelope: no fold state; named so the exhaustive `never` below holds
        break
      default: {
        const unhandled: never = e.kind
        void unhandled
        break
      }
    }
  }
  return acc
}

export function fold(events: EventRecord[]): State {
  return events.reduce(foldInto, emptyFold()).state
}

export function completedStepIds(state: State, taskId: string): Set<string> {
  const out = new Set<string>()
  for (const [id, s] of state.steps.get(taskId) ?? []) if (s.status === StepRunStatus.completed) out.add(id)
  return out
}

// the ONE derivation behind retryability, shared by assertRetryable and port.retry
export function blockingVerdicts(state: State, taskId: string): Array<{ stepId: string; message: string }> {
  const out: Array<{ stepId: string; message: string }> = []
  for (const [id, s] of state.steps.get(taskId) ?? [])
    if (s.status === StepRunStatus.failed && s.failure?.class === FailureClass.rejected)
      out.push({ stepId: id, message: s.failure.message })
  return out
}

// futile only when EVERY failure is a verdict: a mixed run may change what the verdict sees
export function retryIsFutile(state: State, taskId: string): boolean {
  const steps = [...(state.steps.get(taskId) ?? []).values()].filter(s => s.status === StepRunStatus.failed)
  return steps.length > 0 && steps.every(s => s.failure?.class === FailureClass.rejected)
}

// only `blocked` has a run waiting to resume; the offer and the refusals read this one fact
export function canRetry(state: State, taskId: string): boolean {
  return state.tasks.get(taskId)?.status === TASK_STATUS.blocked && !retryIsFutile(state, taskId)
}

export function nextAttempts(state: State, taskId: string, plan: Pick<Plan, 'steps'>): Record<string, number> {
  const out: Record<string, number> = {}
  // a settled task has no live step: reusing a dead attempt re-attached to a dead workflow forever
  const settled = state.tasks.get(taskId)?.status !== TASK_STATUS.running
  for (const step of plan.steps) {
    const s = state.steps.get(taskId)?.get(step.id)
    const live = s?.status === StepRunStatus.running && !settled
    out[step.id] = s ? (live ? s.attempt : s.attempt + 1) : 1
  }
  return out
}

// the attempt each step is CURRENTLY on: cancel needs it, nextAttempts is always one ahead
export function startedAttempts(state: State, taskId: string, plan: Pick<Plan, 'steps'>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const step of plan.steps) {
    const s = state.steps.get(taskId)?.get(step.id)
    if (s) out[step.id] = s.attempt
  }
  return out
}

export function taskUsage(state: State, taskId: string): Usage {
  return state.usage.get(taskId) ?? ZERO_USAGE
}

export function stepUsage(state: State, taskId: string, stepId: string): Usage {
  return state.stepUsage.get(stepUsageKey(taskId, stepId)) ?? ZERO_USAGE
}

// a gated child is invisible otherwise: the parent's join_splits waits on it with no event
export function gatedChildren(state: State, rootId: string): Array<{ id: string; title: string }> {
  return subtreeTaskIds(state, rootId)
    .filter(id => id !== rootId)
    .flatMap(id => {
      const task = state.tasks.get(id)
      return task?.status === TaskStatus.awaiting_approval ? [{ id, title: task.title }] : []
    })
}

// the TREE's outcome, not the root's; awaiting_approval is a stopping point, not a failure
const FAILED_TASK_STATUS: ReadonlySet<TaskStatus> = new Set([TASK_STATUS.blocked, TASK_STATUS.failed])

export function subtreeOutcome(state: State, rootId: string): RunOutcome {
  const own = runOutcomeFor(state.tasks.get(rootId)?.status)
  if (own !== RunOutcome.done) return own
  const failed = subtreeTaskIds(state, rootId).some(id => {
    const status = state.tasks.get(id)?.status
    return status !== undefined && FAILED_TASK_STATUS.has(status)
  })
  return failed ? RunOutcome.blocked : RunOutcome.done
}

export function subtreeTaskIds(state: State, rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const t of state.tasks.values()) {
    if (!t.parentId) continue
    const siblings = children.get(t.parentId) ?? []
    siblings.push(t.id)
    children.set(t.parentId, siblings)
  }
  // breadth-first by appending while iterating: ids pushed during the walk are visited in turn
  const out: string[] = [rootId]
  for (const id of out) out.push(...(children.get(id) ?? []))
  return out
}

export function knowledgeOwnerTaskIds(state: State, taskId: string): string[] {
  const parentId = state.tasks.get(taskId)?.parentId
  const parent = parentId ? state.tasks.get(parentId) : undefined
  const owned = subtreeTaskIds(state, taskId)
  return parent?.type === TaskType.grounded ? [...owned, parent.id] : owned
}

// nearest first, excluding the task; one walk shared by the budget and the root lookup
export function ancestorTaskIds(state: State, taskId: string): string[] {
  const out: string[] = []
  for (let id = state.tasks.get(taskId)?.parentId ?? null; id !== null; id = state.tasks.get(id)?.parentId ?? null)
    out.push(id)
  return out
}

// ponytail: whole-subtree sum on every call — cache per fold if it measurably slows
export function subtreeUsage(state: State, rootId: string): Usage {
  return subtreeTaskIds(state, rootId).reduce((acc, id) => addUsage(acc, taskUsage(state, id)), ZERO_USAGE)
}

// null with no comparable history, never a fabricated zero; unpriced subtrees are not averaged
export function estimateCostUSD(state: State, opts: { strategyRef: string; analyzerRef?: string }): number | null {
  const measured: number[] = []
  for (const task of state.tasks.values()) {
    if (!TERMINAL_TASK_STATUS.has(task.status)) continue
    const plan = state.plans.get(task.id)?.versions.at(-1)
    if (!plan || plan.strategyRef !== opts.strategyRef) continue
    if (opts.analyzerRef !== undefined && plan.analyzerRef !== opts.analyzerRef) continue
    const costUSD = subtreeUsage(state, task.id).costUSD
    if (costUSD !== null) measured.push(costUSD)
  }
  if (measured.length === 0) return null
  return measured.reduce((a, b) => a + b, 0) / measured.length
}

// the tightest remaining envelope over the ancestor chain, so sibling splits cannot overspend
export function remainingBudget(state: State, taskId: string): number | null {
  let remaining: number | null = null
  for (const id of [taskId, ...ancestorTaskIds(state, taskId)]) {
    const t = state.tasks.get(id)
    if (!t || t.budgetUSD === null) continue
    const r = t.budgetUSD - (subtreeUsage(state, id).costUSD ?? 0)
    remaining = remaining === null ? r : Math.min(remaining, r)
  }
  return remaining
}

// findLast, never at(-1): a run recorded with a null cwd must not poison inheritance
export function inheritedCwd(runs: RunRecord[] | undefined, override: string | undefined, fallback: string): string {
  return override ?? runs?.findLast(r => r.cwd)?.cwd ?? fallback
}

// one rule for a child's start dir, shared by the router and the CLI that follows children
export function runCwd(state: State, task: TaskNode, override: string | undefined, fallback: string): string {
  return inheritedCwd(task.parentId ? state.runs.get(task.parentId) : undefined, override, fallback)
}

export function pendingSplitForChild(state: State, childTaskId: string): SplitState | undefined {
  for (const s of state.splits.values()) if (s.childTaskId === childTaskId && !s.resolved) return s
  return undefined
}

// loop.ts's editedPath rule: a record with a non-empty string path, else skipped
const WriteToolInput = z.object({ path: z.string().min(1) }).loose()
const writeInputPath = (input: unknown): string | null => {
  const parsed = WriteToolInput.safeParse(input)
  return parsed.success ? parsed.data.path : null
}

// seq of the contributing event: the tool_call for a write, the receipt for an artifact
export interface PathContributor {
  stepId: string | null
  tool: string
  seq: number
}

export interface ChangedPath {
  path: string
  steps: PathContributor[]
}

// unpaired tool_calls are not writes; a FLOOR (exec writes uncaptured); ordered by first seq
export function taskChangedPaths(events: EventRecord[]): ChangedPath[] {
  // once failed, stays failed: a stray success replay cannot resurrect a call
  const sawSuccess = new Set<string>()
  const sawError = new Set<string>()
  for (const e of events) {
    if (e.kind !== EVENT_KIND.tool_result) continue
    const id = e.payload.toolCallId
    if (typeof id !== 'string') continue
    if (e.payload.isError === true) sawError.add(id)
    else sawSuccess.add(id)
  }
  const resultOk = (id: string): boolean => sawSuccess.has(id) && !sawError.has(id)

  // path → contributors, first-seen seq tracked for deterministic ordering
  const byPath = new Map<string, { firstSeq: number; steps: PathContributor[] }>()
  const add = (rawPath: string, contributor: PathContributor): void => {
    const path = normalizeRelPath(rawPath)
    if (path.length === 0) return
    const existing = byPath.get(path)
    if (existing) {
      existing.steps.push(contributor)
      if (contributor.seq < existing.firstSeq) existing.firstSeq = contributor.seq
    } else {
      byPath.set(path, { firstSeq: contributor.seq, steps: [contributor] })
    }
  }

  for (const e of events) {
    if (e.kind === EVENT_KIND.tool_call) {
      const p = e.payload
      const toolName = p.toolName
      const id = p.toolCallId
      if (typeof toolName !== 'string' || !FS_WRITE_TOOL_NAMES.has(toolName)) continue
      if (typeof id !== 'string' || !resultOk(id)) continue // unpaired or errored → not a write
      const path = writeInputPath(p.input)
      if (path === null) continue // malformed input — skipped, never guessed at
      add(path, { stepId: e.stepId, tool: toolName, seq: e.seq })
    } else if (e.kind === EVENT_KIND.artifact_produced) {
      const p = e.payload
      const path = p.path
      if (typeof path !== 'string' || path.length === 0) continue
      add(path, { stepId: e.stepId, tool: EVENT_KIND.artifact_produced, seq: e.seq })
    }
  }

  return [...byPath.entries()]
    .map(([path, v]) => ({ path, firstSeq: v.firstSeq, steps: v.steps }))
    .sort((a, b) => a.firstSeq - b.firstSeq || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, steps }) => ({ path, steps }))
}
