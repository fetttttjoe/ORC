import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  EVENT_KIND, FAILURE_CLASS, RUN_OUTCOME, SIGNAL_OUTCOME, TASK_STATUS,
  classifiedError, errorMessage, failureClassOf, isTerminalError, resolveModel, costUSDFor,
  type AgentExecutor, type Checkpoint, type EventDraft, type ExecutionPort, type ExecutorContext,
  type FailureClass, type LoadedSkill, type ModelProvider, type OperationCheckpoint, type Plan,
  type ResolvedTool, type RunHandle, type RunOutcome, type Signal, type SplitResult, type ToolSource,
} from '@orc/contracts'
import type { Storage } from '../storage'
import { verifyArtifacts } from './artifacts'
import { fold, completedStepIds, nextAttempts, subtreeTaskIds, subtreeUsage, type State } from '../projections'
import { KERNEL_ERROR_CODE, KernelError } from '../errors'
import { readySteps, runOutcomeOf } from './interpreter'
import { createSignalRouter } from './signal-router'
import { projectSuffix, type ProjectConfig } from '../config'

export interface DbosPort extends ExecutionPort {
  launch(): Promise<void>
  shutdown(): Promise<void>
  startChildRun(childTaskId: string): Promise<void>
}

// depth-partitioned queues (spec D7): a gate-waiting parent at depth d holds a slot on
// agents:<d> only, so it can never starve the depth-d+1 children it is waiting on.
const agentQueue = (depth: number): string => `agents:${depth}`
const runQueue = (depth: number): string => `runs:${depth}`

// How long one DBOS.recv waits before looping. Human gates park for hours, and every expiry
// writes durable rows that recovery must replay in order — so this trades nothing but row
// count. Cancellation responsiveness is independent of it (see the split gate).
const GATE_POLL_SECONDS = 3_600

interface RunArgs { taskId: string; planVersion: number; retryIndex: number; cwd: string | null }
interface StepArgs { taskId: string; stepId: string; planVersion: number; attempt: number; cwd: string | null }
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

export async function createDbosPort(opts: {
  storage: Storage
  config: ProjectConfig
  providers: Map<string, ModelProvider<unknown>>
  executors: Map<string, AgentExecutor<unknown>>
  skills?: { load(name: string): Promise<LoadedSkill> }
  tools?: ToolSource
  stepTools?: (p: {
    taskId: string; stepId: string; runToken: string; role: string; executor: string; model: string
    modelRef: string; maxIterations: number; workspaceDir: string
  }) => ResolvedTool[]
}): Promise<DbosPort> {
  const { config, providers, executors, skills, tools, stepTools } = opts
  const { events: log, operations: journal, redact } = opts.storage

  // DBOS serializes EVERY step's return value into its own operation_outputs table
  // (dbos-executor's recordOperationResult), in the DBOS system database — same Postgres
  // cluster and credentials as the event log, but NOT behind EventLog.append's redaction.
  // Raw tool results and full model turns pass through here, so this is the one place they
  // leave a step and must be scrubbed. Wrapping in an object routes arrays and primitives
  // through the redactor's recursive walk while preserving the caller's shape.
  const redactStepResult = <T>(r: T): T =>
    r === null || typeof r !== 'object' ? r : (redact({ v: r } as Record<string, unknown>).v as T)

  const foldState = async (taskId: string): Promise<State> => fold(await log.byTask(taskId))

  // terminal errors (e.g. a 4xx model failure) must NOT retry — see terminalError in @orc/contracts
  const RETRY_POLICY = { retriesAllowed: true, maxAttempts: 4, intervalSeconds: 1, backoffRate: 2, shouldRetry: (e: unknown) => !isTerminalError(e) }

  // durable step wrapper that also appends the drafted events INSIDE the step (spec §6.2) —
  // one transaction per batch, each draft under a deterministic idempotency key, so a crash
  // retry returns the committed records instead of appending duplicates
  const makeCheckpoint = (taskId: string, stepId: string | null, runToken: string): Checkpoint =>
    (name, fn, toEvents) =>
      DBOS.runStep(
        async () => {
          const r = await fn()
          const drafts = toEvents ? toEvents(r) : []
          if (drafts.length > 0)
            await log.transaction(async tx => {
              for (const [i, d] of drafts.entries())
                await tx.append({
                  taskId, stepId, runToken, kind: d.kind, payload: d.payload, usage: d.usage ?? null,
                  idempotencyKey: d.idempotencyKey ?? `${runToken}:${name}:${i}:${d.kind}`,
                })
            })
          // drafts go through log.append, which redacts on its own; this guards what DBOS persists
          return redactStepResult(r)
        },
        { name, ...RETRY_POLICY },
      )

  // The journal-backed operation checkpoint (design §5.2): before-record commits ahead of the
  // external effect; completion/failure attaches afterward. On recovery a completed node
  // short-circuits with its stored (redacted) value — the effect is never re-run.
  const makeOperation = (taskId: string, stepId: string, runToken: string): OperationCheckpoint =>
    (spec, fn, toEvents) =>
      DBOS.runStep(
        async () => {
          const context = { taskId, stepId, runToken }
          const begin = await journal.beginOperation(context, spec)
          // journal values are plain JSON — parse hands back the caller's shape
          if (begin.reused) return JSON.parse(JSON.stringify(begin.value ?? null))
          try {
            const result = await fn()
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
      const checkpoint = makeCheckpoint(args.taskId, args.stepId, runToken)
      const operation = makeOperation(args.taskId, args.stepId, runToken)

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
            throw classifiedError(FAILURE_CLASS.validation_error, `skill '${ref}': ${errorMessage(err)}`)
          }
        }
        return { step, taskSpec: task.spec, budgetUSD: task.budgetUSD, depOutputs, skills: loadedSkills }
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
          return await finishFailed(checkpoint, args, runToken, errorMessage(err), FAILURE_CLASS.validation_error)
        }
      }

      if (stepTools)
        extraTools = [...extraTools, ...stepTools({
          taskId: args.taskId, stepId: args.stepId, runToken,
          role: init.step.role, executor: init.step.executorRef, model: modelId,
          modelRef: init.step.modelRef, maxIterations: init.step.maxIterations, workspaceDir,
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
        operation: (spec, fn, toEvents) =>
          operation(spec, fn, toEvents ? r => toEvents(r).map(d => priceDraft(d, provider, modelId)) : undefined),
        budgetRemainingUSD: async () => {
          if (init.budgetUSD === null) return null
          // ponytail: whole-log fold — subtree usage spans child tasks (spec D8), byTask is not enough
          const spent = subtreeUsage(fold(await log.all()), args.taskId).costUSD ?? 0
          return init.budgetUSD - spent
        },
      }

      let signal: Signal | null = null
      let error: { class: string; message: string } | null = null
      const gen = executor.startTurn(ctx)
      let resume: SplitResult[] | string | undefined
      // splitIds already handed to a previous gate in THIS workflow. Rebuilds correctly on
      // replay because each gate:targets checkpoint replays its recorded value in order.
      const consumed = new Set<string>()
      while (true) {
        const { value: ev, done } = await gen.next(resume)
        resume = undefined
        if (done) break
        if (ev.type === 'signal') signal = ev.signal
        if (ev.type === 'error') error = { class: ev.class, message: ev.message }
        if (ev.type === 'gate') {
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
          resume = results
        }
        if (ev.type === 'feedback') {
          await checkpoint(`feedback:req:${ev.toolCallId}`, async () => 0, () =>
            [{ kind: EVENT_KIND.feedback_requested, payload: { question: ev.question, topic: ev.topic } }])
          // ponytail: long poll, loop forever — no gate timeout in v1 (mirrors the split gate); cancel is the escape
          let msg: string | null = null
          while (msg === null) msg = await DBOS.recv<string>(`feedback:${ev.topic}`, GATE_POLL_SECONDS)
          resume = msg
          continue
        }
      }

      if (signal?.outcome === SIGNAL_OUTCOME.success) {
        const success = signal // closures below see the narrowed binding
        // verify declared outputs at the trusted boundary; receipts and step_completed
        // commit in ONE transaction — a completed step can never lack its receipts.
        // If the completion already committed (crash before DBOS recorded the step result),
        // skip re-verification: the workspace may have changed since, and re-hashing would
        // conflict with the committed receipts and flip a durable success into failed.
        await checkpoint('finish', async () => {
          const committed = (await log.byTask(args.taskId))
            .some(e => e.kind === EVENT_KIND.step_completed && e.runToken === runToken)
          if (committed) return null
          try {
            return verifyArtifacts(workspaceDir, success.outputs ?? [])
          } catch (err) {
            throw classifiedError(FAILURE_CLASS.validation_error, errorMessage(err))
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
      const failClass = signal ? FAILURE_CLASS.agent_error : (error?.class ?? FAILURE_CLASS.agent_error)
      const message = signal ? signal.summary : (error?.message ?? 'executor ended without signal')
      await checkpoint('finish', async () => message, () => [
        { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: failClass, message } },
      ])
      return { stepId: args.stepId, ok: false }
      } catch (err) {
        return finishFailed(checkpoint, args, runToken,
          errorMessage(err),
          failureClassOf(err) ?? FAILURE_CLASS.agent_error)
      }
    },
    { name: 'orcStep' },
  )

  const runWorkflow = DBOS.registerWorkflow(
    async (args: RunArgs): Promise<RunOutcome> => {
      const workflowId = workflowIdOrThrow()
      const checkpoint = makeCheckpoint(args.taskId, null, workflowId) // run-level events carry no stepId

      try {
        const init = await checkpoint('init', async () => {
          const state = await foldState(args.taskId)
          const task = state.tasks.get(args.taskId)
          const plan = state.plans.get(args.taskId)?.versions.find(p => p.version === args.planVersion)
          if (!task || !plan) throw classifiedError(FAILURE_CLASS.validation_error, `no task/plan v${args.planVersion} for '${args.taskId}'`)
          // run_started + the running-transition commit in ONE transaction inside fn, NOT the
          // toEvents draft path: the status change depends on foldable state, and a fixed-key draft
          // that re-derives {from: task.status} on recovery flips to {from: running} (its own
          // committed event), conflicts under the same key, and bricks the task at 'running' with an
          // ERROR workflow retry cannot resume. Mirror the finish checkpoint — append run_started
          // idempotently and stamp running only while the status is still pre-run (also no-ops
          // cleanly if an orc cancel raced in).
          await log.transaction(async tx => {
            await tx.append({
              taskId: args.taskId, stepId: null, runToken: workflowId, kind: EVENT_KIND.run_started,
              payload: { taskId: args.taskId, planVersion: args.planVersion, retryIndex: args.retryIndex, workflowId, cwd: args.cwd },
              idempotencyKey: `${workflowId}:init:run_started`,
            })
            const status = fold(await tx.byTask(args.taskId)).tasks.get(args.taskId)?.status
            if (status === TASK_STATUS.approved || status === TASK_STATUS.blocked)
              await tx.append({
                taskId: args.taskId, stepId: null, runToken: workflowId, kind: EVENT_KIND.task_status_changed,
                payload: { taskId: args.taskId, from: status, to: TASK_STATUS.running },
                idempotencyKey: `${workflowId}:init:task_status_changed`,
              })
          })
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
              workflowID: stepWorkflowId(args.taskId, s.id, init.attempts[s.id]!),
              queueName: agentQueue(init.depth),
            })({ taskId: args.taskId, stepId: s.id, planVersion: args.planVersion, attempt: init.attempts[s.id]!, cwd: args.cwd })
            results.push(handle.getResult())
          }
          for (const r of await Promise.all(results)) (r.ok ? done : failed).add(r.stepId)
        }

        const outcome = runOutcomeOf(plan, done)
        // The status re-check and the terminal append happen in ONE transaction, deliberately not
        // via the checkpoint's draft path: makeCheckpoint runs fn() and THEN opens a separate
        // transaction for its drafts, so reading the status in fn and appending from toEvents is
        // TOCTOU. An `orc cancel` landing in that window takes the project lock, re-checks, and
        // appends running→cancelled — and this would then append running→done on top of it. fold
        // is last-seq-wins with no `from` check (projections.ts), so the task would report done
        // while the router had already told the parent it was cancelled. cancelOne reads and
        // writes under one lock; this now matches it.
        await checkpoint('finish', async () => {
          await log.transaction(async tx => {
            const status = fold(await tx.byTask(args.taskId)).tasks.get(args.taskId)?.status ?? TASK_STATUS.running
            if (status !== TASK_STATUS.running) return // a cancel already stamped a terminal status
            await tx.append({
              taskId: args.taskId, stepId: null, runToken: workflowId,
              kind: EVENT_KIND.task_status_changed,
              payload: { taskId: args.taskId, from: TASK_STATUS.running, to: outcome === RUN_OUTCOME.done ? TASK_STATUS.done : TASK_STATUS.blocked },
              usage: null,
              // same shape makeCheckpoint's drafts use, so a step retry cannot double-append
              idempotencyKey: `${workflowId}:finish:0:${EVENT_KIND.task_status_changed}`,
            })
          })
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
            await log.transaction(async tx => {
              const status = fold(await tx.byTask(args.taskId)).tasks.get(args.taskId)?.status
              if (status === TASK_STATUS.running)
                await tx.append({
                  taskId: args.taskId, stepId: null, runToken: workflowId, kind: EVENT_KIND.task_status_changed,
                  payload: { taskId: args.taskId, from: TASK_STATUS.running, to: TASK_STATUS.blocked },
                  idempotencyKey: `${workflowId}:contain:task_status_changed`,
                })
            })
            return { contained: true }
          })
        } catch { /* best-effort containment — original error still propagates */ }
        throw err
      }
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
      // A run with no explicit cwd works on the PROJECT, not in an empty scratch dir. The old
      // per-step .orc/workspaces/ default gave every step a directory with nothing in it — a
      // workspace no repo task can succeed in (scenario-2 burned five verify attempts on it,
      // each ENOENT-blind). Explicit --cwd still overrides; the recorded cwd feeds retry/child
      // inheritance so the whole run tree stays in one world.
      taskId, planVersion: approved, retryIndex, cwd: cwd ?? config.dir,
    })
    return { workflowId: workflowID, wait: () => handle.getResult() }
  }

  // one task's cancellation (spec §6.1): DBOS cancel does NOT cascade by default, so cancel
  // EVERY non-completed step's deterministic workflow (catches enqueued-but-not-yet-dequeued
  // steps too), then the run, then stamp the terminal status. Shared by cancelRun for both the
  // target task and every running/blocked descendant in its subtree.
  async function cancelOne(taskId: string, state: State): Promise<void> {
    const latest = state.runs.get(taskId)?.at(-1)
    if (!latest) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `no run to cancel for '${taskId}'`)
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
      const status = fold(await tx.byTask(taskId)).tasks.get(taskId)?.status
      if (status !== TASK_STATUS.running && status !== TASK_STATUS.blocked) return
      await tx.append({
        taskId, stepId: null, runToken: null,
        kind: EVENT_KIND.task_status_changed,
        payload: { taskId, from: status, to: TASK_STATUS.cancelled },
      })
    })
  }

  const port: DbosPort = {
    launch: async () => {
      // DBOS__APPVERSION pinned from config BEFORE launch so recovery survives rebuilds (spec §4)
      process.env.DBOS__APPVERSION ??= config.appVersion
      DBOS.setConfig({
        name: `orc-${projectSuffix(config.projectId).slice(0, 12)}`,
        systemDatabaseUrl: config.systemDatabaseUrl, logLevel: 'warn', runAdminServer: false,
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
    shutdown: async () => { await router.close(); await DBOS.shutdown({ deregister: true }) },
    startChildRun: async (childTaskId: string): Promise<void> => {
      const state = fold(await log.all())
      const task = state.tasks.get(childTaskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${childTaskId}'`)
      const approved = state.plans.get(childTaskId)?.approvedVersion
      if (!approved) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `no approved plan for '${childTaskId}'`)
      // deterministic id: the router may call this more than once (at-least-once delivery) — attaches idempotently
      // parent cwd inherits from its most recent run that HAD a cwd — findLast, not at(-1), the same
      // rule retry() uses: a pre-project-dir-default bare retry (cwd null) must not poison the child
      // into empty scratch; falls back to the project dir when no parent run ever had one
      const cwd = (task.parentId ? state.runs.get(task.parentId)?.findLast(r => r.cwd)?.cwd : null) ?? config.dir
      await DBOS.startWorkflow(runWorkflow, {
        workflowID: `run:${childTaskId}:v${approved}`,
        queueName: runQueue(task.depth),
      })({ taskId: childTaskId, planVersion: approved, retryIndex: 0, cwd })
    },
    startRun: (taskId, o) => startRunAt(taskId, 0, o?.cwd),
    retry: async (taskId, o) => {
      const state = await foldState(taskId)
      const task = state.tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      if (task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — only a blocked task can be retried`)
      const runs = state.runs.get(taskId) ?? []
      // A retry re-enters the world the run failed in: without an explicit override, inherit the
      // most recent run that HAD a cwd — not runs.at(-1), because histories from before the
      // project-dir default carry null-cwd retries that would poison plain last-run inheritance
      // (scenario-2's log is exactly [repo, null, null, null]). No run ever had one →
      // startRunAt's project-dir default applies.
      const cwd = o?.cwd ?? runs.findLast(r => r.cwd)?.cwd ?? undefined
      return startRunAt(taskId, runs.length === 0 ? 0 : Math.max(...runs.map(r => r.retryIndex)) + 1, cwd)
    },
    cancelRun: async taskId => {
      const state = fold(await log.all()) // subtree spans tasks — byTask is not enough here
      const task = state.tasks.get(taskId)
      if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
      if (task.status !== TASK_STATUS.running && task.status !== TASK_STATUS.blocked)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — only a running or blocked task can be cancelled`)
      // children before parent, so a parent gate-waiting on a child sees the child resolve first
      for (const id of subtreeTaskIds(state, taskId).reverse()) {
        const t = state.tasks.get(id)!
        if (t.status === TASK_STATUS.awaiting_approval || t.status === TASK_STATUS.approved || t.status === TASK_STATUS.draft) {
          await log.transaction(async tx => {
            const fresh = fold(await tx.byTask(id)).tasks.get(id)!.status
            if (fresh === TASK_STATUS.awaiting_approval || fresh === TASK_STATUS.approved || fresh === TASK_STATUS.draft)
              await tx.append({ taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: id, from: fresh, to: TASK_STATUS.cancelled } })
          })
          continue
        }
        if (t.status === TASK_STATUS.running || t.status === TASK_STATUS.blocked)
          await cancelOne(id, state)
      }
    },
  }

  // port-level: child-terminal events → split_resolved + DBOS.send; approved children → run start.
  // References port.startChildRun, so it is built after the port object.
  const router = createSignalRouter({
    log,
    onChildApproved: id => port.startChildRun(id),
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
  cls: FailureClass = FAILURE_CLASS.agent_error,
): Promise<StepResult> {
  await checkpoint('finish', async () => message, () => [
    { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: cls, message } },
  ])
  return { stepId: args.stepId, ok: false }
}
