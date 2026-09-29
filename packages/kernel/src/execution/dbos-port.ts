import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  Confidence, EVENT_KIND, FailureClass, MAX_AUTO_CONTINUATIONS, RunOutcome, SignalOutcome, STEP_ID, STEP_ROLE, TASK_STATUS, UnifiedEventType,
  ChatRef, PAYLOAD_SCHEMAS,
  classifiedError, continuationTopic, errorMessage, failureClassOf, isApprovalAnswer, isTerminalError, resolveModel, costUSDFor,
  type AgentExecutor, type Checkpoint, type CommitRecordedPayload, type EventDraft, type EventRecord, type ExecutionPort, type ExecutorContext,
  type Origin, type TaskNode,
  type LoadedSkill, type ModelProvider, type OperationCheckpoint, type Plan, type PlanStep,
  type ResolvedTool, type RunHandle, type Signal, type SplitResult, type StepKnowledge, type StepMemory, type TaskStatus, type ToolSource,
} from '@orc/contracts'
import { type EventLog, type Storage, type EventLogOps } from '../storage'
import { openLiveState, type LiveState } from '../live-state'
import { acquireRuntimeLock, type RuntimeLock } from '../storage/runtime-lock'
import { groundedPlanOmission } from './strategies/grounded-plan'
import { decideGroundingFreshness, type GroundingNoteRef, type GroundingSource, type GroundingVerdict } from './strategies/grounding-freshness'
import {
  groundingDirective, isMixed, mixedGroundingDraft, reusedCitation, scanScope,
  type GroundingScope, type StalePathAnswer,
} from './strategies/grounding-scope'
import { verifyArtifacts } from './artifacts'
import { runChatOpened, runOrigin } from './run-chat'
import { fold, ancestorTaskIds, blockingVerdicts, canRetry, completedStepIds, nextAttempts, startedAttempts, remainingBudget, inheritedCwd, runCwd, type State } from '../projections'
import { Kernel } from '../kernel'
import { KERNEL_ERROR_CODE, KernelError } from '../errors'
import { readySteps, runOutcomeOf } from './interpreter'
import { createSignalRouter } from './signal-router'
import { projectSuffix, type ProjectConfig } from '../config'

export interface DbosPort extends ExecutionPort {
  /** The executor identity this port was booted with — passed to DBOS.setConfig({ executorID }),
   *  the one channel DBOS actually reads it from (globalParams.executorID freezes at module
   *  import, so writing DBOS__VMID inside launch() lands too late). The unit DBOS recovery scopes to. */
  executorId: string
  /** Folded project state, served from the live index once launched. Advisory reads only — see LiveState. */
  projectState(): Promise<State>
  launch(): Promise<void>
  // `drain: false` skips waiting for DBOS to quiesce. A workflow parked at a human gate is not
  // in-flight work — it is durable state waiting on a person — but DBOS cannot tell the difference
  // and waits out the gate's poll. A process that is about to exit must not: recovery owns
  // resumption, and the runtime lock is a session lock the connection releases either way.
  shutdown(opts?: { drain?: boolean }): Promise<void>
  startChildRun(childTaskId: string): Promise<void>
}

// depth-partitioned queues (spec D7): a gate-waiting parent at depth d holds a slot on
// agents:<d> only, so it can never starve the depth-d+1 children it is waiting on.
const agentQueue = (depth: number): string => `agents:${depth}`
const runQueue = (depth: number): string => `runs:${depth}`

// The startWorkflow option for a run at `depth`, so the two places that start one (startChildRun
// via the router, startRunAt via the CLI/retry) cannot disagree about its queue — they did, which
// left a child running outside the depth concurrency cap. Depth 0 is unqueued: runQueue(0) is
// never registered (see the launch loop), so it must stay absent rather than name a missing queue.
export const runQueueOptions = (depth: number): { queueName?: string } =>
  depth > 0 ? { queueName: runQueue(depth) } : {}

// How long one DBOS.recv waits before looping. Human gates park for hours, and every expiry
// writes durable rows that recovery must replay in order — so this trades nothing but row
// count. Cancellation responsiveness is independent of it (see the split gate).
const GATE_POLL_SECONDS = 3_600


// The scope of a decision that is NOT incremental (skip, full analyze, or a replayed decision):
// nothing reused, nothing scoped. Kept explicit so the recorded checkpoint output has one shape.
const NO_SCOPE: GroundingScope = { reused: [], rescan: [], paths: [], probed: false, perNote: [] }

// origin is the RUN's, never the step workflow's: one run is one chat, and a per-step chat would
// scatter a run's transcript across as many chats as it has steps.
interface RunArgs { taskId: string; planVersion: number; retryIndex: number; cwd: string | null; origin: Origin }
interface StepArgs { taskId: string; stepId: string; planVersion: number; attempt: number; cwd: string | null; origin: Origin }
interface StepResult { stepId: string; ok: boolean }

// the ONE place the deterministic step workflow id is built (start + cancel both use it)
const stepWorkflowId = (taskId: string, stepId: string, attempt: number): string =>
  `step:${taskId}:${stepId}:a${attempt}`

// DBOS guarantees a workflow id inside a registered workflow — fail loudly if that ever breaks
const workflowIdOrThrow = (): string => {
  const id = DBOS.workflowID
  if (!id) throw new Error('DBOS.workflowID is unset outside a workflow context')
  return id
}

// Thin wrapper so callers OUTSIDE a workflow (the CLI's `reply` verb) can resume a recv-gate
// without the kernel taking a direct @dbos-inc/dbos-sdk dependency — mirrors the signal router's
// own `send: (dest, result, topic, key) => DBOS.send(dest, result, topic, key)` wiring below.
// Requires DBOS to already be launched in this process (same requirement as any other port call).
export const dbosSend = (workflowId: string, message: string, topic: string, idempotencyKey: string): Promise<void> =>
  DBOS.send(workflowId, message, topic, idempotencyKey)

// The run-workflow init side effect, extracted so it is a named, directly-testable unit. Appends
// run_started idempotently, then RE-CHECKS status inside the SAME transaction before stamping
// approved/blocked → running. Exported so a test can call it twice to simulate DBOS re-executing
// init's fn() on resume (the crash window is between this transaction committing and DBOS recording
// the init step's output): the re-check makes the second call a clean no-op instead of a fixed-key
// idempotency_conflict that would brick the task at 'running'.
export async function appendRunInit(tx: EventLogOps, args: RunArgs, workflowId: string): Promise<void> {
  const events = await tx.byTask(args.taskId)
  const task = fold(events).tasks.get(args.taskId)
  if (!task) throw classifiedError(FailureClass.validation_error, `no task '${args.taskId}'`)
  // BEFORE run_started: nothing may claim to be inside a chat that has not been opened. Keyed by
  // the chat id, so the init DBOS re-executes on resume opens no second chat for the same run.
  const opened = runChatOpened({ chatId: workflowId, task, parent: await runChatParent(tx, events, task) })
  await tx.append({ ...args.origin, taskId: args.taskId, stepId: null, runToken: workflowId, ...opened })
  await tx.append({
    ...args.origin, taskId: args.taskId, stepId: null, runToken: workflowId, kind: EVENT_KIND.run_started,
    payload: { taskId: args.taskId, planVersion: args.planVersion, retryIndex: args.retryIndex, workflowId, cwd: args.cwd },
    idempotencyKey: `${workflowId}:init:run_started`,
  })
  const status = fold(await tx.byTask(args.taskId)).tasks.get(args.taskId)?.status
  if (status === TASK_STATUS.approved || status === TASK_STATUS.blocked)
    await tx.append({
      ...args.origin, taskId: args.taskId, stepId: null, runToken: workflowId, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: args.taskId, from: status, to: TASK_STATUS.running },
      idempotencyKey: `${workflowId}:init:task_status_changed`,
    })
}

// The causation pointer for a run's chat: the event in ANOTHER chat that started this run. A split
// child answers to the split_proposed on its PARENT's stream (it is never asked for by a client);
// every other run answers to the newest run_requested that itself belongs to a chat.
async function runChatParent(tx: EventLogOps, events: EventRecord[], task: TaskNode): Promise<ChatRef | null> {
  if (task.parentId !== null) {
    for (const e of [...(await tx.byTask(task.parentId))].reverse()) {
      if (e.kind !== EVENT_KIND.split_proposed || e.chatId === null) continue
      const p = PAYLOAD_SCHEMAS.split_proposed.safeParse(e.payload)
      if (p.success && p.data.childTaskId === task.id) return ChatRef.parse({ chatId: e.chatId, seq: e.seq })
    }
  }
  for (const e of [...events].reverse())
    if (e.kind === EVENT_KIND.run_requested)
      return e.chatId === null ? null : ChatRef.parse({ chatId: e.chatId, seq: e.seq })
  return null
}

// Stamp `to` on a task that is still 'running', in ONE locked transaction. Reading the status in a
// checkpoint's fn and appending from its toEvents would be TOCTOU: makeCheckpoint opens a SEPARATE
// transaction for its drafts, so an `orc cancel` could commit running→cancelled in between and this
// would append running→done on top of it (fold is last-seq-wins with no `from` check).
async function stampIfRunning(log: EventLog, taskId: string, to: TaskStatus, workflowId: string, name: string, origin: Origin): Promise<void> {
  await log.transaction(async tx => {
    const status = fold(await tx.byTask(taskId)).tasks.get(taskId)?.status
    if (status !== TASK_STATUS.running) return // a cancel already stamped a terminal status
    await tx.append({
      ...origin, taskId, stepId: null, runToken: workflowId, kind: EVENT_KIND.task_status_changed,
      payload: { taskId, from: TASK_STATUS.running, to },
      idempotencyKey: `${workflowId}:${name}:task_status_changed`,
    })
  })
}

// Drive an async generator to completion, GUARANTEEING gen.return() runs in a finally — so the
// generator's own finally (e.g. loop.ts releaseWriteClaims) executes even when the driver throws
// while the generator is suspended at a yield (a cancelled gate recv). onEvent returns the value to
// resume the generator with (or undefined). Extracted from the port's step loop so the "always
// clean up on any exit" policy is one testable unit, DBOS-free.
export async function driveGenerator<T, R>(
  gen: AsyncGenerator<T, void, R | undefined>,
  onEvent: (ev: T) => Promise<R | undefined>,
): Promise<void> {
  try {
    let resume: R | undefined
    while (true) {
      const { value, done } = await gen.next(resume)
      if (done) return
      resume = await onEvent(value)
    }
  } finally {
    await gen.return(undefined).catch(() => {})
  }
}

export async function createDbosPort(opts: {
  storage: Storage
  config: ProjectConfig
  providers: Map<string, ModelProvider<unknown>>
  executors: Map<string, AgentExecutor<unknown>>
  skills?: { load(name: string): Promise<LoadedSkill> }
  tools?: ToolSource
  // The per-step plugin surface: the tools a step's model may call, plus the step's own memory
  // (contracts StepMemory) when a memory backend is wired. `step` travels whole so a binding can
  // read title/dependsOn without the port re-deriving them.
  stepTools?: (p: {
    // the RUN's chat, so a tool that spawns a process or writes a note names the same interaction
    origin: Origin
    taskId: string; stepId: string; runToken: string; role: string; executor: string; model: string
    modelRef: string; maxIterations: number; workspaceDir: string; step: PlanStep
    // The workspace the TASK belongs to, off the TaskNode this run already folds. Here rather than
    // looked up by the composition root because only the port knows which task is running: a
    // supervisor serves every workspace at once, so deriving it from the supervisor's own cwd would
    // stamp every worktree's knowledge as trunk knowledge. MemoryAuthor.workspaceId is captured at
    // write time and never recoverable afterwards, so a wrong value here is permanent.
    workspaceId: string
    // nearest first (parent, …, root) — a split child's decomposition lives in its PARENT's scopes
    ancestorTaskIds: string[]
  }) => ResolvedTool[] | { tools: ResolvedTool[]; memory?: StepMemory; knowledge?: StepKnowledge }
  // Read-only probe behind the grounded analyze step's freshness short-circuit. Optional: a port
  // built without it behaves exactly as before, because the branch is guarded on its presence.
  groundingSource?: GroundingSource
  // The auto-heal reactor for out-of-task commits, injected because the kernel may not import
  // plugins/memory (same seam as the commit tool's restamp callback). Optional: absent, the
  // router leaves commit_recorded a traceability record, as before.
  onCommitRecorded?: (payload: CommitRecordedPayload) => Promise<void>
  executorId?: string
}): Promise<DbosPort> {
  const { config, providers, executors, skills, tools, stepTools, groundingSource } = opts
  const { events: log, operations: journal, redact } = opts.storage
  // cancelSubtree's append half only — this port stays the DBOS half (cancelWorkflowsFor below).
  // No refValidator/analyzers/send: those are propose/split/feedback concerns, untouched here.
  const kernel = new Kernel(log)

  // DBOS serializes EVERY step's return value into its own operation_outputs table
  // (dbos-executor's recordOperationResult), in the DBOS system database — same Postgres cluster
  // and credentials as the event log, but NOT behind EventLog.append's redaction. Raw tool results
  // and full model turns pass through here, so this is the one place they leave a step.
  const redactStepResult = <T>(r: T): T => redact.value(r)

  const foldState = async (taskId: string): Promise<State> => fold(await log.byTask(taskId))

  // Whole-project reads that byTask cannot answer (ancestor chains, "is anything running").
  // Advisory only — a few hundred ms of subscription lag is acceptable for a spend cap that is
  // already checked before the spend it bounds, and ancestors always predate the task asking.
  // Throws rather than falling back to a whole-log fold: every caller runs inside or after launch,
  // so a null here is a wiring bug, and silently reverting to the scan this exists to remove would
  // hide it as a slowdown instead of surfacing it.
  let live: LiveState | null = null
  const projectState = async (): Promise<State> => {
    if (!live) throw new Error('projectState requires a launched port')
    return live.current()
  }

  // terminal errors (e.g. a 4xx model failure) must NOT retry — see terminalError in @orc/contracts
  const RETRY_POLICY = { retriesAllowed: true, maxAttempts: 4, intervalSeconds: 1, backoffRate: 2, shouldRetry: (e: unknown) => !isTerminalError(e) }

  // durable step wrapper that also appends the drafted events INSIDE the step —
  // one transaction per batch, each draft under a deterministic idempotency key, so a crash
  // retry returns the committed records instead of appending duplicates
  const makeCheckpoint = (taskId: string, stepId: string | null, runToken: string, origin: Origin): Checkpoint =>
    (name, fn, toEvents) =>
      DBOS.runStep(
        async () => {
          const r = await fn()
          const drafts = toEvents ? toEvents(r) : []
          if (drafts.length > 0)
            await log.transaction(async tx => {
              for (const [i, d] of drafts.entries())
                await tx.append({
                  ...origin, taskId, stepId, runToken, ...d, usage: d.usage ?? null,
                  idempotencyKey: d.idempotencyKey ?? `${runToken}:${name}:${i}:${d.kind}`,
                })
            })
          // drafts go through log.append, which redacts on its own; this guards what DBOS persists
          return redactStepResult(r)
        },
        { name, ...RETRY_POLICY },
      )

  // The journal-backed operation checkpoint: before-record commits ahead of the
  // external effect; completion/failure attaches afterward. On recovery a completed node
  // short-circuits with its stored (redacted) value — the effect is never re-run.
  const makeOperation = (taskId: string, stepId: string, runToken: string, origin: Origin): OperationCheckpoint =>
    (spec, fn, toEvents) =>
      DBOS.runStep(
        async () => {
          const context = { taskId, stepId, runToken, origin }
          const begin = await journal.beginOperation(context, spec)
          // journal values are plain JSON — parse hands back the caller's shape
          if (begin.reused) return JSON.parse(JSON.stringify(begin.value ?? null))
          try {
            const result = await fn(begin.attempt)
            await journal.completeOperation(context, spec, begin.attempt, result, toEvents ? toEvents(result) : [])
            return redactStepResult(result)
          } catch (err) {
            await journal.failOperation(context, spec, begin.attempt, {
              message: errorMessage(err),
            })
            throw err
          }
        },
        { name: `op:${spec.operationId}`, ...RETRY_POLICY },
      )

  const stepWorkflow = DBOS.registerWorkflow(
    async (args: StepArgs): Promise<StepResult> => {
      const runToken = workflowIdOrThrow()
      const checkpoint = makeCheckpoint(args.taskId, args.stepId, runToken, args.origin)
      const operation = makeOperation(args.taskId, args.stepId, runToken, args.origin)

      // ANY throw — init included — becomes a step_failed event instead of an uncaught workflow
      // error that would leave the task stuck 'running' with a burned ERROR workflow that retry
      // re-attaches to.
      try {
      // checkpointed init: read plan/task/dep-outputs (event-log reads are non-deterministic → must be a step)
      const init = await checkpoint('init', async () => {
        const state = await foldState(args.taskId)
        const plan = state.plans.get(args.taskId)?.versions.find(p => p.version === args.planVersion)
        if (!plan) throw classifiedError(FailureClass.validation_error, `no plan v${args.planVersion} for task '${args.taskId}'`)
        const step = plan.steps.find(s => s.id === args.stepId)
        if (!step) throw classifiedError(FailureClass.validation_error, `no step '${args.stepId}' in plan v${args.planVersion}`)
        const task = state.tasks.get(args.taskId)
        if (!task) throw classifiedError(FailureClass.validation_error, `no task '${args.taskId}'`)
        const depOutputs: Record<string, string> = {}
        for (const dep of step.dependsOn) depOutputs[dep] = state.steps.get(args.taskId)?.get(dep)?.output ?? ''
        const loadedSkills: LoadedSkill[] = []
        for (const ref of step.skillRefs) {
          if (!skills) throw classifiedError(FailureClass.validation_error, `step declares skill '${ref}' but no skill index is configured`)
          try {
            loadedSkills.push(await skills.load(ref))
          } catch (err) {
            throw classifiedError(FailureClass.validation_error, `skill '${ref}': ${errorMessage(err)}`)
          }
        }
        // workspaceId travels with the spec because the task is only in hand HERE: the workflow
        // body below builds the step's tool surface and cannot fold the log again (event-log reads
        // are non-deterministic and must stay inside a checkpoint).
        return { step, taskSpec: task.spec, workspaceId: task.workspaceId, budgetUSD: task.budgetUSD, depOutputs, skills: loadedSkills }
      }, r => [
        { kind: EVENT_KIND.step_started, payload: { stepId: args.stepId, runToken, attempt: args.attempt } },
        ...r.skills.map((s): EventDraft => ({
          kind: EVENT_KIND.skill_loaded,
          payload: { stepId: args.stepId, runToken, name: s.name, hash: s.hash },
          // hash in the key: recovery after a hot skill edit records the new load instead of
          // colliding with the committed draft and permanently failing the step
          idempotencyKey: `${runToken}:skill:${s.name}:${s.hash}`,
        })),
      ])

      // The grounded analyze step's freshness short-circuit. When the area notes this scout would
      // re-derive are already current at HEAD, the deep scan is a model call that buys nothing —
      // so the step completes from the notes instead, and the plan step still gets its grounding
      // (see groundingSkipDrafts: the skip emits BOTH completion events).
      //
      // REPLAY DETERMINISM (the reason every probe call lives inside the checkpoint's fn): DBOS
      // records this step's return value, so a resumed workflow replays the RECORDED verdict
      // instead of re-probing git. If HEAD moved mid-run, the original verdict still stands and
      // the step does not change its mind halfway. That only holds while head()/notes()/
      // commitsSince() are called INSIDE fn — one of them in the workflow body around it would be
      // a fresh git read on every replay, and the drafts would then disagree with the recorded
      // decision. For the same reason toEvents derives the drafts purely from `v`, reading nothing
      // else, and both drafts carry explicit stable idempotency keys so a replay re-uses the
      // committed events rather than raising an idempotency conflict.
      //
      // A throw from the source is NOT a step failure: an unavailable probe is the absence of
      // evidence, so it is caught here and becomes an ordinary not-fresh verdict — today's full
      // analyze — rather than blocking the task.
      //
      // THREE outcomes, not two. `fresh` skips. `mixed` (some notes current, some stale) still runs
      // the scout, but hands it the current notes as grounding and scopes it to the stale notes'
      // changed paths — the scan scope is computed HERE, inside the same checkpoint, so it is part
      // of the recorded output and a replay renders the identical directive without touching git.
      // Everything else — no groundingSource, no notes, all stale, a probe throw, an unresolvable
      // HEAD — falls through to today's full analyze byte for byte.
      let grounding: { verdict: GroundingVerdict; scope: GroundingScope } | null = null
      if (groundingSource && args.stepId === STEP_ID.analyze && init.step.role === STEP_ROLE.scout) {
        const decision = await checkpoint('grounding', async (): Promise<{ committed: boolean; verdict: GroundingVerdict; scope: GroundingScope }> => {
          try {
            // The one crash window where fn() re-runs: the drafts committed, then the process died
            // before DBOS recorded this step's output. Re-probing there could produce a DIFFERENT
            // verdict (HEAD moved), whose drafts would collide with the committed events under the
            // same stable keys — an idempotency_conflict that would brick the step. So mirror the
            // 'finish' checkpoint: if a grounding decision already committed for this run token, it
            // is durable and wins outright. Which decision it was is readable from the events:
            //   * step_completed → the SKIP committed (both its drafts land in one transaction), so
            //     replay the skip and complete without a model call.
            //   * analysis_completed alone → the MIXED decision committed, but its scope lived only
            //     in the unrecorded step output. Rather than re-probe and risk a narrower scope
            //     than the one already published in the log, degrade to a full analyze: over-
            //     scanning is the safe direction, and no draft is re-emitted.
            const priorForRun = (await log.byTask(args.taskId)).filter(e => e.runToken === runToken)
            if (priorForRun.some(e => e.kind === EVENT_KIND.step_completed)) return {
              committed: true,
              verdict: { fresh: true, reason: 'the grounding skip already committed for this run token — replaying the recorded decision', head: null, current: [], stale: [] },
              scope: NO_SCOPE,
            }
            if (priorForRun.some(e => e.kind === EVENT_KIND.analysis_completed)) return {
              committed: true,
              verdict: { fresh: false, reason: 'a grounding decision already committed for this run token but its scope was not recorded — analyzing in full rather than re-deciding', head: null, current: [], stale: [] },
              scope: NO_SCOPE,
            }
            // notes() is called EXACTLY once (decideGroundingFreshness owns the call); this wrapper
            // keeps the refs it returned, because the verdict deliberately carries no declared
            // paths and the mixed branch needs them as the probe's fallback.
            let refs: GroundingNoteRef[] = []
            const verdict = await decideGroundingFreshness({
              head: () => groundingSource.head(),
              notes: async () => { refs = await groundingSource.notes(); return refs },
              commitsSince: (rev, paths) => groundingSource.commitsSince(rev, paths),
            })
            if (!isMixed(verdict)) return { committed: false, verdict, scope: NO_SCOPE }
            // one probe per STALE note, inside fn — that is the determinism rule
            const changed: Record<string, StalePathAnswer> = {}
            for (const s of verdict.stale) {
              const declared = refs.find(n => n.id === s.id)?.paths ?? []
              const reported = s.revision !== null && declared.length > 0
                ? (await groundingSource.changedPaths?.(s.revision, declared)) ?? null
                : null
              changed[s.id] = { declared, changed: reported }
            }
            return { committed: false, verdict, scope: scanScope(verdict, changed) }
          } catch (err) {
            return { committed: false, verdict: { fresh: false, reason: `grounding probe failed (${errorMessage(err)}) — analyzing`, head: null, current: [], stale: [] }, scope: NO_SCOPE }
          }
        }, r => {
          if (r.committed) return []
          if (r.verdict.fresh) return groundingSkipDrafts(r.verdict, args.stepId, runToken)
          // the mixed decision's evidence: one fold-inert analysis_completed, superseded later by
          // the scout's own report_coverage
          return isMixed(r.verdict) ? [mixedGroundingDraft(r.verdict, r.scope, runToken)] : []
        })
        // fresh → done, zero model calls. Mixed → the scout runs, but scoped (below). Anything
        // else → today's full analyze, byte for byte.
        if (decision.verdict.fresh) return { stepId: args.stepId, ok: true }
        if (isMixed(decision.verdict)) grounding = { verdict: decision.verdict, scope: decision.scope }
      }

      const executor = executors.get(init.step.executorRef)
      if (!executor) return await finishFailed(checkpoint, args, runToken, `no executor '${init.step.executorRef}'`)
      const { modelId, model, provider } = resolveModel(providers, init.step.modelRef)

      const workspaceDir = args.cwd ?? path.join(config.workspaceRoot, args.taskId, args.stepId)
      await checkpoint('workspace', async () => { mkdirSync(workspaceDir, { recursive: true }); return workspaceDir })

      // tool resolution is idempotent infra that spawns servers and returns closures — it records
      // nothing, so it lives in the workflow body (not a checkpoint) and re-runs cleanly on recovery.
      // pre-M3 plans in the log lack toolRefs — fold casts raw payloads, zod defaults don't apply to history
      const toolRefs = init.step.toolRefs ?? []
      let extraTools: ResolvedTool[] = []
      if (toolRefs.length > 0) {
        if (!tools) return await finishFailed(checkpoint, args, runToken, `step declares toolRefs but no tool source is configured`, FailureClass.validation_error)
        try {
          extraTools = await tools.resolve(toolRefs)
        } catch (err) {
          return await finishFailed(checkpoint, args, runToken, errorMessage(err), FailureClass.validation_error)
        }
      }

      let stepMemory: StepMemory | undefined
      let stepKnowledge: StepKnowledge | undefined
      if (stepTools) {
        const bound = stepTools({
          origin: args.origin,
          taskId: args.taskId, stepId: args.stepId, runToken, workspaceId: init.workspaceId,
          role: init.step.role, executor: init.step.executorRef, model: modelId,
          modelRef: init.step.modelRef, maxIterations: init.step.maxIterations, workspaceDir,
          step: init.step, ancestorTaskIds: ancestorTaskIds(await projectState(), args.taskId),
        })
        const { tools: stepScoped, memory, knowledge } = Array.isArray(bound) ? { tools: bound, memory: undefined, knowledge: undefined } : bound
        extraTools = [...extraTools, ...stepScoped]
        stepMemory = memory
        stepKnowledge = knowledge
      }

      const ctx: ExecutorContext<unknown> = {
        step: init.step,
        taskSpec: init.taskSpec,
        // On a mixed grounding verdict the scan-scope directive rides in as a SYNTHETIC dep output.
        // The recorded plan is untouched (init.step stays as approved) and nothing can collide: the
        // analyze step's dependsOn is [], so the port built depOutputs from an empty list, and
        // loop.ts renders every depOutputs entry verbatim under '# Upstream outputs'.
        depOutputs: grounding
          ? { ...init.depOutputs, grounding: groundingDirective(grounding.verdict, grounding.scope) }
          : init.depOutputs,
        skills: init.skills,
        extraTools,
        model,
        runToken,
        origin: args.origin,
        workspaceDir,
        taskId: args.taskId,
        memoryPreloadTokens: config.memoryPreloadTokens,
        ...(stepMemory && { memory: stepMemory }),
        ...(stepKnowledge && { knowledge: stepKnowledge }),
        // prices usage drafts on the way through: fill costUSD from the provider table
        checkpoint: (name, fn, toEvents) =>
          checkpoint(name, fn, toEvents ? r => toEvents(r).map(d => priceDraft(d, provider, modelId)) : undefined),
        operation: (spec, fn, toEvents) =>
          operation(spec, fn, toEvents ? r => toEvents(r).map(d => priceDraft(d, provider, modelId)) : undefined),
        // Enforce spend at the point it happens across the whole ancestor chain (projections.remainingBudget):
        // grants are clamped at propose time but never reserved, so without an ancestor check N sibling splits
        // could each spend the full parent budget. min-over-ancestors shares it by construction.
        budgetRemainingUSD: async () => remainingBudget(await projectState(), args.taskId),
        isCancelled: async () => (await projectState()).tasks.get(args.taskId)?.status === TASK_STATUS.cancelled,
      }

      // splitIds already handed to a previous gate in THIS workflow. Rebuilds correctly on
      // replay because each gate:targets checkpoint replays its recorded value in order. Shared
      // across continuation rounds: a split consumed in round 0 must not be re-offered in round 1.
      const consumed = new Set<string>()
      // the runtime's continuation verdict, recorded per round — an enum, not bare strings, so
      // the checkpoint value and every comparison spell it once
      enum ContinuationGrant { auto = 'auto', ask = 'ask' }
      // ONE round of the executor: drive a fresh generator to its signal/error. Rounds exist
      // because `partial` ends a round without ending the step — the runtime then grants (or the
      // human gate allows) another. Round > 0 gets the previous round's summary as its whole
      // context (ExecutorContext.continuation), and its checkpoint names and operation ids carry a
      // round prefix: the loop names them by ITERATION, which restarts at 1 every round, and a
      // reused key replays round 0's recorded model call as round 1's answer. The journal reuses
      // by `operationId`; `name` is the model ref the operator reads, so it stays untouched.
      const driveRound = async (round: number, prevSummary: string | null): Promise<{ signal: Signal | null; error: { class: FailureClass; message: string } | null }> => {
      // a holder, not two `let`s: the callback below assigns these, and TS control-flow can't see a
      // closure assignment — a plain `let signal` would narrow to `null` at the reads after the drive
      const collected: { signal: Signal | null; error: { class: FailureClass; message: string } | null } = { signal: null, error: null }
      const roundName = (name: string): string => round === 0 ? name : `r${round}:${name}`
      const roundCtx: typeof ctx = round === 0 ? ctx : {
        ...ctx,
        checkpoint: (name, fn, toEvents) => ctx.checkpoint(roundName(name), fn, toEvents),
        operation: (spec, fn, toEvents) => ctx.operation({ ...spec, operationId: roundName(spec.operationId) }, fn, toEvents),
        continuation: { round, summary: prevSummary ?? '' },
      }
      const gen = executor.startTurn(roundCtx)
      // driveGenerator guarantees gen.return() in a finally, so loop.ts's OWN finally
      // (releaseWriteClaims) runs even when the PORT throws while the generator is suspended at a
      // gate (a cancelled recv, a checkpoint failure). An abandoned async generator's finally never
      // runs, so the step's write-claims would leak and poison later retries in a long-lived port
      // process (graph-ui server, mcp serve). The callback returns the value to resume with.
      await driveGenerator(gen, async ev => {
        if (ev.type === UnifiedEventType.signal) { collected.signal = ev.signal; return undefined }
        if (ev.type === UnifiedEventType.error) { collected.error = { class: ev.class, message: ev.message }; return undefined }
        if (ev.type === UnifiedEventType.gate) {
          // Resolve targets in a checkpoint (log read = non-deterministic). Default = every
          // split proposed by THIS step attempt that this workflow has not already consumed;
          // an explicit request is intersected with that set so an unknown or foreign id —
          // which can never receive a message and would wedge recv forever (no gate timeout in
          // v1) — is dropped. Empty intersection resumes with [] immediately.
          //
          // `resolved` is NOT the consumed marker: the router appends split_resolved and THEN
          // sends, so a split that resolved before the parent reached its gate is precisely the
          // one with a message waiting. Filtering on it dropped the child's summary and notes —
          // the whole payload of the split protocol — whenever a child outran its parent.
          const targets = await checkpoint(`gate:targets:${ev.toolCallId}`, async () => {
            const state = await foldState(args.taskId)
            const own = [...state.splits.values()]
              .filter(s => s.stepId === args.stepId && s.runToken === runToken && !consumed.has(s.splitId))
              .map(s => s.splitId)
            if (ev.splitIds.length === 0) return own
            const ownSet = new Set(own)
            return ev.splitIds.filter(id => ownSet.has(id))
          })
          for (const id of targets) consumed.add(id)
          const results: SplitResult[] = []
          for (const id of targets) {
            // workflow context — recv is legal here and ONLY here (spec D9).
            // Long poll, loop forever: no gate timeout in v1; recv replays from DBOS's message log.
            // The timeout is NOT a responsiveness knob — every recv records a durable row even on
            // expiry, and recovery replays each one sequentially, so a short poll bills a parked
            // gate by wall-clock time (60s => ~1,440 rows overnight). Cancellation is unaffected:
            // sysdb.recv re-checks it every dbPollingIntervalEventMs (10s) regardless.
            let msg: SplitResult | null = null
            while (msg === null) msg = await DBOS.recv<SplitResult>(`split:${id}`, GATE_POLL_SECONDS)
            results.push(msg)
          }
          return results
        }
        if (ev.type === UnifiedEventType.feedback) {
          await checkpoint(`feedback:req:${ev.toolCallId}`, async () => 0, () =>
            [{ kind: EVENT_KIND.feedback_requested, payload: { question: ev.question, topic: ev.topic } }])
          // ponytail: long poll, loop forever — no gate timeout in v1 (mirrors the split gate); cancel is the escape
          let msg: string | null = null
          while (msg === null) msg = await DBOS.recv<string>(`feedback:${ev.topic}`, GATE_POLL_SECONDS)
          return msg
        }
        return undefined
      })
      return collected
      }

      // The continuation loop (the A+B synthesis): the agent REPORTS `partial`, the runtime
      // GRANTS. Auto-continue while the ancestor budget has room and the round cap allows;
      // past either, the ask escalates to the standing human gate (feedback_requested — the
      // same machinery ask_human parks on, answered by `orc reply`, the web console or MCP).
      // There is deliberately no request_iterations tool: an agent asked whether it wants more
      // budget always says yes, so the grant lives where spend is already enforced.
      let round = 0
      let { signal, error } = await driveRound(round, null)
      while (signal?.outcome === SignalOutcome.partial) {
        const partialSummary = signal.summary
        // Grant in a checkpoint: the budget read folds the log, which moves between run and
        // replay — an unrecorded verdict could auto-continue live and gate on recovery, forking
        // the workflow's history at the exact seam this file exists to keep deterministic.
        const grant = await checkpoint(`continue:grant:${round}`, async (): Promise<ContinuationGrant> => {
          if (round + 1 > MAX_AUTO_CONTINUATIONS) return ContinuationGrant.ask
          const remaining = await ctx.budgetRemainingUSD()
          // null = no budget configured anywhere in the chain — the round cap is the only brake
          return remaining === null || remaining > 0 ? ContinuationGrant.auto : ContinuationGrant.ask
        })
        if (grant !== ContinuationGrant.auto) {
          const topic = continuationTopic(args.stepId, round)
          await checkpoint(`continue:ask:${round}`, async () => 0, () => [{
            kind: EVENT_KIND.feedback_requested,
            payload: {
              question: `step '${args.stepId}' signalled 'partial' after ${round + 1} round(s) and its auto-continue allowance is exhausted (${round + 1 > MAX_AUTO_CONTINUATIONS ? 'round cap reached' : 'budget spent'}). It reports: ${partialSummary} — reply 'approve' to grant another round; anything else stops the step here.`,
              topic,
            },
          }])
          // same long-poll shape as the ask_human gate above, same reasons
          let answer: string | null = null
          while (answer === null) answer = await DBOS.recv<string>(`feedback:${topic}`, GATE_POLL_SECONDS)
          if (!isApprovalAnswer(answer)) {
            // The HUMAN stopped it — a decision, not a malfunction, so it must not read as one:
            // human_abort routes the operator to the summary (which says what remains), never to
            // a retry loop that would re-ask the same question.
            await checkpoint('finish', async () => answer, () => [{
              kind: EVENT_KIND.step_failed,
              payload: { stepId: args.stepId, runToken, class: FailureClass.human_abort, message: `continuation declined: ${answer}. Last partial report: ${partialSummary}` },
            }])
            return { stepId: args.stepId, ok: false }
          }
        }
        round += 1
        ;({ signal, error } = await driveRound(round, partialSummary))
      }

      if (signal?.outcome === SignalOutcome.success) {
        const success = signal // closures below see the narrowed binding
        // verify declared outputs at the trusted boundary; receipts and step_completed
        // commit in ONE transaction — a completed step can never lack its receipts.
        // If the completion already committed (crash before DBOS recorded the step result),
        // skip re-verification: the workspace may have changed since, and re-hashing would
        // conflict with the committed receipts and flip a durable success into failed.
        await checkpoint('finish', async () => {
          const events = await log.byTask(args.taskId)
          const committed = events.some(e => e.kind === EVENT_KIND.step_completed && e.runToken === runToken)
          if (committed) return null
          // A step's declared outputs are not the only thing a success can be missing: a strategy
          // step that skipped the artifact the strategy exists to produce is just as false a
          // success, and just as invisible downstream. Same boundary, same refusal.
          const omission = groundedPlanOmission(events, args.stepId, runToken)
          if (omission) throw classifiedError(FailureClass.validation_error, omission)
          try {
            return verifyArtifacts(workspaceDir, success.outputs ?? [])
          } catch (err) {
            throw classifiedError(FailureClass.validation_error, errorMessage(err))
          }
        }, receipts => receipts === null ? [] : [
          ...receipts.map((r): EventDraft => ({
            kind: EVENT_KIND.artifact_produced,
            payload: { path: r.path, sha256: r.sha256, size: r.size },
            idempotencyKey: `${runToken}:artifact:${r.path}`,
          })),
          {
            kind: EVENT_KIND.step_completed,
            // The plan step's grounding is COMPLETE BY CONSTRUCTION on a mixed run: depOutputs
            // [analyze] is this summary, and the port appends the reused notes (ids@revisions +
            // the compared HEAD) and the fact that only the scoped paths were re-scanned from the
            // RECORDED verdict — whether or not the scout thought to mention them.
            payload: { stepId: args.stepId, runToken, summary: grounding ? `${success.summary}\n\n${reusedCitation(grounding.verdict, grounding.scope)}` : success.summary },
            // stable key: never positional — the receipt count must not shift it
            idempotencyKey: `${runToken}:finish:step_completed`,
          },
        ])
        return { stepId: args.stepId, ok: true }
      }
      // A signalled failure from an AUDITOR is a VERDICT, not a malfunction: that role judges work
      // OTHER steps produced, and retry re-runs only what did not complete — so it would meet the
      // same completed siblings and reach the same conclusion, forever (measured: three identical
      // audit passes). `rejected` routes the operator to replan instead of a retry that cannot win.
      //
      // The role test is load-bearing, not decoration. Any step signals `failure` when it does not
      // succeed, and for a WORKER a fresh attempt genuinely re-does its own work — a different
      // outcome is exactly what retry is for. Treating every signalled failure as a verdict broke
      // that: it refused the retry of a worker that would have succeeded on its next attempt.
      const failClass = signal
        ? (init.step.role === STEP_ROLE.auditor ? FailureClass.rejected : FailureClass.agent_error)
        : (error?.class ?? FailureClass.agent_error)
      const message = signal ? signal.summary : (error?.message ?? 'executor ended without signal')
      await checkpoint('finish', async () => message, () => [
        { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: failClass, message } },
      ])
      return { stepId: args.stepId, ok: false }
      } catch (err) {
        return finishFailed(checkpoint, args, runToken,
          errorMessage(err),
          failureClassOf(err) ?? FailureClass.agent_error)
      }
    },
    { name: 'orcStep' },
  )

  const runWorkflow = DBOS.registerWorkflow(
    async (args: RunArgs): Promise<RunOutcome> => {
      const workflowId = workflowIdOrThrow()
      const checkpoint = makeCheckpoint(args.taskId, null, workflowId, args.origin) // run-level events carry no stepId

      try {
        const init = await checkpoint('init', async () => {
          const state = await foldState(args.taskId)
          const task = state.tasks.get(args.taskId)
          const plan = state.plans.get(args.taskId)?.versions.find(p => p.version === args.planVersion)
          if (!task || !plan) throw classifiedError(FailureClass.validation_error, `no task/plan v${args.planVersion} for '${args.taskId}'`)
          // run_started + the running-transition commit in ONE transaction inside fn, NOT the
          // toEvents draft path: the status change depends on foldable state, and a fixed-key draft
          // that re-derives {from: task.status} on recovery flips to {from: running} (its own
          // committed event), conflicts under the same key, and bricks the task at 'running' with an
          // ERROR workflow retry cannot resume. Mirror the finish checkpoint — append run_started
          // idempotently and stamp running only while the status is still pre-run (also no-ops
          // cleanly if an orc cancel raced in).
          await log.transaction(tx => appendRunInit(tx, args, workflowId))
          return { plan, done: [...completedStepIds(state, args.taskId)], attempts: nextAttempts(state, args.taskId, plan), depth: task.depth }
        })

        const plan: Plan = init.plan
        const done = new Set(init.done)
        const failed = new Set<string>()
        const started = new Set(init.done)

        // Wave scheduling: launch every ready step IN PLAN ORDER, await the whole wave, then
        // recompute readiness. Launch order is therefore a pure function of (plan, done, failed)
        // — identical on the first run and on every replay.
        //
        // It has to be. DBOS binds child workflows POSITIONALLY, not by the workflowID argument:
        // a replayed startWorkflow looks up (callerID, callerFunctionID) and returns a handle to
        // whatever child is recorded at that slot (dbos-executor.js internalWorkflow), ignoring
        // the id we asked for. The previous continuous scheduler launched dependents from inside
        // a Promise.race settle loop, so first-run order followed real completion timing while
        // replay order followed Map insertion order — two steps could swap slots, each receive
        // the other's handle, and the loop would then spin forever on an already-resolved promise
        // with the task pinned 'running'. See resume.test.ts's two-independent-step case.
        //
        // Cost, knowingly paid: a fast step's dependents now wait for its whole wave. Keeping
        // continuous scheduling would need DBOS's startWfFuncId, which DBOS.startWorkflow does
        // not expose.
        for (;;) {
          const wave = readySteps(plan, done, failed, started)
          if (wave.length === 0) break
          const results: Promise<StepResult>[] = []
          for (const s of wave) {
            started.add(s.id)
            const handle = await DBOS.startWorkflow(stepWorkflow, {
              workflowID: stepWorkflowId(args.taskId, s.id, init.attempts[s.id] ?? 1),
              queueName: agentQueue(init.depth),
            })({ taskId: args.taskId, stepId: s.id, planVersion: args.planVersion, attempt: init.attempts[s.id] ?? 1, cwd: args.cwd, origin: args.origin })
            results.push(handle.getResult())
          }
          for (const r of await Promise.all(results)) (r.ok ? done : failed).add(r.stepId)
        }

        const outcome = runOutcomeOf(plan, done)
        await checkpoint('finish', async () => {
          await stampIfRunning(log, args.taskId, outcome === RunOutcome.done ? TASK_STATUS.done : TASK_STATUS.blocked, workflowId, 'finish', args.origin)
          return { outcome }
        })
        return outcome
      } catch (err) {
        // Containment (mirrors stepWorkflow's try/catch): an uncaught run-workflow error must not
        // strand the task 'running' with a burned ERROR workflow that orc retry re-attaches to and
        // rethrows forever. Stamp running→blocked — the state retry resumes from — under the same
        // locked re-check. Best-effort: if containment itself can't run (e.g. the workflow was
        // cancelled), surface the original error and let cancelOne own the terminal status.
        try {
          await checkpoint('contain', async () => {
            await stampIfRunning(log, args.taskId, TASK_STATUS.blocked, workflowId, 'contain', args.origin)
            return { contained: true }
          })
        } catch { /* best-effort containment — original error still propagates */ }
        throw err
      }
    },
    { name: 'orcRun' },
  )

  // Index 0 is the FIRST run of an approved plan, and its workflow id is deterministic — which is
  // what makes `orc run` on a LIVE task attach to the run already in flight instead of starting a
  // second one. But a run that ENDED keeps that id too: runWorkflow returns RunOutcome.blocked as
  // a normal return, so DBOS marks the workflow SUCCESS. Re-running then re-attached to a finished
  // workflow and replayed its cached result — `orc run` on a blocked task was admitted at every
  // door (blocked is drivable) and silently did nothing.
  //
  // `running` is the only status where attaching is what the caller wants; `blocked` and a
  // re-approved `approved` both mean the previous run settled, so the next one needs its own index.
  // Read from the FOLD, not from DBOS: the log is the source of truth for whether a run is live,
  // and nextRetryIndex is the derivation `orc retry` and the router already share.
  async function runIndexFor(taskId: string, status: string): Promise<number> {
    if (status === TASK_STATUS.running) {
      const latest = (await foldState(taskId)).runs.get(taskId)?.at(-1)
      if (latest) return latest.retryIndex
    }
    return nextRetryIndex(taskId)
  }

  async function startRunAt(taskId: string, retryIndex: number, cwd?: string): Promise<RunHandle> {
    // Admission is a decision, not an advisory read, so it must NOT come from the live index: an
    // approve lands microseconds before the router asks, and a stale view refuses a run that is
    // legitimately drivable. Both reads are byTask — indexed and bounded, never the whole log.
    const state = await foldState(taskId)
    const task = state.tasks.get(taskId)
    if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
    // a child's cwd is derived from its PARENT's run history, which byTask(taskId) cannot see
    const cwdState = task.parentId ? await foldState(task.parentId) : state
    const approved = state.plans.get(taskId)?.approvedVersion
    if (!approved || (task.status !== TASK_STATUS.approved && task.status !== TASK_STATUS.running && task.status !== TASK_STATUS.blocked))
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — approve a plan first (orc approve ${taskId})`)
    const workflowID = retryIndex === 0 ? `run:${taskId}:v${approved}` : `run:${taskId}:v${approved}:r${retryIndex}`
    const handle = await DBOS.startWorkflow(runWorkflow, { workflowID, ...runQueueOptions(task.depth) })({
      // A run with no explicit cwd works on the PROJECT, not in an empty scratch dir: a per-step
      // scratch default gave every step a directory with nothing in it — a workspace no repo task
      // can succeed in (a verify auditor burned five attempts on it, each ENOENT-blind). Explicit
      // --cwd still overrides; projections.runCwd is the ONE rule,
      // shared with startChildRun, so the whole run tree stays in one world no matter which of
      // the two paths reached the child's (deterministic, shared) workflow id first.
      taskId, planVersion: approved, retryIndex, cwd: runCwd(cwdState, task, cwd, config.dir),
      // the run's own workflow id IS its chat — a retry gets a new id, so it opens a new one
      origin: runOrigin(workflowID),
    })
    return { workflowId: workflowID, wait: () => handle.getResult() }
  }

  // The retry-index derivation (was inline in port.retry), shared with the router's
  // onRunRequested reaction so a redelivered run_requested{retry:true} and a direct `orc retry`
  // can never disagree about which index a retry lands at.
  async function nextRetryIndex(taskId: string): Promise<number> {
    const runs = (await foldState(taskId)).runs.get(taskId) ?? []
    return runs.length === 0 ? 0 : Math.max(...runs.map(r => r.retryIndex)) + 1
  }

  // The DBOS half of ONE task's cancellation: DBOS cancel does NOT cascade by
  // default, so cancel EVERY non-completed step's deterministic workflow (catches
  // enqueued-but-not-yet-dequeued steps too), then the run. No status append and no subtree walk
  // — kernel.cancelSubtree owns both, appending across the whole subtree BEFORE this runs. Called
  // for every task a cancel stamps, including ones that never ran (a gated child still at
  // awaiting_approval), so "no run" is a clean no-op rather than a throw.
  async function cancelWorkflowsFor(taskId: string): Promise<void> {
    const state = await foldState(taskId)
    const latest = state.runs.get(taskId)?.at(-1)
    const approved = state.plans.get(taskId)?.approvedVersion
    const plan = state.plans.get(taskId)?.versions.find(p => p.version === approved)
    if (plan) {
      const done = completedStepIds(state, taskId)
      // startedAttempts, NOT nextAttempts: cancel targets the attempt that is RUNNING. nextAttempts
      // answers "which attempt starts next" and returns attempt+1 once the task is settled — and
      // cancelSubtree has already stamped `cancelled` by the time this runs, so every id it gave
      // was one ahead of the live workflow and the cancel silently missed.
      const attempts = startedAttempts(state, taskId, plan)
      for (const s of plan.steps) {
        const attempt = attempts[s.id]
        // a step that never started has no workflow to cancel — omitted rather than guessed at
        if (done.has(s.id) || attempt === undefined) continue
        await DBOS.cancelWorkflow(stepWorkflowId(taskId, s.id, attempt)).catch(() => {})
      }
    }
    // A run that is still ENQUEUED has no run_started — that event is written from INSIDE the
    // workflow — so reading the id out of the log missed exactly the runs a cancel most needs to
    // stop: past the depth concurrency cap, a queued child would later dequeue and execute its
    // whole plan against a task already stamped cancelled. The id is deterministic, so derive it
    // (retryIndex 0: a run with no recorded start is by definition the first).
    const workflowId = latest?.workflowId ?? (approved ? `run:${taskId}:v${approved}` : null)
    if (!workflowId) return
    // a cancel failure here must surface to the caller, NOT be recorded as a successful
    // cancellation. DBOS.cancelWorkflow on an already-cancelled or already-finished workflow is
    // itself a no-op, which is what makes it
    // safe for both the direct caller below AND the router's async onCancelled to land here.
    await DBOS.cancelWorkflow(workflowId)
  }

  // DBOS recovers pending workflows for its own executorID alone and defaults every process to
  // 'local', so two runtimes recovered each other's in-flight steps and both ran them (see
  // storage/runtime-lock.ts). setConfig is the ONLY channel that works: globalParams.executorID is
  // computed at module-import time from DBOS__VMID, so assigning that env var inside launch() lands
  // after DBOS has already frozen it — verified against workflow_status.executor_id, which stayed
  // 'local' the whole way through a kill-9/respawn.
  const executorId = opts.executorId ?? 'local'

  let runtimeLock: RuntimeLock | null = null
  const port: DbosPort = {
    executorId,
    projectState,
    launch: async () => {
      // before DBOS: recovery is what makes a second runtime destructive, so refuse to become one
      runtimeLock = await acquireRuntimeLock(config.databaseUrl, config.projectId)
      live = await openLiveState(log)
      // DBOS__APPVERSION pinned from config BEFORE launch so recovery survives rebuilds
      process.env.DBOS__APPVERSION ??= config.appVersion
      DBOS.setConfig({
        name: `orc-${projectSuffix(config.projectId).slice(0, 12)}`,
        systemDatabaseUrl: config.systemDatabaseUrl, logLevel: 'warn', runAdminServer: false,
        executorID: executorId,
      })
      await DBOS.launch()
      // ADAPTATION: registerQueue requires DBOS already launched in @dbos-inc/dbos-sdk v4.23 (see report)
      for (let d = 0; d <= config.maxDepth; d++) {
        await DBOS.registerQueue(agentQueue(d), { concurrency: config.concurrency, workerConcurrency: config.concurrency })
        if (d > 0) await DBOS.registerQueue(runQueue(d), { concurrency: config.concurrency, workerConcurrency: config.concurrency })
      }
      await router.start()
    },
    // deregister clears the workflow/queue registries so a fresh port can re-register in the
    // same process — required when >1 port is created per process (integration tests); a no-op
    // at real process exit. (DBOS docs: use deregister when re-registering functions.)
    shutdown: async ({ drain = true } = {}) => {
      try {
        await router.close()
        // Draining means "wait for in-flight workflows". A workflow parked at a human gate looks
        // in-flight to DBOS but is durable state waiting on a person, so draining waits out the
        // gate's poll — an hour — while holding the runtime lock, which makes the gate unanswerable
        // by anyone else. A long-lived server drains; a command that is exiting anyway does not.
        if (drain) await DBOS.shutdown({ deregister: true })
      } finally {
        await live?.close()
        live = null
        await runtimeLock?.release()
        runtimeLock = null
      }
    },
    // The router's entry point for an approved child. Deterministic workflow id: at-least-once
    // delivery means this may be called more than once, and it attaches idempotently. It is
    // startRunAt with no override — the same id, the same queue and, crucially, the same cwd rule
    // as the CLI's child-follow, which races it for that id.
    startChildRun: async (childTaskId: string): Promise<void> => { await startRunAt(childTaskId, 0) },
    startRun: async (taskId, o) => startRunAt(taskId, await runIndexFor(taskId, (await foldState(taskId)).tasks.get(taskId)?.status ?? ''), o?.cwd),
    retry: async (taskId, o) => {
      const state = await foldState(taskId)
      const task = state.tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      // The port half of assertRetryable's refusal, off the SAME predicate — enforced here too
      // because the router reaches startRunAt without passing the actions layer at all. canRetry is
      // the decision; the branches below only pick which refusal to explain.
      if (!canRetry(state, taskId)) {
        if (task.status !== TASK_STATUS.blocked)
          throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — only a blocked task can be retried`)
        // A verdict cannot be argued with by repeating the step that reached it.
        const verdicts = blockingVerdicts(state, taskId)
        throw new KernelError(
          KERNEL_ERROR_CODE.invalid_transition,
          `this run was rejected, not broken — ${verdicts.map(v => `'${v.stepId}'`).join(', ')} judged the work unacceptable. `
          + `Revise the plan and approve a new version; a retry would reach the same verdict.`,
        )
      }
      const runs = state.runs.get(taskId) ?? []
      // A retry re-enters the world the run failed in: shared rule (projections.inheritedCwd) — an
      // explicit override wins, else inherit the most recent run that HAD a cwd (not at(-1), so a
      // null-cwd retry from before the project-dir default cannot poison inheritance), else the project dir.
      const cwd = inheritedCwd(runs, o?.cwd, config.dir)
      return startRunAt(taskId, await nextRetryIndex(taskId), cwd)
    },
    cancelRun: async (taskId, origin) => {
      const task = (await foldState(taskId)).tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      if (task.status !== TASK_STATUS.running && task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — only a running or blocked task can be cancelled`)
      // kernel.cancelSubtree appends cancelled across the whole subtree (children before parent —
      // see its own comment); this port then does the DBOS half itself for every task it stamped,
      // rather than waiting on the live router to notice. The router's onCancelled reaction does
      // the same idempotent work off the SAME events, so a cancel issued here is never double-charged.
      // The canceller's origin: a cancel is identity like any other append. cancelSubtree stamps a
      // RUNNING task inside that run's chat regardless — the end of a run is read there.
      const stamped = await kernel.cancelSubtree(taskId, origin)
      for (const id of stamped) await cancelWorkflowsFor(id)
    },
  }

  // port-level: child-terminal events → split_resolved + DBOS.send; approved children → run start;
  // run_requested → start (the explicit ask); a cancelled status → finish the DBOS half a
  // port-less client cannot do itself.
  // References port.startChildRun, so it is built after the port object.
  const router = createSignalRouter({
    log,
    onChildApproved: id => port.startChildRun(id),
    onRunRequested: async (taskId, o) => { await startRunAt(taskId, o.retry ? await nextRetryIndex(taskId) : 0, o.cwd ?? undefined) },
    onCancelled: cancelWorkflowsFor,
    ...(opts.onCommitRecorded && { onCommitRecorded: opts.onCommitRecorded }),
    send: (dest, result, topic, key) => DBOS.send(dest, result, topic, key),
    sendFeedback: dbosSend,
  })

  return port
}

// The two completion events a SKIPPED analyze step owes, built purely from the recorded verdict —
// nothing here re-reads git or the store, which is what makes the drafts replay-identical.
//
// EVIDENCE (why `orc log` can answer "why did it skip?" without re-running anything): every scope
// entry names one note id, the sourceRevision it was written at, and the HEAD sha the gate compared
// against, plus the human-readable `why`. The same ids and shas are repeated in the step_completed
// summary, because the plan step reads ONLY that summary (depOutputs[analyze]).
//
// analyzed: TRUE, deliberately. analyzed+gaps are load-bearing for RG7 degradation, and the
// question that flag has to answer downstream is "does this task have grounding?" — not "did a
// model burn tokens this run?". A skipped-but-grounded task HAS grounding: named notes, verified
// current at a named HEAD. Reporting analyzed:false would make it indistinguishable from a task
// where analysis genuinely never happened, and would degrade a task that is better grounded than
// most. What marks it as a skip instead is claimsWritten:0, the leading gaps entry, and confidence
// 'medium' rather than 'high' — the evidence is real but indirect (git says the declared paths are
// quiet), so it is honestly one notch below a scan performed against the tree this run.
function groundingSkipDrafts(v: GroundingVerdict, stepId: string, runToken: string): EventDraft[] {
  const ids = v.current.map(c => c.id)
  const summary =
    `Reused existing grounding — the deep codebase scan was SKIPPED because these notes are current at HEAD ${v.head}: `
    + `${v.current.map(c => `${c.id} (written at ${c.revision}; ${c.why})`).join('; ')}. `
    + `No new analysis was performed and no notes were written this run. `
    + `memory_read ${ids.join(', ')} before planning — they are this step's entire output and the plan's grounding.`
  return [
    {
      kind: EVENT_KIND.analysis_completed,
      payload: {
        analyzed: true,
        scope: v.current.map(c => `${c.id}@${c.revision} current at HEAD ${v.head} — ${c.why}`),
        gaps: [
          `deep scan skipped this run: coverage is exactly what these notes already declare, verified against HEAD ${v.head} (${v.reason})`,
          ...v.stale.map(s => `${s.id}@${s.revision ?? 'no-revision'} not relied on — ${s.why}`),
        ],
        confidence: Confidence.medium,
        claimsWritten: 0,
      },
      idempotencyKey: `${runToken}:grounding:analysis_completed`,
    },
    {
      kind: EVENT_KIND.step_completed,
      payload: { stepId, runToken, summary },
      idempotencyKey: `${runToken}:grounding:step_completed`,
    },
  ]
}

function priceDraft(d: EventDraft, provider: ModelProvider<unknown>, modelId: string): EventDraft {
  if (!d.usage || d.usage.costUSD !== null) return d
  const costUSD = costUSDFor(provider.costs, modelId, d.usage.inputTokens, d.usage.outputTokens,
    { readTokens: d.usage.cacheReadTokens, writeTokens: d.usage.cacheWriteTokens })
  return { ...d, usage: { ...d.usage, costUSD, estimated: d.usage.estimated || costUSD === null } }
}

async function finishFailed(
  checkpoint: Checkpoint, args: StepArgs, runToken: string, message: string,
  cls: FailureClass = FailureClass.agent_error,
): Promise<StepResult> {
  await checkpoint('finish', async () => message, () => [
    { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: cls, message } },
  ])
  return { stepId: args.stepId, ok: false }
}
