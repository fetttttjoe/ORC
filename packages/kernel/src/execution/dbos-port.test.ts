import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { events } from '../schema'
import {
  ApprovalPolicy, EVENT_KIND, FAILURE_CLASS, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type PlanDraft,
  type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage, type EventLog } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort, type DbosPort } from './dbos-port'

// One DBOS runtime per process: registerWorkflow throws on duplicate names, so the whole file
// shares ONE port + DB. Per-task scripting isolates the scenarios (behavior keyed by taskId,
// which the executor recovers from runToken = step:<taskId>:<stepId>:a<attempt>).
const behaviors = new Map<string, Record<string, 'ok' | 'fail'>>()
// tasks in this set run their model effect through ctx.operation and count executions
const operationTasks = new Set<string>()
const operationRuns = new Map<string, number>()
// tasks here write `write` files into the workspace and declare `declare` in their signal
const outputsByTask = new Map<string, { write: string[]; declare: string[] }>()

function fakeExecutor(): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const taskId = ctx.runToken.split(':')[1]!
      const behavior = behaviors.get(taskId) ?? {}
      if (operationTasks.has(taskId))
        await ctx.operation(
          { operationId: `${ctx.runToken}:model:1`, kind: 'model', name: 'fake/m', before: { iteration: 1 } },
          async () => {
            operationRuns.set(taskId, (operationRuns.get(taskId) ?? 0) + 1)
            return { ok: true }
          },
        )
      const outcome = behavior[ctx.step.id] === 'fail' ? SIGNAL_OUTCOME.failure : SIGNAL_OUTCOME.success
      const summary = `${ctx.step.id}:${outcome} deps=[${Object.keys(ctx.depOutputs).sort().join(',')}] skills=[${ctx.skills.map(s => s.name)}] tools=[${ctx.extraTools.map(t => t.name)}]`
      const outputSpec = outputsByTask.get(taskId)
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
  // Interleaving seam: runs just before any log transaction opens, so a test can commit a
  // competing write into a check-then-append window. Null except inside the test that arms it.
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
    // isolated dir: bare runs now default their workspace to config.dir — tests that write
    // real files (declared outputs) must land in a scratch dir, never the actual repo
    projectDir = mkdtempSync(path.join(tmpdir(), 'orc-project-'))
    const config = testConfig(db.url, { dir: projectDir })
    port = await createDbosPort({
      storage, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', fakeExecutor()]]),
      skills: {
        load: async (name: string) => {
          if (name === 'ghost-skill') throw new Error(`unknown skill 'ghost-skill'`)
          return { name, body: `body of ${name}`, hash: `hash-${name}` }
        },
      },
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
    const t = await kernel.createTask({ title: 'exec test', spec: 'run the dag' })
    behaviors.set(t.id, behavior)
    await kernel.proposePlan(t.id, draft)
    await kernel.approvePlan(t.id)
    return t
  }

  it('runs a 2-step DAG to done, threading dep outputs, in order', async () => {
    const t = await approvedTask()
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')

    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.status).toBe('completed')
    expect(state.steps.get(t.id)?.get('b')?.status).toBe('completed')
    // b saw a's output (the signal summary)
    expect(state.steps.get(t.id)?.get('b')?.output).toContain('deps=[a]')
    // event ordering: run_started before any step_started; a completes before b starts
    const kinds = (await kernel.eventsFor(t.id)).map(e => e.kind)
    expect(kinds.indexOf(EVENT_KIND.run_started)).toBeLessThan(kinds.indexOf(EVENT_KIND.step_started))
  }, 15_000)

  it('startRun is idempotent — second call attaches, no duplicate run_started', async () => {
    const t = await approvedTask()
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(h1.workflowId).toBe(h2.workflowId)
    await h1.wait()
    const runs = (await kernel.state()).runs.get(t.id) ?? []
    expect(runs).toHaveLength(1)
  })

  it('failed step blocks task; retry re-runs only the failed step to done', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    behavior.b = 'ok' // human "fixed the world"
    const retry = await port.retry(t.id)
    expect(retry.workflowId).toContain(':r1')
    expect(await retry.wait()).toBe('done')

    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.attempt).toBe(1) // completed step NOT re-run
    expect(state.steps.get(t.id)?.get('b')?.attempt).toBe(2)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  }, 15_000) // two full DBOS workflows — bun's 5s default is too tight under suite load

  // A run with no explicit cwd works on the project, never in an empty scratch dir — scenario-2
  // burned five verify attempts in workspaces where every fs_read of the repo was ENOENT.
  it('a bare startRun records the project dir as its cwd', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    expect((await kernel.state()).runs.get(t.id)?.at(-1)?.cwd).toBe(projectDir)
  }, 15_000)

  // A retry must re-enter the world the run failed in. Inheritance skips null-cwd runs: histories
  // from before the project-dir default carry bare retries (scenario-2's log is exactly
  // [repo, null, null, null]) that would poison plain last-run inheritance.
  it("retry without --cwd inherits the last run that HAD a cwd, over null-cwd history", async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    const shared = mkdtempSync(path.join(tmpdir(), 'orc-cwd-'))
    expect(await (await port.startRun(t.id, { cwd: shared })).wait()).toBe('blocked')
    // fabricate a pre-fix bare retry: run_started with cwd null (only records the run in fold)
    await log.transaction(async tx => {
      await tx.append({
        taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.run_started,
        payload: { taskId: t.id, planVersion: 1, retryIndex: 1, workflowId: `run:${t.id}:v1:r1`, cwd: null },
      })
    })

    behavior.b = 'ok'
    expect(await (await port.retry(t.id)).wait()).toBe('done')

    const runs = (await kernel.state()).runs.get(t.id) ?? []
    expect(runs.map(r => r.cwd)).toEqual([shared, null, shared]) // inherited past the poison, not defaulted away
  }, 15_000)

  it('ctx.operation journals before/after and runs the effect once across attached workflows', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture()]))
    operationTasks.add(t.id)
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(await h1.wait()).toBe('done')
    expect(await h2.wait()).toBe('done')
    expect(operationRuns.get(t.id)).toBe(1)

    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.operation_started)).toHaveLength(1)
    expect(events.filter(e => e.kind === EVENT_KIND.operation_completed)).toHaveLength(1)
    const op = [...(await kernel.state()).operations.values()].find(o => o.taskId === t.id)
    expect(op?.status).toBe('completed')
    expect(op?.attempts).toBe(1)
    expect(op?.after).toEqual({ ok: true })
  })

  it('declared outputs are verified and receipted atomically before step completion', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture()]))
    outputsByTask.set(t.id, { write: ['report.md'], declare: ['report.md'] })
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    const taskEvents = await kernel.eventsFor(t.id)
    const receipt = taskEvents.find(e => e.kind === EVENT_KIND.artifact_produced)
    const completed = taskEvents.find(e => e.kind === EVENT_KIND.step_completed)
    expect(receipt?.payload).toEqual({
      path: 'report.md',
      sha256: createHash('sha256').update('content of report.md').digest('hex'),
      size: 'content of report.md'.length,
    })
    expect(receipt!.seq).toBeLessThan(completed!.seq)
    const artifacts = (await kernel.state()).artifacts.get(t.id)
    expect(artifacts).toHaveLength(1)
    expect(artifacts![0]!.path).toBe('report.md')
  })

  it('a missing declared output blocks the step with validation_error and no receipt', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture()]))
    outputsByTask.set(t.id, { write: [], declare: ['ghost.md'] })
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')

    const taskEvents = await kernel.eventsFor(t.id)
    expect(taskEvents.some(e => e.kind === EVENT_KIND.step_completed)).toBe(false)
    expect(taskEvents.some(e => e.kind === EVENT_KIND.artifact_produced)).toBe(false)
    const failure = (await kernel.state()).steps.get(t.id)?.get('s1')?.failure
    expect(failure?.class).toBe(FAILURE_CLASS.validation_error)
    expect(failure?.message).toContain('ghost.md')
  })

  it('refuses to run an unapproved task', async () => {
    const t = await kernel.createTask({ title: 'nope' })
    await expect(port.startRun(t.id)).rejects.toThrow(/approve/)
  })

  it('fails the step (no wedge) when modelRef is unresolvable', async () => {
    const t = await kernel.createTask({ title: 'bad model', spec: 'x' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ modelRef: 'nope/x' })]))
    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)
    const failure = (await kernel.state()).steps.get(t.id)?.get('s1')?.failure
    expect(failure?.class).toBeTruthy()
    expect(failure?.message).toContain('nope/x')
  })

  it('refuses to cancel a done task (no status event appended)', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    const before = (await kernel.eventsFor(t.id)).length
    await expect(port.cancelRun(t.id)).rejects.toThrow(/running or blocked/)
    expect((await kernel.eventsFor(t.id)).length).toBe(before)
  })

  // The cancel/finish race, driven rather than argued. The run's terminal append is the only
  // write that can land on top of a cancellation: fold is last-seq-wins with no `from` check
  // (projections.ts), so whichever status is appended last wins outright.
  //
  // The seam is `log.transaction` itself. `beforeTransaction` fires immediately BEFORE the
  // finish path opens its transaction — chosen because it is the one window that reproduces the
  // defect under BOTH shapes of the code. The original wrote the status check and the append as
  // two transactions (read in `fn()`, append from `toEvents` via makeCheckpoint), so a cancel
  // here lands after that read and gets overwritten by running→done. The current code does the
  // re-check and the append in one locked transaction, so the same cancel commits first and the
  // re-check sees it. Same injection, opposite outcome — which is what makes this a test and
  // not a restatement.
  //
  // Armed only once `step_completed` is committed, so the injected cancel cannot land mid-run,
  // where the old code's read would have caught it anyway and the test would pass vacuously.
  it('a cancel landing at the finish append is not overwritten by running→done', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ id: 'a', title: 'a', instructions: 'only' })]))
    let injected = false
    beforeTransaction = async () => {
      if (injected) return
      if (!(await log.byTask(t.id)).some(e => e.kind === EVENT_KIND.step_completed)) return
      injected = true // set BEFORE the append: log.append re-enters this same hook
      await log.append({
        taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
        payload: { taskId: t.id, from: TASK_STATUS.running, to: TASK_STATUS.cancelled },
      })
    }
    try {
      await (await port.startRun(t.id)).wait()
    } finally {
      beforeTransaction = null
    }

    // guards the test itself: if the hook never armed, the assertion below would pass for the
    // wrong reason (a task that was simply never cancelled)
    expect(injected).toBe(true)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.cancelled)
    // and the run did not append a competing terminal status behind it
    const terminal = (await kernel.eventsFor(t.id))
      .filter(e => e.kind === EVENT_KIND.task_status_changed)
      .map(e => (e.payload as { to: string }).to)
    expect(terminal.at(-1)).toBe(TASK_STATUS.cancelled)
    expect(terminal).not.toContain(TASK_STATUS.done)
  }, 15_000)

  it('cancelRun cascades to the subtree: a gated child (never started) is cancelled too', async () => {
    const t = await approvedTask({ s1: 'fail' }, draftFixture([stepFixture()]))
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    // manual (default) policy parks the child at awaiting_approval — it never gets a run,
    // so the router never touches it and this setup is race-free against the live router.
    const split = await kernel.proposeSplit({
      parentTaskId: t.id, stepId: 's1', runToken: `step:${t.id}:s1:a1`, toolCallId: 'call_1',
      title: 'child', spec: 'child work',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    })
    expect(split.gated).toBe(true)
    expect((await kernel.getTask(split.childTaskId))?.status).toBe(TASK_STATUS.awaiting_approval)

    await port.cancelRun(t.id)

    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.cancelled)
    expect((await kernel.getTask(split.childTaskId))?.status).toBe(TASK_STATUS.cancelled)

    // the router (live in this harness) resolves the still-pending split off the cancelled
    // child's terminal status — split_resolved lands on the PARENT (split.taskId = parentTaskId)
    const waitFor = async (pred: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
      const start = Date.now()
      while (Date.now() - start < ms) { if (await pred()) return true; await Bun.sleep(50) }
      return false
    }
    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.split_resolved))).toBe(true)
    const resolved = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_resolved)
    expect((resolved!.payload as { outcome: string }).outcome).toBe('cancelled')
  })

  it('refuses to retry a task that is not blocked (no second concurrent run)', async () => {
    const t = await approvedTask()
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // approved, never run
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // done — nothing to retry
    expect((await kernel.state()).runs.get(t.id)).toHaveLength(1)
  })

  it('force-loads skills: skill_loaded events in init, bodies handed to the executor', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['style-guide'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')
    const events = await kernel.eventsFor(t.id)
    const loaded = events.filter(e => e.kind === EVENT_KIND.skill_loaded)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.payload).toMatchObject({ name: 'style-guide', hash: 'hash-style-guide' })
    const done = events.find(e => e.kind === EVENT_KIND.step_completed)
    expect((done!.payload as { summary: string }).summary).toContain('skills=[style-guide]')
  })

  it('resolves toolRefs into executor extraTools', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ toolRefs: ['fixture/echo'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')
    const done = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed)
    expect((done!.payload as { summary: string }).summary).toContain('tools=[mcp__fixture__echo]')
  })

  it('unknown skill fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['ghost-skill'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('blocked')
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect((failed!.payload as { class: string }).class).toBe(FAILURE_CLASS.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('unknown tool ref fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ toolRefs: ['fixture/nosuch'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('blocked')
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect((failed!.payload as { class: string }).class).toBe(FAILURE_CLASS.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('a pre-M3 plan with no toolRefs in the log replays to done (no TypeError on undefined.length)', async () => {
    const t = await kernel.createTask({ title: 'legacy plan', spec: 'x' })
    // Kernel.proposePlan and even a direct EventLog.append re-parse payloads through the Plan
    // zod schema, which would restore toolRefs via its .default([]) — masking the bug. The only
    // honest way to reproduce a row that predates the field is to write it straight into the
    // events table, bypassing that parse, exactly like a pre-M3 row already sitting in the log.
    const draft = draftFixture([stepFixture()])
    const legacyStep: Record<string, unknown> = { ...stepFixture() }
    delete legacyStep.toolRefs
    const legacyPlan = { ...draft, steps: [legacyStep], taskId: t.id, version: 1 }
    const pool = new pg.Pool({ connectionString: dbUrl })
    try {
      const raw = drizzle(pool)
      await raw.insert(events).values({
        projectId: TEST_PROJECT_ID, taskId: t.id, kind: EVENT_KIND.plan_proposed,
        payload: { plan: legacyPlan },
      })
      await raw.insert(events).values({
        projectId: TEST_PROJECT_ID, taskId: t.id, kind: EVENT_KIND.task_status_changed,
        payload: { taskId: t.id, from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval },
      })
    } finally {
      await pool.end()
    }

    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    expect((await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.step_failed)).toBe(false)
  })
})
