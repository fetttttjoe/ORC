import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  EVENT_KIND, FAILURE_CLASS, RUN_OUTCOME, SIGNAL_OUTCOME, TASK_STATUS,
  classifiedError, failureClassOf, isTerminalError, resolveModel, costUSDFor,
  type AgentExecutor, type Checkpoint, type EventDraft, type ExecutionPort, type ExecutorContext,
  type FailureClass, type LoadedSkill, type ModelProvider, type Plan, type ResolvedTool,
  type RunHandle, type RunOutcome, type Signal, type ToolSource,
} from '@orc/contracts'
import { EventLog } from '../eventlog'
import { fold, completedStepIds, nextAttempts, taskUsage, type State } from '../projections'
import { KERNEL_ERROR_CODE, KernelError } from '../errors'
import { readySteps, runOutcomeOf } from './interpreter'
import type { OrcConfig } from '../config'

export interface DbosPort extends ExecutionPort {
  launch(): Promise<void>
  shutdown(): Promise<void>
  startChildRun(childTaskId: string): Promise<void>
}

// depth-partitioned queues (spec D7): a gate-waiting parent at depth d holds a slot on
// agents:<d> only, so it can never starve the depth-d+1 children it is waiting on.
const agentQueue = (depth: number): string => `agents:${depth}`
const runQueue = (depth: number): string => `runs:${depth}`

interface RunArgs { taskId: string; planVersion: number; retryIndex: number; cwd: string | null }
interface StepArgs { taskId: string; stepId: string; planVersion: number; attempt: number; cwd: string | null }
interface StepResult { stepId: string; ok: boolean }

// the ONE place the deterministic step workflow id is built (start + cancel both use it)
const stepWorkflowId = (taskId: string, stepId: string, attempt: number): string =>
  `step:${taskId}:${stepId}:a${attempt}`

export async function createDbosPort(opts: {
  log: EventLog
  config: OrcConfig
  providers: Map<string, ModelProvider<unknown>>
  executors: Map<string, AgentExecutor<unknown>>
  skills?: { load(name: string): Promise<LoadedSkill> }
  tools?: ToolSource
  stepTools?: (p: {
    taskId: string; stepId: string; runToken: string; role: string; executor: string; model: string
    modelRef: string; maxIterations: number
  }) => ResolvedTool[]
}): Promise<DbosPort> {
  const { log, config, providers, executors, skills, tools, stepTools } = opts

  const foldState = async (taskId: string): Promise<State> => fold(await log.byTask(taskId))

  // durable step wrapper that also appends the drafted events INSIDE the step (spec §6.2)
  const makeCheckpoint = (taskId: string, stepId: string | null, runToken: string): Checkpoint =>
    (name, fn, toEvents) =>
      DBOS.runStep(
        async () => {
          const r = await fn()
          if (toEvents)
            for (const d of toEvents(r))
              await log.append({ taskId, stepId, runToken, kind: d.kind, payload: d.payload, usage: d.usage ?? null })
          return r
        },
        // terminal errors (e.g. a 4xx model failure) must NOT retry — see terminalError in @orc/contracts
        { name, retriesAllowed: true, maxAttempts: 4, intervalSeconds: 1, backoffRate: 2, shouldRetry: e => !isTerminalError(e) },
      )

  const stepWorkflow = DBOS.registerWorkflow(
    async (args: StepArgs): Promise<StepResult> => {
      const runToken = DBOS.workflowID!
      const checkpoint = makeCheckpoint(args.taskId, args.stepId, runToken)

      // ANY throw — init included — becomes a step_failed event instead of an uncaught workflow
      // error that would leave the task stuck 'running' with a burned ERROR workflow that retry
      // re-attaches to.
      try {
      // checkpointed init: read plan/task/dep-outputs (event-log reads are non-deterministic → must be a step)
      const init = await checkpoint('init', async () => {
        const state = await foldState(args.taskId)
        const plan = state.plans.get(args.taskId)?.versions.find(p => p.version === args.planVersion)
        if (!plan) throw classifiedError(FAILURE_CLASS.validation_error, `no plan v${args.planVersion} for task '${args.taskId}'`)
        const step = plan.steps.find(s => s.id === args.stepId)
        if (!step) throw classifiedError(FAILURE_CLASS.validation_error, `no step '${args.stepId}' in plan v${args.planVersion}`)
        const task = state.tasks.get(args.taskId)
        if (!task) throw classifiedError(FAILURE_CLASS.validation_error, `no task '${args.taskId}'`)
        const depOutputs: Record<string, string> = {}
        for (const dep of step.dependsOn) depOutputs[dep] = state.steps.get(args.taskId)?.get(dep)?.output ?? ''
        const loadedSkills: LoadedSkill[] = []
        for (const ref of step.skillRefs) {
          if (!skills) throw classifiedError(FAILURE_CLASS.validation_error, `step declares skill '${ref}' but no skill index is configured`)
          try {
            loadedSkills.push(await skills.load(ref))
          } catch (err) {
            throw classifiedError(FAILURE_CLASS.validation_error, `skill '${ref}': ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return { step, taskSpec: task.spec, budgetUSD: task.budgetUSD, depOutputs, skills: loadedSkills }
      }, r => [
        { kind: EVENT_KIND.step_started, payload: { stepId: args.stepId, runToken, attempt: args.attempt } },
        ...r.skills.map(s => ({
          kind: EVENT_KIND.skill_loaded,
          payload: { stepId: args.stepId, runToken, name: s.name, hash: s.hash },
        })),
      ])

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
        if (!tools) return await finishFailed(checkpoint, args, runToken, `step declares toolRefs but no tool source is configured`, FAILURE_CLASS.validation_error)
        try {
          extraTools = await tools.resolve(toolRefs)
        } catch (err) {
          return await finishFailed(checkpoint, args, runToken, err instanceof Error ? err.message : String(err), FAILURE_CLASS.validation_error)
        }
      }

      if (stepTools)
        extraTools = [...extraTools, ...stepTools({
          taskId: args.taskId, stepId: args.stepId, runToken,
          role: init.step.role, executor: init.step.executorRef, model: modelId,
          modelRef: init.step.modelRef, maxIterations: init.step.maxIterations,
        })]

      const ctx: ExecutorContext<unknown> = {
        step: init.step,
        taskSpec: init.taskSpec,
        depOutputs: init.depOutputs,
        skills: init.skills,
        extraTools,
        model,
        runToken,
        workspaceDir,
        // prices usage drafts on the way through: fill costUSD from the provider table
        checkpoint: (name, fn, toEvents) =>
          checkpoint(name, fn, toEvents ? r => toEvents(r).map(d => priceDraft(d, provider, modelId)) : undefined),
        budgetRemainingUSD: async () => {
          if (init.budgetUSD === null) return null
          const spent = taskUsage(await foldState(args.taskId), args.taskId).costUSD ?? 0
          return init.budgetUSD - spent
        },
      }

      let signal: Signal | null = null
      let error: { class: string; message: string } | null = null
      for await (const ev of executor.startTurn(ctx)) {
        if (ev.type === 'signal') signal = ev.signal
        if (ev.type === 'error') error = { class: ev.class, message: ev.message }
      }

      if (signal?.outcome === SIGNAL_OUTCOME.success) {
        await checkpoint('finish', async () => signal, () => [
          { kind: EVENT_KIND.step_completed, payload: { stepId: args.stepId, runToken, summary: signal!.summary } },
        ])
        return { stepId: args.stepId, ok: true }
      }
      const failClass = signal ? FAILURE_CLASS.agent_error : (error?.class ?? FAILURE_CLASS.agent_error)
      const message = signal ? signal.summary : (error?.message ?? 'executor ended without signal')
      await checkpoint('finish', async () => message, () => [
        { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: failClass, message } },
      ])
      return { stepId: args.stepId, ok: false }
      } catch (err) {
        return finishFailed(checkpoint, args, runToken,
          err instanceof Error ? err.message : String(err),
          failureClassOf(err) ?? FAILURE_CLASS.agent_error)
      }
    },
    { name: 'orcStep' },
  )

  const runWorkflow = DBOS.registerWorkflow(
    async (args: RunArgs): Promise<RunOutcome> => {
      const workflowId = DBOS.workflowID!
      const checkpoint = makeCheckpoint(args.taskId, null, workflowId) // run-level events carry no stepId

      const init = await checkpoint('init', async () => {
        const state = await foldState(args.taskId)
        const plan = state.plans.get(args.taskId)!.versions.find(p => p.version === args.planVersion)!
        const from = state.tasks.get(args.taskId)!.status
        const depth = state.tasks.get(args.taskId)!.depth
        return { plan, done: [...completedStepIds(state, args.taskId)], attempts: nextAttempts(state, args.taskId, plan), from, depth }
      }, r => [
        { kind: EVENT_KIND.run_started, payload: { taskId: args.taskId, planVersion: args.planVersion, retryIndex: args.retryIndex, workflowId, cwd: args.cwd } },
        { kind: EVENT_KIND.task_status_changed, payload: { taskId: args.taskId, from: r.from, to: TASK_STATUS.running } },
      ])

      const plan: Plan = init.plan
      const done = new Set(init.done)
      const failed = new Set<string>()
      const started = new Set(init.done)
      const pending = new Map<string, Promise<StepResult>>()

      // continuous scheduling: re-evaluate readiness as EACH step settles, so a fast step's
      // dependents never wait on a slow unrelated sibling. Recovery-safe: child workflow ids
      // are deterministic, so re-issued startWorkflow calls attach idempotently.
      const launchReady = async (): Promise<void> => {
        for (const s of readySteps(plan, done, failed, started)) {
          started.add(s.id)
          const handle = await DBOS.startWorkflow(stepWorkflow, {
            workflowID: stepWorkflowId(args.taskId, s.id, init.attempts[s.id]!),
            queueName: agentQueue(init.depth),
          })({ taskId: args.taskId, stepId: s.id, planVersion: args.planVersion, attempt: init.attempts[s.id]!, cwd: args.cwd })
          pending.set(s.id, handle.getResult())
        }
      }
      await launchReady()
      while (pending.size > 0) {
        const r = await Promise.race(pending.values())
        pending.delete(r.stepId)
        ;(r.ok ? done : failed).add(r.stepId)
        await launchReady()
      }

      const outcome = runOutcomeOf(plan, done)
      await checkpoint('finish', async () => {
        const status = (await foldState(args.taskId)).tasks.get(args.taskId)!.status
        return { outcome, status }
      }, r => r.status !== TASK_STATUS.running ? [] : [
        // a cancelRun that landed mid-run already appended running→cancelled — never overwrite it
        { kind: EVENT_KIND.task_status_changed, payload: { taskId: args.taskId, from: TASK_STATUS.running, to: r.outcome === RUN_OUTCOME.done ? TASK_STATUS.done : TASK_STATUS.blocked } },
      ])
      return outcome
    },
    { name: 'orcRun' },
  )

  async function startRunAt(taskId: string, retryIndex: number, cwd?: string): Promise<RunHandle> {
    const state = await foldState(taskId)
    const task = state.tasks.get(taskId)
    if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
    const approved = state.plans.get(taskId)?.approvedVersion
    if (!approved || (task.status !== TASK_STATUS.approved && task.status !== TASK_STATUS.running && task.status !== TASK_STATUS.blocked))
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — approve a plan first (orc approve ${taskId})`)
    const workflowID = retryIndex === 0 ? `run:${taskId}:v${approved}` : `run:${taskId}:v${approved}:r${retryIndex}`
    const handle = await DBOS.startWorkflow(runWorkflow, { workflowID })({
      taskId, planVersion: approved, retryIndex, cwd: cwd ?? null,
    })
    return { workflowId: workflowID, wait: () => handle.getResult() }
  }

  return {
    launch: async () => {
      // DBOS__APPVERSION pinned from config BEFORE launch so recovery survives rebuilds (spec §4)
      process.env.DBOS__APPVERSION ??= config.appVersion
      DBOS.setConfig({ name: 'orc', systemDatabaseUrl: config.systemDatabaseUrl, logLevel: 'warn', runAdminServer: false })
      await DBOS.launch()
      // ADAPTATION: registerQueue requires DBOS already launched in @dbos-inc/dbos-sdk v4.23 (see report)
      for (let d = 0; d <= config.maxDepth; d++) {
        await DBOS.registerQueue(agentQueue(d), { concurrency: config.concurrency, workerConcurrency: config.concurrency })
        if (d > 0) await DBOS.registerQueue(runQueue(d), { concurrency: config.concurrency, workerConcurrency: config.concurrency })
      }
    },
    // deregister clears the workflow/queue registries so a fresh port can re-register in the
    // same process — required when >1 port is created per process (integration tests); a no-op
    // at real process exit. (DBOS docs: use deregister when re-registering functions.)
    shutdown: () => DBOS.shutdown({ deregister: true }),
    startChildRun: async (childTaskId: string): Promise<void> => {
      const state = await foldState(childTaskId)
      const task = state.tasks.get(childTaskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${childTaskId}'`)
      const approved = state.plans.get(childTaskId)?.approvedVersion
      if (!approved) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `no approved plan for '${childTaskId}'`)
      // deterministic id: the router may call this more than once (at-least-once delivery) — attaches idempotently
      await DBOS.startWorkflow(runWorkflow, {
        workflowID: `run:${childTaskId}:v${approved}`,
        queueName: runQueue(task.depth),
      })({ taskId: childTaskId, planVersion: approved, retryIndex: 0, cwd: null })
    },
    startRun: (taskId, o) => startRunAt(taskId, 0, o?.cwd),
    retry: async (taskId, o) => {
      const state = await foldState(taskId)
      const task = state.tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      if (task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — only a blocked task can be retried`)
      const runs = state.runs.get(taskId) ?? []
      return startRunAt(taskId, runs.length === 0 ? 0 : Math.max(...runs.map(r => r.retryIndex)) + 1, o?.cwd)
    },
    cancelRun: async taskId => {
      const state = await foldState(taskId)
      const task = state.tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      if (task.status !== TASK_STATUS.running && task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — only a running or blocked task can be cancelled`)
      const latest = state.runs.get(taskId)?.at(-1)
      if (!latest) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `no run to cancel for '${taskId}'`)
      // DBOS cancel does NOT cascade by default (spec §6.1): cancel EVERY non-completed step's
      // deterministic workflow (catches enqueued-but-not-yet-dequeued steps too), then the run.
      const approved = state.plans.get(taskId)?.approvedVersion
      const plan = state.plans.get(taskId)?.versions.find(p => p.version === approved)
      if (plan) {
        const done = completedStepIds(state, taskId)
        const attempts = nextAttempts(state, taskId, plan)
        for (const s of plan.steps)
          if (!done.has(s.id))
            // tolerated miss: an attempt that never started has no workflow row to cancel
            await DBOS.cancelWorkflow(stepWorkflowId(taskId, s.id, attempts[s.id]!)).catch(() => {})
      }
      // the run workflow always exists (run_started recorded its id) — a cancel failure here
      // must surface to the caller, NOT be recorded as a successful cancellation
      await DBOS.cancelWorkflow(latest.workflowId)
      await log.transaction(async tx => {
        // re-check under the log's write serialization: if the run finished in the meantime,
        // leave its terminal status alone instead of stamping a cancellation that didn't happen
        const status = fold(await tx.byTask(taskId)).tasks.get(taskId)!.status
        if (status !== TASK_STATUS.running && status !== TASK_STATUS.blocked) return
        await tx.append({
          taskId, stepId: null, runToken: null,
          kind: EVENT_KIND.task_status_changed,
          payload: { taskId, from: status, to: TASK_STATUS.cancelled },
        })
      })
    },
  }
}

function priceDraft(d: EventDraft, provider: ModelProvider<unknown>, modelId: string): EventDraft {
  if (!d.usage || d.usage.costUSD !== null) return d
  const costUSD = costUSDFor(provider.costs, modelId, d.usage.inputTokens, d.usage.outputTokens)
  return { ...d, usage: { ...d.usage, costUSD, estimated: d.usage.estimated || costUSD === null } }
}

async function finishFailed(
  checkpoint: Checkpoint, args: StepArgs, runToken: string, message: string,
  cls: FailureClass = FAILURE_CLASS.agent_error,
): Promise<StepResult> {
  await checkpoint('finish', async () => message, () => [
    { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: cls, message } },
  ])
  return { stepId: args.stepId, ok: false }
}
