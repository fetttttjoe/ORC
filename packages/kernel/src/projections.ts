import { z } from 'zod'
import {
  ArtifactProducedPayload, EVENT_KIND, FAILURE_CLASS, FailureClass, OPERATION_STATUS, Plan,
  STEP_RUN_STATUS, TaskNode, TaskStatus, ZERO_USAGE, addUsage,
  OperationCompletedPayload, OperationFailedPayload, OperationStartedPayload,
} from '@orc/contracts'
import type { EventRecord, OperationRecord, StepRunStatus, Usage } from '@orc/contracts'

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
}



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
  // task_status_changed is excluded: run-init (→running) and run-finish (→done) share a runToken
  // and would collide; a replayed status append is idempotent in fold anyway.
  // operation transitions are excluded: their db idempotency keys already forbid raw duplicates,
  // and attempts 1 and 2 of one operation would collide here and hide the retry.
  if (!e.runToken || e.kind === EVENT_KIND.task_status_changed || OPERATION_KINDS.has(e.kind)) return null
  // `name` discriminates multiple `skill_loaded` events sharing one runToken.
  // `splitId` discriminates multiple `split_proposed` events sharing one runToken.
  // `path` discriminates multiple `artifact_produced` receipts sharing one runToken.
  const f = (key: string): string => {
    const v = e.payload[key]
    return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
  }
  return `${e.runToken}:${e.kind}:${f('iteration')}:${f('toolCallId')}:${f('name')}:${f('splitId')}:${f('path')}`
}

// Read-side views: only the fields fold derives state from, looser than the write-time
// PAYLOAD_SCHEMAS on purpose — historical events may predate later-added fields (e.g.
// plan_approved provenance), and reading must stay lenient where writing is strict.
const View = {
  task_created: z.object({ task: TaskNode }),
  plan: z.object({ plan: Plan }),
  plan_approved: z.object({ taskId: z.string(), version: z.number() }),
  task_status_changed: z.object({ taskId: z.string(), to: TaskStatus }),
  run_started: z.object({ planVersion: z.number(), retryIndex: z.number(), workflowId: z.string(), cwd: z.string().nullable().catch(null) }),
  step_started: z.object({ stepId: z.string(), attempt: z.number() }),
  agent_call: z.object({ stepId: z.string(), iteration: z.number() }),
  split_proposed: z.object({ splitId: z.string(), taskId: z.string(), stepId: z.string(), runToken: z.string(), childTaskId: z.string() }),
  split_resolved: z.object({ splitId: z.string() }),
  step_completed: z.object({ stepId: z.string(), summary: z.string() }),
  step_failed: z.object({ stepId: z.string(), class: FailureClass.catch(FAILURE_CLASS.agent_error), message: z.string() }),
}

// Lenient by design: fold must never throw on history — a malformed payload (from an
// older schema or a poison event) skips its case rather than wedging every projection.
export function fold(events: EventRecord[]): State {
  const state: State = { tasks: new Map(), plans: new Map(), steps: new Map(), runs: new Map(), usage: new Map(), stepUsage: new Map(), splits: new Map(), operations: new Map(), artifacts: new Map() }
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
        setStep(e.taskId, {
          stepId: p.data.stepId, runToken: e.runToken, attempt: p.data.attempt,
          status: STEP_RUN_STATUS.running, iterations: 0, output: null, failure: null,
        })
        break
      }
      case EVENT_KIND.agent_call: {
        const p = View.agent_call.safeParse(e.payload)
        if (!p.success || !e.taskId) break
        const s = stepOf(e.taskId, p.data.stepId)
        if (s && s.runToken === e.runToken) s.iterations = Math.max(s.iterations, p.data.iteration)
        if (e.usage) {
          state.usage.set(e.taskId, addUsage(state.usage.get(e.taskId) ?? ZERO_USAGE, e.usage))
          const sk = `${e.taskId}\u0000${p.data.stepId}`
          state.stepUsage.set(sk, addUsage(state.stepUsage.get(sk) ?? ZERO_USAGE, e.usage))
        }
        break
      }
      case EVENT_KIND.operation_started:
      case EVENT_KIND.operation_completed:
      case EVENT_KIND.operation_failed: {
        // honor fold's own contract uniformly: a malformed/orphaned operation transition skips its
        // case rather than throwing out of every consumer (status, vault, ui, the run-init checkpoint).
        // foldOperations/rebuild stays strict below — surfacing a poison event loudly is intended there.
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
      case EVENT_KIND.tool_call:
      case EVENT_KIND.tool_result:
      case EVENT_KIND.signal_received:
      case EVENT_KIND.memory_written:
      case EVENT_KIND.memory_deleted:
      case EVENT_KIND.memory_accessed:
      case EVENT_KIND.models_discovered:
      case EVENT_KIND.feedback_requested:
      case EVENT_KIND.feedback_provided:
      case EVENT_KIND.plan_annotated:
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
        const s = stepOf(e.taskId, p.data.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = STEP_RUN_STATUS.completed
          s.output = p.data.summary
        }
        break
      }
      case EVENT_KIND.step_failed: {
        const p = View.step_failed.safeParse(e.payload)
        if (!p.success || !e.taskId) break
        const s = stepOf(e.taskId, p.data.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = STEP_RUN_STATUS.failed
          s.failure = { class: p.data.class, message: p.data.message }
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

export function stepUsage(state: State, taskId: string, stepId: string): Usage {
  return state.stepUsage.get(`${taskId}\u0000${stepId}`) ?? ZERO_USAGE
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
