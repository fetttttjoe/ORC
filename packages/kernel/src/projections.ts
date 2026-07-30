import { z } from 'zod'
import {
  ArtifactProducedPayload, EVENT_KIND, FAILURE_CLASS, FailureClass, FS_WRITE_TOOL_NAMES, NOTE_TIER, OPERATION_STATUS, Plan,
  RUN_OUTCOME, STEP_RUN_STATUS, TASK_STATUS, TaskNode, TaskStatus, ZERO_USAGE, addUsage, runOutcomeFor,
  MemoryDeletedPayload, MemoryVerifiedPayload, MemoryWrittenPayload, noteContentKey, noteKey, normalizeRelPath,
  OperationCompletedPayload, OperationFailedPayload, OperationStartedPayload, ReactionFailedPayload,
} from '@orc/contracts'
import type { EventRecord, OperationRecord, RunOutcome, StepRunStatus, Usage } from '@orc/contracts'

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
  // The runtime failing at its own job, per task, latest last: a reaction that threw means nobody
  // acted on something the log already records as asked. Folded so `orc status` can SAY why a task
  // never moved — the failure used to exist only as a line on a supervisor's stdout.
  reactionFailures: Map<string, ReactionFailedPayload[]>
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

const stepOf = (state: State, taskId: string, stepId: string): StepState | undefined =>
  state.steps.get(taskId)?.get(stepId)

const setStep = (state: State, taskId: string, s: StepState): void => {
  const m = state.steps.get(taskId) ?? new Map<string, StepState>()
  m.set(s.stepId, s)
  state.steps.set(taskId, m)
}

// `seen` travels with the state because it is not recoverable from it: a suppressed duplicate
// leaves no trace, so an incremental fold without it would double-count every replayed event.
export interface FoldAcc {
  state: State
  seen: Set<string>
}

export const emptyFold = (): FoldAcc => ({
  state: { tasks: new Map(), plans: new Map(), steps: new Map(), runs: new Map(), usage: new Map(), stepUsage: new Map(), splits: new Map(), operations: new Map(), artifacts: new Map(), reactionFailures: new Map() },
  seen: new Set(),
})

// Mutates and returns `acc`: copy-per-event would be O(state) per event, which is the cost this
// exists to remove. Lenient by design — a malformed payload skips its case rather than throwing,
// or one poison event wedges every projection.
export function foldInto(acc: FoldAcc, e: EventRecord): FoldAcc {
  const { state, seen } = acc
  {
    const key = crashDedupKey(e)
    if (key !== null) {
      if (seen.has(key)) return acc // crash-boundary duplicate (spec §6.2)
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
        // A run was explicitly requested. The actual run state (planVersion, workflowId, etc.)
        // comes from run_started events; this event only carries the caller's overrides (cwd, retry).
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
          status: STEP_RUN_STATUS.running, iterations: 0, output: null, failure: null,
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
      // reads derived knowledge (a topic listing or one topic's claims) — drives no task state,
      // same as memory_accessed above
      case EVENT_KIND.memory_topic_accessed:
      // an auditor declaring a note checked — traceability, and the memory read model's own
      // projection. Which notes THIS task verified IS derived from it, by taskVerifiedNotes below
      // (the commit-step reverify set) — a stateless per-consumer derivation over the log, not task
      // state: nothing in State reads it, and a fold entry no consumer reads is state that rots.
      case EVENT_KIND.memory_verified:
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
        const s = stepOf(state, e.taskId, p.data.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = STEP_RUN_STATUS.completed
          s.output = p.data.summary
        }
        break
      }
      case EVENT_KIND.reaction_failed: {
        // lenient like every other fold: an unparseable diagnosis is not a diagnosis, and must not
        // throw away the history around it
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
  return acc
}

export function fold(events: EventRecord[]): State {
  return events.reduce(foldInto, emptyFold()).state
}

export function completedStepIds(state: State, taskId: string): Set<string> {
  const out = new Set<string>()
  for (const [id, s] of state.steps.get(taskId) ?? []) if (s.status === STEP_RUN_STATUS.completed) out.add(id)
  return out
}

export function nextAttempts(state: State, taskId: string, plan: Pick<Plan, 'steps'>): Record<string, number> {
  const out: Record<string, number> = {}
  // A step folded `running` normally means a LIVE attempt, and reusing its number is what makes the
  // deterministic workflowID re-attach instead of starting a duplicate. But that reading only holds
  // while the RUN is live. Once the task has settled, no step of it can still be running: the fold
  // says `running` only because the step died between its last checkpoint and step_failed — a
  // Postgres blip inside the finish window exhausts the checkpoint's retries, and finishFailed's own
  // append fails the same way, so the event that would have said "failed" was never written.
  //
  // Reusing the attempt then re-attached to a DEAD DBOS workflow, which replays its stored error, so
  // every `orc retry` failed identically and forever with no way to move past it. A settled task is
  // the log's own proof that the attempt is orphaned, so it gets a fresh one.
  const settled = state.tasks.get(taskId)?.status !== TASK_STATUS.running
  for (const step of plan.steps) {
    const s = state.steps.get(taskId)?.get(step.id)
    const live = s?.status === STEP_RUN_STATUS.running && !settled
    out[step.id] = s ? (live ? s.attempt : s.attempt + 1) : 1
  }
  return out
}

export function taskUsage(state: State, taskId: string): Usage {
  return state.usage.get(taskId) ?? ZERO_USAGE
}

export function stepUsage(state: State, taskId: string, stepId: string): Usage {
  return state.stepUsage.get(`${taskId}\u0000${stepId}`) ?? ZERO_USAGE
}

// Descendants parked at the human approval gate. `task_split` honours the project's approvalPolicy,
// so under the default (manual) the child sits here while the parent's join_splits recv's on it —
// and nothing else in the system says so: no event, no output, no outcome. Pure, so the run tail
// (which refolds anyway) and `orc status` (which already holds a fold) share one rule.
export function gatedChildren(state: State, rootId: string): Array<{ id: string; title: string }> {
  return subtreeTaskIds(state, rootId)
    .filter(id => id !== rootId)
    .flatMap(id => {
      const task = state.tasks.get(id)
      return task?.status === TaskStatus.enum.awaiting_approval ? [{ id, title: task.title }] : []
    })
}

// A run's outcome is the TREE's, not the root task's. A grounded parent finishes as soon as its
// plan step splits, so its own status reads `done` while the child doing the actual work sits
// blocked — observed live, reported at the terminal as success with exit code 0.
// `awaiting_approval` is deliberately NOT a failure here: a gated child is a stopping point the
// watch already announces by name, not a run that went wrong.
const FAILED_TASK_STATUS: ReadonlySet<TaskStatus> = new Set([TASK_STATUS.blocked, TASK_STATUS.failed])

export function subtreeOutcome(state: State, rootId: string): RunOutcome {
  const own = runOutcomeFor(state.tasks.get(rootId)?.status)
  if (own !== RUN_OUTCOME.done) return own
  const failed = subtreeTaskIds(state, rootId).some(id => {
    const status = state.tasks.get(id)?.status
    return status !== undefined && FAILED_TASK_STATUS.has(status)
  })
  return failed ? RUN_OUTCOME.blocked : RUN_OUTCOME.done
}

export function subtreeTaskIds(state: State, rootId: string): string[] {
  const children = new Map<string, string[]>()
  for (const t of state.tasks.values()) {
    if (!t.parentId) continue
    const siblings = children.get(t.parentId) ?? []
    siblings.push(t.id)
    children.set(t.parentId, siblings)
  }
  // breadth-first by appending while iterating: the array iterator reads by index, so ids pushed
  // during the walk are visited in turn
  const out: string[] = [rootId]
  for (const id of out) out.push(...(children.get(id) ?? []))
  return out
}

// The chain ABOVE a task, nearest first (parent, grandparent, …, root); excludes the task itself.
// One walk, because three callers had their own: the budget envelope, the CLI's root-of-tree lookup,
// and the memory lanes a step may read from.
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

// The budget a task may still spend: the TIGHTEST remaining envelope over its whole ancestor chain
// (itself, parent, grandparent, …) — min over ancestors that set a budgetUSD of
// (ancestor.budgetUSD − subtreeUsage(ancestor)). Ancestors with no budget are unconstrained and
// skipped; null means no ancestor sets one at all. Enforcing at the spend point across ancestors is
// what stops N sibling splits — each granted the full remaining budget before any spend — from
// together overspending the parent's envelope.
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

// The cwd a retry or a child run inherits: an explicit override always wins; otherwise the most
// recent run in history that HAD a cwd — findLast, never runs.at(-1), so a pre-project-dir-default
// run recorded with a null cwd cannot poison inheritance into an empty scratch dir. Falls back when
// no run in the history ever had one. Shared by retry() and startChildRun() so the rule lives once.
export function inheritedCwd(runs: RunRecord[] | undefined, override: string | undefined, fallback: string): string {
  return override ?? runs?.findLast(r => r.cwd)?.cwd ?? fallback
}

// The cwd a run STARTS in: an explicit override, else the world its parent ran in, else the project
// dir. The router (on an approved child) and the CLI (following a finished parent's children) both
// start the same child under the same deterministic workflow id, so whichever got there first used
// to decide the directory — two rules for one thing. This is that one rule.
export function runCwd(state: State, task: TaskNode, override: string | undefined, fallback: string): string {
  return inheritedCwd(task.parentId ? state.runs.get(task.parentId) : undefined, override, fallback)
}

export function pendingSplitForChild(state: State, childTaskId: string): SplitState | undefined {
  for (const s of state.splits.values()) if (s.childTaskId === childTaskId && !s.resolved) return s
  return undefined
}

// ── Scoped change set (audit) ────────────────────────────────────────────────────────────────
// The paths a task's steps WROTE, derived purely from EventRecord[] so the auditor never has to
// trust git. This is a MEMBERSHIP projection with exactly one permitted use: telling this task's
// declared-zone changes apart from sibling-task pollution in the scope-cleanliness check. It is a
// FLOOR, not a complete diff — exec-driven writes (formatters, codegen) are uncaptured — and it
// NEVER substitutes for the full bun test / bun run typecheck gate, nor dismisses a real defect in
// an in-zone file (the role-auditor skill contract: any defect ⇒ signal failure, unqualified).

// Which tool_calls are writes: contracts' FS_WRITE_TOOL_NAMES, so this audit projection and the
// executor's fence (loop.ts's WRITING_FILE_TOOLS, tools.ts's TOOL_NAME) read the same set — a
// fourth writing tool that only one side knew about would silently escape taskChangedPaths.

// The path a write tool acted on — exactly loop.ts's editedPath rule: input is a record, input.path
// is a non-empty string, or it is skipped rather than guessed at.
const WriteToolInput = z.object({ path: z.string().min(1) }).loose()
const writeInputPath = (input: unknown): string | null => {
  const parsed = WriteToolInput.safeParse(input)
  return parsed.success ? parsed.data.path : null
}

// One step's contribution to a changed path: the id, the tool that produced it, and the seq of the
// contributing event (the tool_call seq for a write, the receipt seq for an artifact).
export interface PathContributor {
  stepId: string | null
  tool: string
  seq: number
}

export interface ChangedPath {
  path: string
  steps: PathContributor[]
}

// Pure derivation of a task's change set from its events. Rules:
//  • only fs_write/fs_edit/fs_delete tool_calls whose input.path is a non-empty string;
//  • each paired with the tool_result carrying the SAME toolCallId, kept only when isError===false
//    (an unpaired tool_call — a crash before the result — is NOT a write);
//  • artifact_produced receipts folded in too (declared outputs count even if produced outside a
//    write tool), as a floor;
//  • normalized, deduped by path (keeping every contributing step), ordered by first seq then path.
export function taskChangedPaths(events: EventRecord[]): ChangedPath[] {
  // tool_result outcomes by toolCallId — pass one: a result present with isError===false is what
  // turns a tool_call into a confirmed write. A call id counts only when it saw at least one success
  // AND never an error (once failed, stays failed — a stray success replay cannot resurrect it).
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

// A note a task subtree touched, carrying the paths its LATEST write declared — the unit both
// post-commit stamp passes act on, because the dirty gate can only judge declared paths.
export interface TaskNoteRef { id: string; scope: string; paths: string[] }

// preexisting = the note ALREADY EXISTED when the subtree first wrote it (a prior memory_written
// for the same scope:id, from any author, including outside the subtree). That is the definition of
// a HEAL: the write corrected standing prose, so the commit may advance its stamp. A write that
// CREATED the note proves nothing about the note's truth — and stamping it anyway was the piggyback
// that let every ambient step note read verified-fresh forever without one reader checking it
// against the tree. Decided at the FIRST subtree write and never revised: a later rewrite of a note
// this subtree authored is still authorship. A delete clears membership, so a re-write after one
// reads fresh — the note it would have healed is gone.
export interface TaskNoteWrite extends TaskNoteRef { preexisting: boolean }

// A note a subtree step DECLARED verified, carrying the revision its stamp named — the tree the
// auditor read the cited paths against. The commit step's reverify gate diffs those paths between
// this revision and the tree it is about to stamp, so dropping it (which this fold used to do) is
// what let a commit advance a verification across ANOTHER task's change to the same file.
export interface TaskVerifiedNote extends TaskNoteRef { stampRevision: string }

// The semantic notes a task subtree wrote — half the restamp set: git_commit stamps exactly these,
// never a corpus-wide guess (drift.ts restampableNotes' documented ceiling). Membership is sticky
// across later outside-author rewrites (the task still touched it; paths follow the latest write),
// cleared by memory_deleted. Semantic-with-paths only: the freshness gate reads nothing else, so
// stamping a pathless or episodic note buys nothing.
export function taskNoteWrites(events: EventRecord[], subtree: ReadonlySet<string>): TaskNoteWrite[] {
  const notes = new Map<string, TaskNoteRef>()
  const touched = new Map<string, boolean>() // key → preexisting at the subtree's first write
  for (const e of events) {
    if (e.kind === EVENT_KIND.memory_written) {
      const p = MemoryWrittenPayload.safeParse(e.payload)
      if (!p.success) continue // lenient fold, like every projection
      const { note, author } = p.data
      if (note.tier !== NOTE_TIER.semantic) continue
      const key = noteKey(note.scope, note.id)
      const existed = notes.has(key) // read BEFORE the set: this write is the one being classified
      notes.set(key, { id: note.id, scope: note.scope, paths: [...note.paths] })
      if (author.taskId && subtree.has(author.taskId) && !touched.has(key)) touched.set(key, existed)
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const p = MemoryDeletedPayload.safeParse(e.payload)
      if (!p.success) continue
      const key = noteKey(p.data.scope, p.data.id)
      notes.delete(key)
      touched.delete(key)
    }
  }
  return [...touched].flatMap(([key, preexisting]) => {
    const n = notes.get(key)
    return n && n.paths.length > 0 ? [{ ...n, preexisting }] : []
  })
}

// The other half of the post-commit stamp set: notes a step of this subtree DECLARED verified
// (memory_verified — the auditor's CONFIRM). Verification is never inferred from a write, so it
// needs its own fold; the paths still come from the note's latest write, because that is the only
// place they exist and the reverify runs the same dirty gate as the restamp. Same shape rules as
// taskNoteWrites: deduped, semantic-with-paths only, membership cleared by memory_deleted.
//
// The stamp REVISION comes along, latest verification winning — the same last-write-wins rule the
// paths follow. It has to be the latest: the commit step's reverify appends its own memory_verified
// at the new HEAD, and that newer stamp is the tree the NEXT commit in the subtree must measure
// from. Reading an older one would re-open the window the newer verification already closed.
export function taskVerifiedNotes(events: EventRecord[], subtree: ReadonlySet<string>): TaskVerifiedNote[] {
  const notes = new Map<string, TaskNoteRef>()
  const content = new Map<string, string>() // EVERY write's content key, whatever tier it carried
  const verified = new Map<string, string>() // key → the LATEST verification's stamp revision
  for (const e of events) {
    if (e.kind === EVENT_KIND.memory_written) {
      const p = MemoryWrittenPayload.safeParse(e.payload)
      if (!p.success) continue
      const { note } = p.data
      const key = noteKey(note.scope, note.id)
      const k = noteContentKey(note)
      // The SAME carry-or-clear rule deriveNoteProvenance applies to the stored stamp, read off the
      // same log: a rewrite that changed what the note SAYS destroyed the auditor's verification,
      // whoever wrote it, so reverifying it post-commit would mint a check nobody performed. A
      // byte-identical rewrite (the restamp itself) keeps it — nothing the auditor read changed.
      //
      // Runs on every parseable write, BEFORE the tier gate, and off its own map: deriveNoteProvenance
      // has no tier gate, so a write that flipped a verified note off the semantic tier cleared the
      // stored stamp while this fold — gating first — kept the note in the verified set and had the
      // commit step reverify it at the new HEAD, minting a stamp for text nobody audited. The tier
      // gate belongs to the PATHS below (only a semantic note has `paths` for the dirty gate to
      // judge), never to the compare.
      const prev = content.get(key)
      if (prev !== undefined && prev !== k) verified.delete(key)
      content.set(key, k)
      if (note.tier !== NOTE_TIER.semantic) continue
      notes.set(key, { id: note.id, scope: note.scope, paths: [...note.paths] })
    } else if (e.kind === EVENT_KIND.memory_verified) {
      const p = MemoryVerifiedPayload.safeParse(e.payload)
      if (!p.success) continue
      if (p.data.author.taskId && subtree.has(p.data.author.taskId))
        verified.set(noteKey(p.data.scope, p.data.id), p.data.stamp.revision)
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const p = MemoryDeletedPayload.safeParse(e.payload)
      if (!p.success) continue
      const key = noteKey(p.data.scope, p.data.id)
      notes.delete(key)
      content.delete(key)
      verified.delete(key)
    }
  }
  return [...verified].flatMap(([key, stampRevision]) => {
    const n = notes.get(key)
    return n && n.paths.length > 0 ? [{ ...n, stampRevision }] : []
  })
}
