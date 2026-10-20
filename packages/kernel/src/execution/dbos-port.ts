import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  EVENT_KIND, FailureClass, MAX_AUTO_CONTINUATIONS, RunOutcome, SignalOutcome, STEP_ROLE, TASK_STATUS, UnifiedEventType,
  ChatRef, PAYLOAD_SCHEMAS,
  classifiedError, continuationTopic, errorMessage, failureClassOf, isApprovalAnswer, isTerminalError, resolveModel, costUSDFor,
  type AgentExecutor, type Checkpoint, type CommitRecordedPayload, type EventDraft, type EventRecord, type ExecutionPort, type ExecutorContext,
  type Origin, type TaskNode,
  type LoadedSkill, type ModelProvider, type OperationCheckpoint, type Plan, type PlanStep,
  type ResolvedTool, type RunHandle, type Signal, type SplitResult, type StepKnowledge, type TaskStatus, type ToolSource,
} from '@orc/contracts'
import { type EventLog, type Storage, type EventLogOps } from '../storage'
import { openLiveState, type LiveState } from '../live-state'
import { acquireRuntimeLock, type RuntimeLock } from '../storage/runtime-lock'
import { groundedPlanOmission } from './strategies/grounded-plan'
import { verifyArtifacts } from './artifacts'
import { runChatOpened, runOrigin } from './run-chat'
import { fold, ancestorTaskIds, blockingVerdicts, canRetry, completedStepIds, nextAttempts, startedAttempts, remainingBudget, inheritedCwd, runCwd, type State } from '../projections'
import { Kernel } from '../kernel'
import { KERNEL_ERROR_CODE, KernelError } from '../errors'
import { readySteps, runOutcomeOf } from './interpreter'
import { createSignalRouter } from './signal-router'
import { projectSuffix, type ProjectConfig } from '../config'

export interface DbosPort extends ExecutionPort {
  /** Executor identity: DBOS reads it only via setConfig({ executorID }); recovery scopes to it. */
  executorId: string
  /** Folded state from the live index once launched; advisory reads only (see LiveState). */
  projectState(): Promise<State>
  launch(): Promise<void>
  // drain:false skips DBOS quiescing: a gate-parked workflow is durable state, not in-flight work.
  shutdown(opts?: { drain?: boolean }): Promise<void>
  startChildRun(childTaskId: string): Promise<void>
}

// Depth-partitioned queues: a gate-waiting parent cannot starve the children it waits on.
const agentQueue = (depth: number): string => `agents:${depth}`
const runQueue = (depth: number): string => `runs:${depth}`

// depth 0 stays unqueued: runQueue(0) is never registered
export const runQueueOptions = (depth: number): { queueName?: string } =>
  depth > 0 ? { queueName: runQueue(depth) } : {}

// Gates park for hours and each recv expiry writes durable rows that recovery replays in order.
const GATE_POLL_SECONDS = 3_600


// origin is the RUN's, never the step workflow's: one run is one chat.
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

// Lets callers outside a workflow (the CLI's reply) resume a recv gate; DBOS must be launched.
export const dbosSend = (workflowId: string, message: string, topic: string, idempotencyKey: string): Promise<void> =>
  DBOS.send(workflowId, message, topic, idempotencyKey)

// Re-checks status in the SAME transaction, so a DBOS re-executed init is a clean no-op.
export async function appendRunInit(tx: EventLogOps, args: RunArgs, workflowId: string): Promise<void> {
  const events = await tx.byTask(args.taskId)
  const task = fold(events).tasks.get(args.taskId)
  if (!task) throw classifiedError(FailureClass.validation_error, `no task '${args.taskId}'`)
  // BEFORE run_started, keyed by chat id: a replayed init opens no second chat.
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

// The causing event in another chat: a split child's split_proposed, else the newest run_requested.
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

// Set `to` on a still-'running' task in ONE locked transaction (a read-then-append races cancel).
async function stampIfRunning(log: EventLog, taskId: string, to: TaskStatus, workflowId: string, name: string, origin: Origin): Promise<void> {
  await log.transaction(async tx => {
    const status = fold(await tx.byTask(taskId)).tasks.get(taskId)?.status
    if (status !== TASK_STATUS.running) return // a cancel already set a terminal status
    await tx.append({
      ...origin, taskId, stepId: null, runToken: workflowId, kind: EVENT_KIND.task_status_changed,
      payload: { taskId, from: TASK_STATUS.running, to },
      idempotencyKey: `${workflowId}:${name}:task_status_changed`,
    })
  })
}

// Drives a generator, always calling gen.return() in a finally so its own finally runs on any exit.
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
  // The per-step plugin surface; `step` travels whole so a binding reads title/dependsOn itself.
  stepTools?: (p: {
    // the RUN's chat, so a tool that spawns a process or writes a claim names the same interaction
    origin: Origin
    taskId: string; stepId: string; runToken: string; role: string; executor: string; model: string
    modelRef: string; maxIterations: number; workspaceDir: string; step: PlanStep
    // Here, not the composition root: only the port knows which task is running.
    workspaceId: string
    // nearest first (parent, …, root) — a split child's decomposition lives in its PARENT's scopes
    ancestorTaskIds: string[]
  }) => ResolvedTool[] | { tools: ResolvedTool[]; knowledge?: StepKnowledge }
  // The auto-heal reactor; absent, commits stay traceability records.
  onCommitRecorded?: (payload: CommitRecordedPayload) => Promise<void>
  executorId?: string
}): Promise<DbosPort> {
  const { config, providers, executors, skills, tools, stepTools } = opts
  const { events: log, operations: journal, redact } = opts.storage
  // cancelSubtree's append half only; this port stays the DBOS half (cancelWorkflowsFor).
  const kernel = new Kernel(log)

  // DBOS persists every step return in its own table, NOT behind EventLog.append's redaction.
  const redactStepResult = <T>(r: T): T => redact.value(r)

  const foldState = async (taskId: string): Promise<State> => fold(await log.byTask(taskId))

  // Whole-project reads byTask cannot answer: advisory; a null throws rather than scan the log.
  let live: LiveState | null = null
  const projectState = async (): Promise<State> => {
    if (!live) throw new Error('projectState requires a launched port')
    return live.current()
  }

  // terminal errors (e.g. a 4xx model failure) must NOT retry — see terminalError in @orc/contracts
  const RETRY_POLICY = { retriesAllowed: true, maxAttempts: 4, intervalSeconds: 1, backoffRate: 2, shouldRetry: (e: unknown) => !isTerminalError(e) }

  // one transaction per batch, each draft under a deterministic key: a crash retry never duplicates
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

  // before-record commits ahead of the external effect; recovery short-circuits on a completed node
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

      // ANY throw (init included) becomes step_failed, never a task stuck 'running' on an ERROR workflow
      try {
      // checkpointed init: event-log reads are non-deterministic, so they must be a step
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
        const previous = state.steps.get(args.taskId)?.get(args.stepId)
        const priorFailure = previous?.failure ? { attempt: previous.attempt, ...previous.failure } : null
        const loadedSkills: LoadedSkill[] = []
        for (const ref of step.skillRefs) {
          if (!skills) throw classifiedError(FailureClass.validation_error, `step declares skill '${ref}' but no skill index is configured`)
          try {
            loadedSkills.push(await skills.load(ref))
          } catch (err) {
            throw classifiedError(FailureClass.validation_error, `skill '${ref}': ${errorMessage(err)}`)
          }
        }
        // workspaceId travels with the spec: the workflow body cannot read the log (non-deterministic)
        return { step, taskSpec: task.spec, workspaceId: task.workspaceId, budgetUSD: task.budgetUSD, depOutputs, skills: loadedSkills, priorFailure }
      }, r => [
        { kind: EVENT_KIND.step_started, payload: { stepId: args.stepId, runToken, attempt: args.attempt } },
        ...r.skills.map((s): EventDraft => ({
          kind: EVENT_KIND.skill_loaded,
          payload: { stepId: args.stepId, runToken, name: s.name, hash: s.hash },
          // hash in the key: a hot skill edit then records the new load instead of colliding
          idempotencyKey: `${runToken}:skill:${s.name}:${s.hash}`,
        })),
      ])

      const executor = executors.get(init.step.executorRef)
      if (!executor) return await finishFailed(checkpoint, args, runToken, `no executor '${init.step.executorRef}'`)
      const { modelId, model, provider } = resolveModel(providers, init.step.modelRef)

      const workspaceDir = args.cwd ?? path.join(config.workspaceRoot, args.taskId, args.stepId)
      await checkpoint('workspace', async () => { mkdirSync(workspaceDir, { recursive: true }); return workspaceDir })

      // tool resolution records nothing: it lives in the workflow body and re-runs on recovery
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

      let stepKnowledge: StepKnowledge | undefined
      if (stepTools) {
        const bound = stepTools({
          origin: args.origin,
          taskId: args.taskId, stepId: args.stepId, runToken, workspaceId: init.workspaceId,
          role: init.step.role, executor: init.step.executorRef, model: modelId,
          modelRef: init.step.modelRef, maxIterations: init.step.maxIterations, workspaceDir,
          step: init.step, ancestorTaskIds: ancestorTaskIds(await projectState(), args.taskId),
        })
        const { tools: stepScoped, knowledge } = Array.isArray(bound) ? { tools: bound, knowledge: undefined } : bound
        extraTools = [...extraTools, ...stepScoped]
        stepKnowledge = knowledge
      }

      const ctx: ExecutorContext<unknown> = {
        step: init.step,
        taskSpec: init.taskSpec,
        depOutputs: init.depOutputs,
        skills: init.skills,
        extraTools,
        model,
        runToken,
        origin: args.origin,
        workspaceDir,
        taskId: args.taskId,
        knowledgePreloadTokens: config.knowledgePreloadTokens,
        ...(init.priorFailure && { priorFailure: init.priorFailure }),
        ...(stepKnowledge && { knowledge: stepKnowledge }),
        // prices usage drafts on the way through: fill costUSD from the provider table
        checkpoint: (name, fn, toEvents) =>
          checkpoint(name, fn, toEvents ? r => toEvents(r).map(d => priceDraft(d, provider, modelId)) : undefined),
        operation: (spec, fn, toEvents) =>
          operation(spec, fn, toEvents ? r => toEvents(r).map(d => priceDraft(d, provider, modelId)) : undefined),
        // Spend is enforced across the ancestor chain: grants are clamped but never reserved.
        budgetRemainingUSD: async () => remainingBudget(await projectState(), args.taskId),
        isCancelled: async () => (await projectState()).tasks.get(args.taskId)?.status === TASK_STATUS.cancelled,
      }

      // splitIds already handed to a gate in THIS workflow, shared across continuation rounds
      const consumed = new Set<string>()
      // the continuation verdict recorded per round, an enum so every comparison spells it once
      enum ContinuationGrant { auto = 'auto', ask = 'ask' }
      // ONE round of the executor; ids carry a round prefix because iterations restart each round
      const driveRound = async (round: number, prevSummary: string | null): Promise<{ signal: Signal | null; error: { class: FailureClass; message: string } | null }> => {
      // a holder, not `let`s: TS control flow cannot see assignments made inside the callback
      const collected: { signal: Signal | null; error: { class: FailureClass; message: string } | null } = { signal: null, error: null }
      const roundName = (name: string): string => round === 0 ? name : `r${round}:${name}`
      const roundCtx: typeof ctx = round === 0 ? ctx : {
        ...ctx,
        checkpoint: (name, fn, toEvents) => ctx.checkpoint(roundName(name), fn, toEvents),
        operation: (spec, fn, toEvents) => ctx.operation({ ...spec, operationId: roundName(spec.operationId) }, fn, toEvents),
        continuation: { round, summary: prevSummary ?? '' },
      }
      const gen = executor.startTurn(roundCtx)
      // gen.return() in a finally releases the step's write-claims even when the port throws at a gate
      await driveGenerator(gen, async ev => {
        if (ev.type === UnifiedEventType.signal) { collected.signal = ev.signal; return undefined }
        if (ev.type === UnifiedEventType.error) { collected.error = { class: ev.class, message: ev.message }; return undefined }
        if (ev.type === UnifiedEventType.gate) {
          // Resolve in a checkpoint: this attempt's unconsumed splits, intersected with any request
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
            // recv is legal in workflow context only; poll long: each expiry records a durable row
            let msg: SplitResult | null = null
            while (msg === null) msg = await DBOS.recv<SplitResult>(`split:${id}`, GATE_POLL_SECONDS)
            results.push(msg)
          }
          return results
        }
        if (ev.type === UnifiedEventType.feedback) {
          await checkpoint(`feedback:req:${ev.toolCallId}`, async () => 0, () =>
            [{ kind: EVENT_KIND.feedback_requested, payload: { question: ev.question, topic: ev.topic } }])
          // long poll, loop forever: no gate timeout; cancel is the escape
          let msg: string | null = null
          while (msg === null) msg = await DBOS.recv<string>(`feedback:${ev.topic}`, GATE_POLL_SECONDS)
          return msg
        }
        return undefined
      })
      return collected
      }

      // The agent reports `partial`; the runtime grants within budget and round cap, else escalates.
      let round = 0
      let { signal, error } = await driveRound(round, null)
      while (signal?.outcome === SignalOutcome.partial) {
        const partialSummary = signal.summary
        // Grant in a checkpoint: an unrecorded verdict could auto-continue live and gate on recovery
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
            // human_abort routes to the summary, never a retry that re-asks the same question
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
        // receipts + step_completed in ONE transaction; a committed completion skips re-verification
        await checkpoint('finish', async () => {
          const events = await log.byTask(args.taskId)
          const committed = events.some(e => e.kind === EVENT_KIND.step_completed && e.runToken === runToken)
          if (committed) return null
          // a strategy step that skipped the artifact it exists to produce is just as false a success
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
            payload: { stepId: args.stepId, runToken, summary: success.summary },
            // stable key: never positional — the receipt count must not shift it
            idempotencyKey: `${runToken}:finish:step_completed`,
          },
        ])
        return { stepId: args.stepId, ok: true }
      }
      // An auditor's failure is a VERDICT (`rejected`): retry would reach the same conclusion.
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
          // ONE transaction in fn, not a draft: a re-derived {from} would conflict under a fixed key
          await log.transaction(tx => appendRunInit(tx, args, workflowId))
          return { plan, done: [...completedStepIds(state, args.taskId)], attempts: nextAttempts(state, args.taskId, plan), depth: task.depth }
        })

        const plan: Plan = init.plan
        const done = new Set(init.done)
        const failed = new Set<string>()
        const started = new Set(init.done)

        // Launch each wave in plan order so replay matches (DBOS binds children positionally)
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
        // Containment: an uncaught error becomes running→blocked, the state retry resumes from
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

  // Attach only to a `running` run; a settled run keeps its id, so the next needs its own index.
  async function runIndexFor(taskId: string, status: string): Promise<number> {
    if (status === TASK_STATUS.running) {
      const latest = (await foldState(taskId)).runs.get(taskId)?.at(-1)
      if (latest) return latest.retryIndex
    }
    return nextRetryIndex(taskId)
  }

  async function startRunAt(taskId: string, retryIndex: number, cwd?: string): Promise<RunHandle> {
    // Admission reads byTask, not the live index: a stale view would refuse a drivable run
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
      // no cwd: the parent's run cwd, else the PROJECT dir (projections.runCwd)
      taskId, planVersion: approved, retryIndex, cwd: runCwd(cwdState, task, cwd, config.dir),
      // the run's own workflow id IS its chat — a retry gets a new id, so it opens a new one
      origin: runOrigin(workflowID),
    })
    return { workflowId: workflowID, wait: () => handle.getResult() }
  }

  // Shared with the router so a redelivered retry and a direct `orc retry` land on the same index.
  async function nextRetryIndex(taskId: string): Promise<number> {
    const runs = (await foldState(taskId)).runs.get(taskId) ?? []
    return runs.length === 0 ? 0 : Math.max(...runs.map(r => r.retryIndex)) + 1
  }

  // DBOS cancel does not cascade: cancel each non-completed step workflow, then the run.
  async function cancelWorkflowsFor(taskId: string): Promise<void> {
    const state = await foldState(taskId)
    const latest = state.runs.get(taskId)?.at(-1)
    const approved = state.plans.get(taskId)?.approvedVersion
    const plan = state.plans.get(taskId)?.versions.find(p => p.version === approved)
    if (plan) {
      const done = completedStepIds(state, taskId)
      // startedAttempts, not nextAttempts, which is one ahead of the live workflow after a cancel
      const attempts = startedAttempts(state, taskId, plan)
      for (const s of plan.steps) {
        const attempt = attempts[s.id]
        // a step that never started has no workflow to cancel — omitted rather than guessed at
        if (done.has(s.id) || attempt === undefined) continue
        await DBOS.cancelWorkflow(stepWorkflowId(taskId, s.id, attempt)).catch(() => {})
      }
    }
    // An enqueued run has no run_started: derive its deterministic id (index 0) instead
    const workflowId = latest?.workflowId ?? (approved ? `run:${taskId}:v${approved}` : null)
    if (!workflowId) return
    // a cancel failure surfaces; cancelling a finished workflow is a no-op, so both callers are safe
    await DBOS.cancelWorkflow(workflowId)
  }

  // The executor id goes through setConfig: assigning DBOS__VMID in launch() lands too late
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
      // registerQueue requires DBOS to be launched already (dbos-sdk v4.23)
      for (let d = 0; d <= config.maxDepth; d++) {
        await DBOS.registerQueue(agentQueue(d), { concurrency: config.concurrency, workerConcurrency: config.concurrency })
        if (d > 0) await DBOS.registerQueue(runQueue(d), { concurrency: config.concurrency, workerConcurrency: config.concurrency })
      }
      await router.start()
    },
    // deregister lets a fresh port re-register in the same process (integration tests)
    shutdown: async ({ drain = true } = {}) => {
      try {
        await router.close()
        // Drain waits an hour on a parked gate while holding the runtime lock; exiting commands skip it
        if (drain) await DBOS.shutdown({ deregister: true })
      } finally {
        await live?.close()
        live = null
        await runtimeLock?.release()
        runtimeLock = null
      }
    },
    // Deterministic id, so redelivery attaches; startRunAt with no override, like the CLI's follow
    startChildRun: async (childTaskId: string): Promise<void> => { await startRunAt(childTaskId, 0) },
    startRun: async (taskId, o) => startRunAt(taskId, await runIndexFor(taskId, (await foldState(taskId)).tasks.get(taskId)?.status ?? ''), o?.cwd),
    retry: async (taskId, o) => {
      const state = await foldState(taskId)
      const task = state.tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      // The port half of assertRetryable, off the SAME predicate: the router skips the actions layer
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
      // A retry inherits the latest run's non-null cwd (projections.inheritedCwd), else the project dir
      const cwd = inheritedCwd(runs, o?.cwd, config.dir)
      return startRunAt(taskId, await nextRetryIndex(taskId), cwd)
    },
    cancelRun: async (taskId, origin) => {
      const task = (await foldState(taskId)).tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      if (task.status !== TASK_STATUS.running && task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — only a running or blocked task can be cancelled`)
      // cancelSubtree appends; the DBOS half runs here, idempotent with the router's reaction
      const stamped = await kernel.cancelSubtree(taskId, origin)
      for (const id of stamped) await cancelWorkflowsFor(id)
    },
  }

  // Port-level routes; built after the port object because it references port.startChildRun.
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
