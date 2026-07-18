import {
  EVENT_KIND, OPERATION_STATUS, STEP_RUN_STATUS, addUsage,
  OperationCompletedPayload, OperationFailedPayload, OperationStartedPayload,
} from '@orc/contracts'
import type {
  EventRecord, FailureClass, OperationRecord, Plan, StepRunStatus, TaskNode, TaskStatus, Usage,
} from '@orc/contracts'

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

export interface State {
  tasks: Map<string, TaskNode>
  plans: Map<string, TaskPlans>
  steps: Map<string, Map<string, StepState>>
  runs: Map<string, RunRecord[]>
  usage: Map<string, Usage>
  splits: Map<string, SplitState>
  operations: Map<string, OperationRecord>
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUSD: null, estimated: false }

// The ONE transition function for the durable operation journal: the live journal row
// mutation (EventLog.beginOperation/completeOperation/failOperation) and the rebuild fold
// both apply committed transition events through here, so they can never disagree.
export function applyOperationEvent(current: OperationRecord | undefined, e: EventRecord): OperationRecord {
  if (e.kind === EVENT_KIND.operation_started) {
    const p = OperationStartedPayload.parse(e.payload)
    if (!e.taskId || !e.stepId || !e.runToken)
      throw new Error(`operation_started ${p.operationId} is missing task/step/run binding`)
    return {
      projectId: e.projectId, operationId: p.operationId,
      taskId: e.taskId, stepId: e.stepId, runToken: e.runToken,
      kind: p.operationKind, name: p.name,
      status: OPERATION_STATUS.started, attempts: p.attempt,
      before: p.before ?? null, after: null, error: null,
      startedSeq: e.seq, finishedSeq: null, startedAt: e.ts, finishedAt: null,
    }
  }
  if (!current) throw new Error(`operation transition ${e.kind} without a started node (seq ${e.seq})`)
  if (e.kind === EVENT_KIND.operation_completed) {
    const p = OperationCompletedPayload.parse(e.payload)
    return { ...current, status: OPERATION_STATUS.completed, attempts: p.attempt, after: p.after ?? null, finishedSeq: e.seq, finishedAt: e.ts }
  }
  const p = OperationFailedPayload.parse(e.payload)
  return { ...current, status: OPERATION_STATUS.failed, attempts: p.attempt, error: p.error ?? null, finishedSeq: e.seq, finishedAt: e.ts }
}

const OPERATION_KINDS: Set<EventRecord['kind']> = new Set([
  EVENT_KIND.operation_started, EVENT_KIND.operation_completed, EVENT_KIND.operation_failed,
])

// pure rebuild of the journal from the append-only truth
export function foldOperations(events: EventRecord[]): Map<string, OperationRecord> {
  const out = new Map<string, OperationRecord>()
  for (const e of events) {
    if (!OPERATION_KINDS.has(e.kind)) continue
    const id = OperationStartedPayload.pick({ operationId: true }).parse(e.payload).operationId
    out.set(id, applyOperationEvent(out.get(id), e))
  }
  return out
}

export const crashDedupKey = (e: EventRecord): string | null => {
  // task_status_changed is excluded: run-init (→running) and run-finish (→done) share a runToken
  // and would collide; a replayed status append is idempotent in fold anyway.
  // operation transitions are excluded: their db idempotency keys already forbid raw duplicates,
  // and attempts 1 and 2 of one operation would collide here and hide the retry.
  if (!e.runToken || e.kind === EVENT_KIND.task_status_changed || OPERATION_KINDS.has(e.kind)) return null
  // `name` discriminates multiple `skill_loaded` events sharing one runToken.
  // `splitId` discriminates multiple `split_proposed` events sharing one runToken.
  const p = e.payload as { iteration?: number; toolCallId?: string; name?: string; splitId?: string }
  return `${e.runToken}:${e.kind}:${p.iteration ?? ''}:${p.toolCallId ?? ''}:${p.name ?? ''}:${p.splitId ?? ''}`
}

export function fold(events: EventRecord[]): State {
  const state: State = { tasks: new Map(), plans: new Map(), steps: new Map(), runs: new Map(), usage: new Map(), splits: new Map(), operations: new Map() }
  const seen = new Set<string>()

  const stepOf = (taskId: string, stepId: string): StepState | undefined => state.steps.get(taskId)?.get(stepId)
  const setStep = (taskId: string, s: StepState): void => {
    const m = state.steps.get(taskId) ?? new Map<string, StepState>()
    m.set(s.stepId, s)
    state.steps.set(taskId, m)
  }

  for (const e of events) {
    const key = crashDedupKey(e)
    if (key !== null) {
      if (seen.has(key)) continue // crash-boundary duplicate (spec §6.2)
      seen.add(key)
    }
    switch (e.kind) {
      case EVENT_KIND.task_created: {
        const { task } = e.payload as { task: TaskNode }
        state.tasks.set(task.id, task)
        break
      }
      case EVENT_KIND.plan_proposed:
      case EVENT_KIND.plan_edited: {
        const { plan } = e.payload as { plan: Plan }
        const tp = state.plans.get(plan.taskId) ?? { versions: [], approvedVersion: null }
        if (tp.versions.some(v => v.version === plan.version)) break // crash-replayed re-propose
        tp.versions.push(plan)
        state.plans.set(plan.taskId, tp)
        break
      }
      case EVENT_KIND.plan_approved: {
        const p = e.payload as { taskId: string; version: number }
        const tp = state.plans.get(p.taskId)
        if (tp) tp.approvedVersion = p.version
        break
      }
      case EVENT_KIND.task_status_changed: {
        const p = e.payload as { taskId: string; to: TaskStatus }
        const t = state.tasks.get(p.taskId)
        if (t) state.tasks.set(p.taskId, { ...t, status: p.to })
        break
      }
      case EVENT_KIND.run_started: {
        const p = e.payload as { planVersion: number; retryIndex: number; workflowId: string; cwd: string | null }
        if (!e.taskId) break
        const runs = state.runs.get(e.taskId) ?? []
        runs.push({ planVersion: p.planVersion, retryIndex: p.retryIndex, workflowId: p.workflowId, cwd: p.cwd })
        state.runs.set(e.taskId, runs)
        break
      }
      case EVENT_KIND.step_started: {
        const p = e.payload as { stepId: string; attempt: number }
        if (!e.taskId) break
        setStep(e.taskId, {
          stepId: p.stepId, runToken: e.runToken!, attempt: p.attempt,
          status: STEP_RUN_STATUS.running, iterations: 0, output: null, failure: null,
        })
        break
      }
      case EVENT_KIND.agent_call: {
        const p = e.payload as { stepId: string; iteration: number }
        if (!e.taskId) break
        const s = stepOf(e.taskId, p.stepId)
        if (s && s.runToken === e.runToken) s.iterations = Math.max(s.iterations, p.iteration)
        if (e.usage) state.usage.set(e.taskId, addUsage(state.usage.get(e.taskId) ?? ZERO_USAGE, e.usage))
        break
      }
      case EVENT_KIND.operation_started:
      case EVENT_KIND.operation_completed:
      case EVENT_KIND.operation_failed: {
        const id = OperationStartedPayload.pick({ operationId: true }).parse(e.payload).operationId
        state.operations.set(id, applyOperationEvent(state.operations.get(id), e))
        break // journal only — operation events never drive step-status logic
      }
      case EVENT_KIND.skill_loaded:
      case EVENT_KIND.tool_call:
      case EVENT_KIND.tool_result:
      case EVENT_KIND.signal_received:
      case EVENT_KIND.artifact_produced:
      case EVENT_KIND.memory_written:
      case EVENT_KIND.memory_deleted:
        break // traceability only; no state derivation
      case EVENT_KIND.split_proposed: {
        const p = e.payload as { splitId: string; taskId: string; stepId: string; runToken: string; childTaskId: string }
        if (!state.splits.has(p.splitId))
          state.splits.set(p.splitId, { ...p, resolved: false })
        break
      }
      case EVENT_KIND.split_resolved: {
        const p = e.payload as { splitId: string }
        const s = state.splits.get(p.splitId)
        if (s) s.resolved = true
        break
      }
      case EVENT_KIND.step_completed: {
        const p = e.payload as { stepId: string; summary: string }
        if (!e.taskId) break
        const s = stepOf(e.taskId, p.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = STEP_RUN_STATUS.completed
          s.output = p.summary
        }
        break
      }
      case EVENT_KIND.step_failed: {
        const p = e.payload as { stepId: string; class: FailureClass; message: string }
        if (!e.taskId) break
        const s = stepOf(e.taskId, p.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = STEP_RUN_STATUS.failed
          s.failure = { class: p.class, message: p.message }
        }
        break
      }
      default: {
        const unhandled: never = e.kind
        void unhandled
        break
      }
    }
  }
  return state
}

export function completedStepIds(state: State, taskId: string): Set<string> {
  const out = new Set<string>()
  for (const [id, s] of state.steps.get(taskId) ?? []) if (s.status === STEP_RUN_STATUS.completed) out.add(id)
  return out
}

export function nextAttempts(state: State, taskId: string, plan: Pick<Plan, 'steps'>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const step of plan.steps) {
    const s = state.steps.get(taskId)?.get(step.id)
    // running = orphaned/live attempt: reuse its number so the idempotent workflowID re-attaches
    out[step.id] = s ? (s.status === STEP_RUN_STATUS.running ? s.attempt : s.attempt + 1) : 1
  }
  return out
}

export function taskUsage(state: State, taskId: string): Usage {
  return state.usage.get(taskId) ?? ZERO_USAGE
}

export function subtreeTaskIds(state: State, rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const t of state.tasks.values())
    if (t.parentId) (children.get(t.parentId) ?? children.set(t.parentId, []).get(t.parentId)!).push(t.id)
  const out: string[] = []
  const queue = [rootId]
  while (queue.length) {
    const id = queue.shift()!
    out.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return out
}

// ponytail: whole-subtree sum on every call — cache per fold if it measurably slows
export function subtreeUsage(state: State, rootId: string): Usage {
  return subtreeTaskIds(state, rootId).reduce((acc, id) => addUsage(acc, taskUsage(state, id)), ZERO_USAGE)
}

export function pendingSplitForChild(state: State, childTaskId: string): SplitState | undefined {
  for (const s of state.splits.values()) if (s.childTaskId === childTaskId && !s.resolved) return s
  return undefined
}
