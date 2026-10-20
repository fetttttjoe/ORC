import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { DBOS, Error as DBOSError } from '@dbos-inc/dbos-sdk'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { events } from '../schema'
import {
  ApprovalPolicy, ChatOpenedPayload, Door, EVENT_KIND, FailureClass, FINISH_STEP_ID, NO_CHAT, OperationKind, OperationStatus, PAYLOAD_SCHEMAS, SignalOutcome, StepRunStatus, TASK_STATUS,
  type AgentExecutor, type EventDraft, type EventRecord, type ExecutorContext, type Origin, type PlanDraft,
  type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { openStorage, type EventLog } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig, waitFor } from '../test-helpers'
import { appendRunInit, createDbosPort, runQueueOptions, type DbosPort } from './dbos-port'
import { runOrigin } from './run-chat'

// The door the supervisor's test setup uses; the run's own events carry the run chat.
const CLI: Origin = NO_CHAT(Door.cli)

// One DBOS runtime per process (registerWorkflow rejects duplicates): one port + DB, per-task
const behaviors = new Map<string, Record<string, 'ok' | 'fail'>>()
// tasks in this set run their model effect through ctx.operation and count executions
const operationTasks = new Set<string>()
const operationRuns = new Map<string, number>()
// tasks here write `write` files into the workspace and declare `declare` in their signal
const outputsByTask = new Map<string, { write: string[]; declare: string[] }>()
// Keyed by TASK AND STEP: the kernel's finish step runs this same fake executor.
const spyKey = (taskId: string, stepId: string): string => `${taskId}:${stepId}`
const priorFailures = new Map<string, ExecutorContext<unknown>['priorFailure'] | null>()
// Every step surface the port asked for, verbatim; shows writes use the task's workspace.
const stepToolsCalls: Array<{ taskId: string; stepId: string; workspaceId: string }> = []

function fakeExecutor(): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const taskId = must(ctx.runToken.split(':')[1], 'task id in runToken')
      const key = spyKey(taskId, ctx.step.id)
      priorFailures.set(key, ctx.priorFailure ?? null)
      const behavior = behaviors.get(taskId) ?? {}
      // journal and output scripts are per-TASK: the finish step journals nothing, or counts would double
      const scripted = ctx.step.id !== FINISH_STEP_ID
      if (scripted && operationTasks.has(taskId))
        await ctx.operation(
          { operationId: `${ctx.runToken}:model:1`, kind: OperationKind.model, name: 'fake/m', before: { iteration: 1 } },
          async () => {
            operationRuns.set(taskId, (operationRuns.get(taskId) ?? 0) + 1)
            return { ok: true }
          },
        )
      const outcome = behavior[ctx.step.id] === 'fail' ? SignalOutcome.failure : SignalOutcome.success
      const summary = `${ctx.step.id}:${outcome} deps=[${Object.keys(ctx.depOutputs).sort().join(',')}] skills=[${ctx.skills.map(s => s.name)}] tools=[${ctx.extraTools.map(t => t.name)}]`
      const outputSpec = scripted ? outputsByTask.get(taskId) : undefined
      for (const f of outputSpec?.write ?? []) writeFileSync(path.join(ctx.workspaceDir, f), `content of ${f}`)
      const signal = {
        stepId: ctx.step.id, runToken: ctx.runToken, outcome, summary,
        ...(outputSpec ? { outputs: outputSpec.declare } : {}),
      }
      await ctx.checkpoint(
        'model:1',
        async () => summary,
        (): EventDraft[] => [{ kind: EVENT_KIND.agent_call, payload: { stepId: ctx.step.id, runToken: ctx.runToken, iteration: 1, request: {}, response: { summary } }, usage: { inputTokens: 1, outputTokens: 1, costUSD: 0.001, estimated: false } }],
      )
      await ctx.checkpoint(
        'signal:1',
        async () => signal,
        (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }],
      )
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

const twoStepDraft = (): PlanDraft => draftFixture([
  stepFixture({ id: 'a', title: 'a', instructions: 'first' }),
  stepFixture({ id: 'b', title: 'b', instructions: 'second', dependsOn: ['a'] }),
])

describe('DBOS execution port (integration)', () => {
  let kernel: Kernel
  let port: DbosPort
  let log: EventLog
  let teardown: () => Promise<void>
  let dbUrl: string
  let projectDir: string
  // Interleaving seam: runs before any log transaction opens; null except in the test that arms it.
  let beforeTransaction: (() => Promise<void>) | null = null

  beforeAll(async () => {
    const db = await createTestDb()
    dbUrl = db.url
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    log = storage.events
    // patched once on the shared log — the port is built one time for the whole file
    const realTransaction = log.transaction.bind(log)
    log.transaction = async fn => {
      if (beforeTransaction) await beforeTransaction()
      return realTransaction(fn)
    }
    kernel = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    // isolated dir: tests that write real files must land in scratch, never the actual repo
    projectDir = mkdtempSync(path.join(tmpdir(), 'orc-project-'))
    const config = testConfig(db.url, { dir: projectDir })
    port = await createDbosPort({
      storage, config, executorId: 'supervisor-test',
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', fakeExecutor()]]),
      skills: {
        load: async (name: string) => {
          if (name === 'ghost-skill') throw new Error(`unknown skill 'ghost-skill'`)
          return { name, body: `body of ${name}`, hash: `hash-${name}` }
        },
      },
      // Records what the port offers a step and adds no tools, so other tests see the same surface.
      stepTools: p => { stepToolsCalls.push({ taskId: p.taskId, stepId: p.stepId, workspaceId: p.workspaceId }); return [] },
      tools: {
        close: async () => {},
        resolve: async (refs: string[]) => refs.map(ref => {
          if (ref === 'fixture/nosuch') throw new Error(`unknown tool 'nosuch' on MCP server 'fixture'`)
          return {
            ref, name: `mcp__${ref.replaceAll('/', '__')}`, description: 'd', inputSchema: {},
            execute: async () => ({ output: { ok: true }, isError: false }),
          }
        }),
      },
    })
    await port.launch()
    teardown = async () => { await port.shutdown(); await log.close(); await db.drop() }
  })
  afterAll(async () => { await teardown() })

  async function approvedTask(behavior: Record<string, 'ok' | 'fail'> = {}, draft: PlanDraft = twoStepDraft()) {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'exec test', spec: 'run the dag' }, CLI)
    behaviors.set(t.id, behavior)
    await kernel.proposePlan(t.id, draft, CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)
    return t
  }

  it('boots under the identity it was given, so DBOS recovery is scoped to that supervisor', async () => {
    // DBOS.executorID is the SDK's own view; the env var is read at module load, before launch().
    expect(DBOS.executorID).toBe('supervisor-test')
    expect(port.executorId).toBe('supervisor-test')
  })

  it('runs a 2-step DAG to done, threading dep outputs, in order', async () => {
    const t = await approvedTask()
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe(RunOutcome.done)

    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.status).toBe(StepRunStatus.completed)
    expect(state.steps.get(t.id)?.get('b')?.status).toBe(StepRunStatus.completed)
    // b saw a's output (the signal summary)
    expect(state.steps.get(t.id)?.get('b')?.output).toContain('deps=[a]')
    // event ordering: run_started before any step_started; a completes before b starts
    const kinds = (await kernel.eventsFor(t.id)).map(e => e.kind)
    expect(kinds.indexOf(EVENT_KIND.run_started)).toBeLessThan(kinds.indexOf(EVENT_KIND.step_started))
  }, 15_000)

  // A run IS a chat; asserted on the committed log, not on the port's arguments.
  it('a run is one chat: chat_opened once before run_started, and every event of the run carries the run id under the supervisor door', async () => {
    const t = await approvedTask()
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe(RunOutcome.done)

    const events = await kernel.eventsFor(t.id)
    const opened = events.filter(e => e.kind === EVENT_KIND.chat_opened)
    expect(opened).toHaveLength(1)
    const open = must(opened[0], 'chat_opened event')
    expect(ChatOpenedPayload.parse(open.payload).chatId).toBe(handle.workflowId)
    // nothing may claim to be inside a chat that has not been opened yet
    expect(open.seq).toBeLessThan(must(events.find(e => e.kind === EVENT_KIND.run_started), 'run_started event').seq)

    const inRun = events.filter(e => e.seq >= open.seq)
    const stray = (e: EventRecord): string => `${e.kind}@${e.chatId ?? 'null'}/${e.door}`
    expect(inRun.filter(e => e.chatId !== handle.workflowId).map(stray)).toEqual([])
    expect(inRun.filter(e => e.door !== Door.supervisor).map(stray)).toEqual([])
  }, 15_000)

  // A retry gets a new workflow id, so it is a new chat.
  it('a retry opens a SECOND chat, named by the retry workflow id', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    const first = await port.startRun(t.id)
    expect(await first.wait()).toBe(RunOutcome.blocked)

    behavior.b = 'ok'
    const retry = await port.retry(t.id)
    expect(await retry.wait()).toBe(RunOutcome.done)

    const chats = (await kernel.eventsFor(t.id))
      .filter(e => e.kind === EVENT_KIND.chat_opened)
      .map(e => ChatOpenedPayload.parse(e.payload).chatId)
    expect(chats).toEqual([first.workflowId, retry.workflowId])
    expect(must(chats[1], 'retry chat id').endsWith(':r1')).toBe(true)
  }, 20_000)

  // A split child's chat answers to the split_proposed on the PARENT's stream, by {chatId, seq}.
  it("a split child's run chat names the parent run's split_proposed as its parent", async () => {
    const t = await approvedTask()
    // a chatless split names no parent, so this split must come from a real chat
    const splitterChatId = 'chat-split-parent'
    const splitter: Origin = { chatId: splitterChatId, door: Door.web }
    const split = await kernel.proposeSplit({
      parentTaskId: t.id, stepId: 'a', runToken: `step:${t.id}:a:a1`, toolCallId: 'call_chat',
      title: 'child', spec: 'child work',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }, splitter)
    const proposed = must((await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_proposed), 'split proposed event')

    const workflowId = `run:${split.childTaskId}:v1`
    await log.transaction(tx => appendRunInit(
      tx, { taskId: split.childTaskId, planVersion: 1, retryIndex: 0, cwd: null, origin: runOrigin(workflowId) }, workflowId))

    const opened = must((await kernel.eventsFor(split.childTaskId)).find(e => e.kind === EVENT_KIND.chat_opened), 'child chat_opened event')
    expect(opened.chatId).toBe(workflowId)
    expect(ChatOpenedPayload.parse(opened.payload).parent).toEqual({ chatId: splitterChatId, seq: proposed.seq })
  }, 15_000)

  it('hands every step surface the workspace its OWN task names, so an agent write is stamped from the task, not the supervisor cwd', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)
    const seen = stepToolsCalls.filter(c => c.taskId === t.id)
    expect(seen.map(c => c.stepId).sort()).toEqual(['a', 'b', FINISH_STEP_ID])
    // The value, not presence: a step run in a worktree must not inherit the booting checkout.
    for (const c of seen) expect(c.workspaceId).toBe(TEST_WORKSPACE_ID)
    // 15s: a full run is three steps and bun's default 5s cuts it off mid-pipeline
  }, 15_000)

  it('startRun is idempotent — second call attaches, no duplicate run_started', async () => {
    const t = await approvedTask()
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(h1.workflowId).toBe(h2.workflowId)
    await h1.wait()
    const runs = (await kernel.state()).runs.get(t.id) ?? []
    expect(runs).toHaveLength(1)
  }, 15_000) // two steps plus the appended finish step no longer fit bun's default 5s

  // A blocked run returns normally, so DBOS marks it SUCCESS: re-running must not re-attach to it.
  it('re-running a settled task starts a new run instead of replaying the finished one', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    const first = await port.startRun(t.id)
    expect(await first.wait()).toBe(RunOutcome.blocked)

    behavior.b = 'ok' // the world is fixed; `orc run` must now actually run
    const second = await port.startRun(t.id)
    expect(second.workflowId).not.toBe(first.workflowId)
    expect(await second.wait()).toBe(RunOutcome.done)
  }, 15_000) // two full DBOS workflows — bun's 5s default is too tight under suite load

  it('failed step blocks task; retry re-runs only the failed step to done', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.blocked)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    behavior.b = 'ok' // human "fixed the world"
    const retry = await port.retry(t.id)
    expect(retry.workflowId).toContain(':r1')
    expect(await retry.wait()).toBe(RunOutcome.done)

    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.attempt).toBe(1) // completed step NOT re-run
    expect(state.steps.get(t.id)?.get('b')?.attempt).toBe(2)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  }, 15_000) // two full DBOS workflows — bun's 5s default is too tight under suite load

  it('a retried step is handed its previous attempt failure; its first attempt is not', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.blocked)
    expect(priorFailures.get(spyKey(t.id, 'b'))).toBeNull()
    const failed = must((await kernel.state()).steps.get(t.id)?.get('b')?.failure, 'b failed')
    behavior.b = 'ok'
    expect(await (await port.retry(t.id)).wait()).toBe(RunOutcome.done)
    expect(priorFailures.get(spyKey(t.id, 'b'))).toEqual({ attempt: 1, class: failed.class, message: failed.message })
    expect(priorFailures.get(spyKey(t.id, 'a'))).toBeNull()
  }, 15_000)

  // A run with no explicit cwd works on the project, never in an empty scratch dir
  it('a bare startRun records the project dir as its cwd', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)
    expect((await kernel.state()).runs.get(t.id)?.at(-1)?.cwd).toBe(projectDir)
  }, 15_000)

  // Repair path: edit blocked, approve, `orc run` picks the REPAIRED version, re-runs nothing done
  it("a blocked task's plan can be edited and the repaired plan is what the resumed run uses", async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.blocked)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    // same DAG, but b carries a marker the frozen v1 lacks, so its output proves WHICH version ran
    const repaired = await kernel.editPlan(t.id, draftFixture([
      stepFixture({ id: 'a', title: 'a', instructions: 'first' }),
      stepFixture({ id: 'b', title: 'b', instructions: 'second', dependsOn: ['a'], skillRefs: ['repaired-skill'] }),
    ]), CLI)
    expect(repaired.version).toBe(2)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.awaiting_approval)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)
    expect((await kernel.state()).plans.get(t.id)?.approvedVersion).toBe(2)

    behavior.b = 'ok'
    const resumed = await port.startRun(t.id)
    expect(resumed.workflowId).toContain(':v2') // the LATEST approved version, not the blocked run's v1
    expect(await resumed.wait()).toBe(RunOutcome.done)

    const state = await kernel.state()
    expect(state.runs.get(t.id)?.at(-1)?.planVersion).toBe(2)
    expect(state.steps.get(t.id)?.get('b')?.output).toContain('skills=[repaired-skill]') // ran the CORRECTED step
    expect(state.steps.get(t.id)?.get('a')?.attempt).toBe(1) // a completed under v1 and is not re-run
    expect(state.steps.get(t.id)?.get('b')?.attempt).toBe(2) // the step that never completed re-runs
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  }, 20_000)

  // A retry inherits the latest non-null cwd: null-cwd runs in history must not poison inheritance.
  it("retry without --cwd inherits the last run that HAD a cwd, over null-cwd history", async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    const shared = mkdtempSync(path.join(tmpdir(), 'orc-cwd-'))
    expect(await (await port.startRun(t.id, { cwd: shared })).wait()).toBe(RunOutcome.blocked)
    // fabricate a pre-fix bare retry: run_started with cwd null (only records the run in fold)
    await log.transaction(async tx => {
      await tx.append({
        ...runOrigin(`run:${t.id}:v1:r1`), taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.run_started,
        payload: { taskId: t.id, planVersion: 1, retryIndex: 1, workflowId: `run:${t.id}:v1:r1`, cwd: null },
      })
    })

    behavior.b = 'ok'
    expect(await (await port.retry(t.id)).wait()).toBe(RunOutcome.done)

    const runs = (await kernel.state()).runs.get(t.id) ?? []
    expect(runs.map(r => r.cwd)).toEqual([shared, null, shared]) // inherited past the poison, not defaulted away
  }, 15_000)

  // Containment: an uncaught run-workflow error after 'running' settles 'blocked', not stuck
  it('an uncaught run-workflow failure is contained: the task settles blocked, not stuck running', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ id: 'a', title: 'a', instructions: 'only' })]))
    let finishThrows = 0
    beforeTransaction = async () => {
      // the LAST step's completion is the finish step: the injection must land in the run's finish path
      if (!(await log.byTask(t.id)).some(e => e.kind === EVENT_KIND.step_completed && e.stepId === FINISH_STEP_ID)) return
      // fail every finish attempt (RETRY_POLICY = 4), then stop so the catch's contain append commits
      if (finishThrows < 4) { finishThrows++; throw new Error('PROBE: injected finish-path failure') }
    }
    let threw = false
    try {
      await (await port.startRun(t.id)).wait()
    } catch { threw = true } finally {
      beforeTransaction = null
    }
    expect(finishThrows).toBe(4)  // the injection actually armed and exhausted retries
    expect(threw).toBe(true)      // the original error still propagates to the caller
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked) // contained → retryable, not stuck running
  }, 30_000)

  // A resumed init re-runs its body: appendRunInit twice with the same args must be a no-op.
  it('re-running init (the resume replay window) is a no-op, not an idempotency conflict', async () => {
    const t = await approvedTask()
    const workflowId = `run:${t.id}:v1`
    const args = { taskId: t.id, planVersion: 1, retryIndex: 0, cwd: null, origin: runOrigin(workflowId) }
    await log.transaction(tx => appendRunInit(tx, args, workflowId))
    await log.transaction(tx => appendRunInit(tx, args, workflowId)) // = DBOS replaying init fn() — must not throw
    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.run_started)).toHaveLength(1)
    // the replay must not re-open the run's chat: chat_opened is keyed by the chat id
    expect(events.filter(e => e.kind === EVENT_KIND.chat_opened)).toHaveLength(1)
    const toStatus = z.object({ to: z.string() })
    const running = events.filter(e => e.kind === EVENT_KIND.task_status_changed && toStatus.parse(e.payload).to === TASK_STATUS.running)
    expect(running).toHaveLength(1)
  })

  it('ctx.operation journals before/after and runs the effect once across attached workflows', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture()]))
    operationTasks.add(t.id)
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(await h1.wait()).toBe(RunOutcome.done)
    expect(await h2.wait()).toBe(RunOutcome.done)
    expect(operationRuns.get(t.id)).toBe(1)

    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.operation_started)).toHaveLength(1)
    expect(events.filter(e => e.kind === EVENT_KIND.operation_completed)).toHaveLength(1)
    const op = [...(await kernel.state()).operations.values()].find(o => o.taskId === t.id)
    expect(op?.status).toBe(OperationStatus.completed)
    expect(op?.attempts).toBe(1)
    expect(op?.after).toEqual({ ok: true })
  })

  it('declared outputs are verified and receipted atomically before step completion', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture()]))
    outputsByTask.set(t.id, { write: ['report.md'], declare: ['report.md'] })
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)

    const taskEvents = await kernel.eventsFor(t.id)
    const receipt = taskEvents.find(e => e.kind === EVENT_KIND.artifact_produced)
    const completed = taskEvents.find(e => e.kind === EVENT_KIND.step_completed)
    expect(receipt?.payload).toEqual({
      path: 'report.md',
      sha256: createHash('sha256').update('content of report.md').digest('hex'),
      size: 'content of report.md'.length,
    })
    expect(must(receipt, 'artifact produced event').seq).toBeLessThan(must(completed, 'step completed event').seq)
    const artifacts = (await kernel.state()).artifacts.get(t.id)
    expect(artifacts).toHaveLength(1)
    expect(must(artifacts?.[0], 'first artifact').path).toBe('report.md')
  })

  it('a missing declared output blocks the step with validation_error and no receipt', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture()]))
    outputsByTask.set(t.id, { write: [], declare: ['ghost.md'] })
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.blocked)

    const taskEvents = await kernel.eventsFor(t.id)
    expect(taskEvents.some(e => e.kind === EVENT_KIND.step_completed)).toBe(false)
    expect(taskEvents.some(e => e.kind === EVENT_KIND.artifact_produced)).toBe(false)
    const failure = (await kernel.state()).steps.get(t.id)?.get('s1')?.failure
    expect(failure?.class).toBe(FailureClass.validation_error)
    expect(failure?.message).toContain('ghost.md')
  })

  it('refuses to run an unapproved task', async () => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'nope' }, CLI)
    await expect(port.startRun(t.id)).rejects.toThrow(/approve/)
  })

  it('fails the step (no wedge) when modelRef is unresolvable', async () => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'bad model', spec: 'x' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ modelRef: 'nope/x' })]), CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.blocked)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)
    const failure = (await kernel.state()).steps.get(t.id)?.get('s1')?.failure
    expect(failure?.class).toBeTruthy()
    expect(failure?.message).toContain('nope/x')
  })

  it('refuses to cancel a done task (no status event appended)', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)
    const before = (await kernel.eventsFor(t.id)).length
    await expect(port.cancelRun(t.id, CLI)).rejects.toThrow(/running or blocked/)
    expect((await kernel.eventsFor(t.id)).length).toBe(before)
  }, 15_000) // two steps plus the appended finish step no longer fit bun's default 5s

  // The cancel/finish race, driven: a cancel before the finish append must not be overwritten.
  it('a cancel landing at the finish append is not overwritten by running→done', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ id: 'a', title: 'a', instructions: 'only' })]))
    let injected = false
    beforeTransaction = async () => {
      if (injected) return
      // the LAST step's completion (the finish step), so the cancel lands at the run's finish append
      if (!(await log.byTask(t.id)).some(e => e.kind === EVENT_KIND.step_completed && e.stepId === FINISH_STEP_ID)) return
      injected = true // set BEFORE the append: log.append re-enters this same hook
      await log.append({
        ...CLI, taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
        payload: { taskId: t.id, from: TASK_STATUS.running, to: TASK_STATUS.cancelled },
      })
    }
    try {
      // a DBOSWorkflowCancelledError is a valid outcome: the live router cancels the workflow too
      await (await port.startRun(t.id)).wait().catch(err => {
        if (!(err instanceof DBOSError.DBOSWorkflowCancelledError)) throw err
      })
    } finally {
      beforeTransaction = null
    }

    // guards the test itself: an unarmed hook would pass for the wrong reason
    expect(injected).toBe(true)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.cancelled)
    // and the run did not append a competing terminal status behind it
    const terminal = (await kernel.eventsFor(t.id))
      .filter(e => e.kind === EVENT_KIND.task_status_changed)
      .map(e => PAYLOAD_SCHEMAS.task_status_changed.parse(e.payload).to)
    expect(terminal.at(-1)).toBe(TASK_STATUS.cancelled)
    expect(terminal).not.toContain(TASK_STATUS.done)
  }, 15_000)

  it('cancelRun cascades to the subtree: a gated child (never started) is cancelled too', async () => {
    const t = await approvedTask({ s1: 'fail' }, draftFixture([stepFixture()]))
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.blocked)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    // manual policy parks the child at awaiting_approval, so setup is race-free against the router
    const split = await kernel.proposeSplit({
      parentTaskId: t.id, stepId: 's1', runToken: `step:${t.id}:s1:a1`, toolCallId: 'call_1',
      title: 'child', spec: 'child work',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }, CLI)
    expect(split.gated).toBe(true)
    expect((await kernel.getTask(split.childTaskId))?.status).toBe(TASK_STATUS.awaiting_approval)

    await port.cancelRun(t.id, CLI)

    // the canceller's door, not the port's: cancelRun records the origin it was handed.
    const cancelled = (await kernel.eventsFor(split.childTaskId)).filter(e => e.kind === EVENT_KIND.task_status_changed)
    expect(cancelled.at(-1)?.door).toBe(Door.cli)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.cancelled)
    expect((await kernel.getTask(split.childTaskId))?.status).toBe(TASK_STATUS.cancelled)

    // the router resolves the pending split off the cancelled child; split_resolved lands on the PARENT
    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.split_resolved))).toBe(true)
    const resolved = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_resolved)
    expect(PAYLOAD_SCHEMAS.split_resolved.parse(must(resolved, 'split resolved event').payload).outcome).toBe(RunOutcome.cancelled)
  })

  it('refuses to retry a task that is not blocked (no second concurrent run)', async () => {
    const t = await approvedTask()
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // approved, never run
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // done — nothing to retry
    expect((await kernel.state()).runs.get(t.id)).toHaveLength(1)
  }, 15_000) // two steps plus the appended finish step no longer fit bun's default 5s

  it('force-loads skills: skill_loaded events in init, bodies handed to the executor', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['style-guide'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe(RunOutcome.done)
    const events = await kernel.eventsFor(t.id)
    // per step: the finish step force-loads its own role skill, which would blur THIS step's count
    const loaded = events.filter(e => e.kind === EVENT_KIND.skill_loaded && e.stepId === 's1')
    expect(loaded).toHaveLength(1)
    expect(events.filter(e => e.kind === EVENT_KIND.skill_loaded && e.stepId === FINISH_STEP_ID)).toHaveLength(1)
    expect(must(loaded[0], 'first loaded skill event').payload).toMatchObject({ name: 'style-guide', hash: 'hash-style-guide' })
    const done = events.find(e => e.kind === EVENT_KIND.step_completed)
    expect(PAYLOAD_SCHEMAS.step_completed.parse(must(done, 'step completed event').payload).summary).toContain('skills=[style-guide]')
  })

  it('resolves toolRefs into executor extraTools', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ toolRefs: ['fixture/echo'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe(RunOutcome.done)
    const done = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed)
    expect(PAYLOAD_SCHEMAS.step_completed.parse(must(done, 'step completed event').payload).summary).toContain('tools=[mcp__fixture__echo]')
  })

  it('unknown skill fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['ghost-skill'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe(RunOutcome.blocked)
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect(PAYLOAD_SCHEMAS.step_failed.parse(must(failed, 'step failed event').payload).class).toBe(FailureClass.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('unknown tool ref fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ toolRefs: ['fixture/nosuch'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe(RunOutcome.blocked)
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect(PAYLOAD_SCHEMAS.step_failed.parse(must(failed, 'step failed event').payload).class).toBe(FailureClass.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('a workflow input whose step has no toolRefs replays to done (no TypeError on undefined.length)', async () => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'legacy plan', spec: 'x' }, CLI)
    // write straight into the events table: a re-parse would restore toolRefs via .default([])
    const draft = draftFixture([stepFixture()])
    const legacyStep: Record<string, unknown> = { ...stepFixture() }
    delete legacyStep.toolRefs
    const legacyPlan = { ...draft, steps: [legacyStep], taskId: t.id, version: 1 }
    const pool = new pg.Pool({ connectionString: dbUrl })
    try {
      const raw = drizzle(pool)
      await raw.insert(events).values({
        projectId: TEST_PROJECT_ID, chatId: CLI.chatId, door: CLI.door, taskId: t.id, kind: EVENT_KIND.plan_proposed,
        payload: { plan: legacyPlan },
      })
      await raw.insert(events).values({
        projectId: TEST_PROJECT_ID, chatId: CLI.chatId, door: CLI.door, taskId: t.id, kind: EVENT_KIND.task_status_changed,
        payload: { taskId: t.id, from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval },
      })
    } finally {
      await pool.end()
    }

    await kernel.approvePlan(t.id, undefined, undefined, CLI)
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)
    expect((await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.step_failed)).toBe(false)
  })
})

describe('runQueueOptions', () => {
  // startChildRun and startRunAt must agree on the queue, or a run escapes the depth concurrency cap
  it('leaves a root run unqueued and puts every deeper run on its depth queue', () => {
    expect(runQueueOptions(0)).toEqual({})            // runs:0 is never registered
    expect(runQueueOptions(1)).toEqual({ queueName: 'runs:1' })
    expect(runQueueOptions(3)).toEqual({ queueName: 'runs:3' })
  })
})
