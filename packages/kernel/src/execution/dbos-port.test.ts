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
  ApprovalPolicy, EVENT_KIND, FAILURE_CLASS, FINISH_STEP_ID, PAYLOAD_SCHEMAS, SIGNAL_OUTCOME, STEP_ID, STEP_ROLE, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type PlanDraft,
  type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import type { GroundingNoteRef, GroundingSource } from './strategies/grounding-freshness'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { openStorage, type EventLog } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig, waitFor } from '../test-helpers'
import { appendRunInit, createDbosPort, runQueueOptions, type DbosPort } from './dbos-port'

// One DBOS runtime per process: registerWorkflow throws on duplicate names, so the whole file
// shares ONE port + DB. Per-task scripting isolates the scenarios (behavior keyed by taskId,
// which the executor recovers from runToken = step:<taskId>:<stepId>:a<attempt>).
const behaviors = new Map<string, Record<string, 'ok' | 'fail'>>()
// tasks in this set run their model effect through ctx.operation and count executions
const operationTasks = new Set<string>()
const operationRuns = new Map<string, number>()
// tasks here write `write` files into the workspace and declare `declare` in their signal
const outputsByTask = new Map<string, { write: string[]; declare: string[] }>()
// Both spies below are keyed by TASK AND STEP: every root plan now ends with the kernel-appended
// finish step, which drives this same fake executor, so a per-task counter would read its turn as
// one more turn of the step under test (and its depOutputs would overwrite the scout's).
const spyKey = (taskId: string, stepId: string): string => `${taskId}:${stepId}`
// The executor SPY: the freshness short-circuit's whole claim is "no model turn ran", and only a
// counter on the executor itself can prove that — a verdict object proves nothing about the port.
const startTurns = new Map<string, number>()
// The ExecutorContext the port actually handed the executor. The mixed-verdict branch's claim is
// that the scan-scope directive reaches the scout THROUGH depOutputs — only the real context proves it.
const lastDepOutputs = new Map<string, Record<string, string>>()
// Scripted grounding probe for the freshness gate. One mutable holder: bun runs a file's tests
// serially and the port is built once for the whole file, so each test installs its own script.
let groundingScript: (GroundingSource & { probes: string[] }) | null = null
// Every step surface the port asked for, verbatim. The composition root builds an agent step's
// MemoryAuthor out of exactly this object, so what it carries is the only evidence that a write
// from a step is stamped with the workspace its TASK names rather than the supervisor's own cwd.
const stepToolsCalls: Array<{ taskId: string; stepId: string; workspaceId: string }> = []

function fakeExecutor(): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const taskId = must(ctx.runToken.split(':')[1], 'task id in runToken')
      const key = spyKey(taskId, ctx.step.id)
      startTurns.set(key, (startTurns.get(key) ?? 0) + 1)
      lastDepOutputs.set(key, ctx.depOutputs)
      const behavior = behaviors.get(taskId) ?? {}
      // the journal and declared-output scripts are per-TASK and describe the step under test —
      // the appended finish step journals no operation and declares no output of its own, or one
      // script would be replayed twice and every count in those two tests would double
      const scripted = ctx.step.id !== FINISH_STEP_ID
      if (scripted && operationTasks.has(taskId))
        await ctx.operation(
          { operationId: `${ctx.runToken}:model:1`, kind: 'model', name: 'fake/m', before: { iteration: 1 } },
          async () => {
            operationRuns.set(taskId, (operationRuns.get(taskId) ?? 0) + 1)
            return { ok: true }
          },
        )
      const outcome = behavior[ctx.step.id] === 'fail' ? SIGNAL_OUTCOME.failure : SIGNAL_OUTCOME.success
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

const notScripted = (): GroundingSource => { throw new Error('PROBE: no grounding script installed') }

// The one step shape the freshness gate looks at: STEP_ID.analyze + STEP_ROLE.scout.
const analyzeDraft = (): PlanDraft => draftFixture([
  stepFixture({ id: STEP_ID.analyze, role: STEP_ROLE.scout, title: 'Analyze the codebase', instructions: 'ground the task' }),
])

const HEAD_SHA = 'f'.repeat(40)
const OLD_SHA = '1'.repeat(40)

// installs a script and returns it, so a test can assert on the probe calls it actually made
function scriptGrounding(s: {
  head?: string | null
  notes?: GroundingNoteRef[] | (() => GroundingNoteRef[])
  commits?: (rev: string, paths: string[]) => number | null
  // omitted entirely = a source WITHOUT the optional probe (today's fake), which the mixed path
  // must still handle by falling back to the stale notes' declared paths
  changed?: (rev: string, paths: string[]) => string[] | null
  throws?: boolean
}): GroundingSource & { probes: string[] } {
  const probes: string[] = []
  const script: GroundingSource & { probes: string[] } = {
    probes,
    head: async () => {
      probes.push('head')
      if (s.throws) throw new Error('PROBE: git exploded')
      return s.head === undefined ? HEAD_SHA : s.head
    },
    notes: async () => {
      probes.push('notes')
      return typeof s.notes === 'function' ? s.notes() : (s.notes ?? [])
    },
    commitsSince: async (rev, paths) => {
      probes.push(`commitsSince:${rev}`)
      return s.commits ? s.commits(rev, paths) : 0
    },
    ...(s.changed
      ? {
          changedPaths: async (rev: string, paths: string[]) => {
            probes.push(`changedPaths:${rev}`)
            return s.changed!(rev, paths)
          },
        }
      : {}),
  }
  groundingScript = script
  return script
}

// Just the directive's per-note "in scope:" lines — the paths the scout is actually told to scan,
// as opposed to the paths a stale note's `why` quotes as the REASON it is stale.
const inScope = (directive: string): string =>
  directive.split('\n').filter(l => l.includes('in scope:')).join(' | ')

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
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    // isolated dir: bare runs now default their workspace to config.dir — tests that write
    // real files (declared outputs) must land in a scratch dir, never the actual repo
    projectDir = mkdtempSync(path.join(tmpdir(), 'orc-project-'))
    const config = testConfig(db.url, { dir: projectDir })
    port = await createDbosPort({
      storage, config, executorId: 'supervisor-test',
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', fakeExecutor()]]),
      // delegates to whatever the running test scripted; a test that scripts nothing gets a
      // throwing source, which the port must treat as "not fresh" rather than as a step failure
      groundingSource: {
        head: () => (groundingScript ?? notScripted()).head(),
        notes: () => (groundingScript ?? notScripted()).notes(),
        commitsSince: (rev, paths) => (groundingScript ?? notScripted()).commitsSince(rev, paths),
        // A GETTER, not a method. changedPaths is OPTIONAL on GroundingSource, and a test for
        // "a source built before this probe existed" is only honest if the property is genuinely
        // absent (`source.changedPaths?.(…)` → undefined) rather than present-but-returning-null.
        // A fixed method here would make that case untestable, since the port is built once for
        // the whole file and each test installs its own script afterwards.
        get changedPaths() {
          const s = groundingScript
          if (!s?.changedPaths) return undefined
          return (rev: string, paths: string[]) => s.changedPaths!(rev, paths)
        },
      },
      skills: {
        load: async (name: string) => {
          if (name === 'ghost-skill') throw new Error(`unknown skill 'ghost-skill'`)
          return { name, body: `body of ${name}`, hash: `hash-${name}` }
        },
      },
      // Records what the port offers a step and adds no tools — the surface every other test in
      // this file sees is unchanged (a port without stepTools contributes nothing either).
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
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'exec test', spec: 'run the dag' })
    behaviors.set(t.id, behavior)
    await kernel.proposePlan(t.id, draft)
    await kernel.approvePlan(t.id)
    return t
  }

  it('boots under the identity it was given, so DBOS recovery is scoped to that supervisor', async () => {
    // DBOS.executorID is the SDK's own view — process.env.DBOS__VMID is read at module load,
    // long before launch(), so asserting on the env var would pass while DBOS still used 'local'.
    expect(DBOS.executorID).toBe('supervisor-test')
    expect(port.executorId).toBe('supervisor-test')
  })

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

  it('hands every step surface the workspace its OWN task names, so an agent write is stamped from the task, not the supervisor cwd', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    const seen = stepToolsCalls.filter(c => c.taskId === t.id)
    expect(seen.map(c => c.stepId).sort()).toEqual(['a', 'b', FINISH_STEP_ID])
    // The value, not merely presence: the port reads it off the TaskNode it already folds for the
    // spec, so a step that ran in a worktree cannot inherit whichever checkout booted the port.
    for (const c of seen) expect(c.workspaceId).toBe(TEST_WORKSPACE_ID)
    // 15s, this file's budget for a full run: the plan is two steps plus the kernel's appended
    // finish step now, and bun's default 5s cut the run off mid-pipeline
  }, 15_000)

  it('startRun is idempotent — second call attaches, no duplicate run_started', async () => {
    const t = await approvedTask()
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(h1.workflowId).toBe(h2.workflowId)
    await h1.wait()
    const runs = (await kernel.state()).runs.get(t.id) ?? []
    expect(runs).toHaveLength(1)
  }, 15_000) // two steps plus the appended finish step no longer fit bun's default 5s

  // runWorkflow returns RUN_OUTCOME.blocked as a NORMAL return, so DBOS marks the workflow SUCCESS
  // and keeps its deterministic id. Re-running therefore re-attached to a FINISHED workflow and
  // replayed its cached result: `orc run` on a blocked task was admitted at every door (blocked is
  // drivable) and silently did nothing at all.
  it('re-running a settled task starts a new run instead of replaying the finished one', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    const first = await port.startRun(t.id)
    expect(await first.wait()).toBe('blocked')

    behavior.b = 'ok' // the world is fixed; `orc run` must now actually run
    const second = await port.startRun(t.id)
    expect(second.workflowId).not.toBe(first.workflowId)
    expect(await second.wait()).toBe('done')
  }, 15_000) // two full DBOS workflows — bun's 5s default is too tight under suite load

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

  // A run with no explicit cwd works on the project, never in an empty scratch dir —
  // a verify auditor burned five attempts in workspaces where every fs_read of the repo was ENOENT.
  it('a bare startRun records the project dir as its cwd', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    expect((await kernel.state()).runs.get(t.id)?.at(-1)?.cwd).toBe(projectDir)
  }, 15_000)

  // The blocking failure this repair path exists for: a plan froze a step whose zone entry could
  // match no path, so the step could not write its own files, and the task settled blocked with a
  // DEFECTIVE frozen plan. Retrying re-ran the same broken plan, and editPlan refused a blocked
  // task — the only exit was cancelling the task and discarding the steps that had succeeded.
  // Repair is now: edit while blocked → approve → `orc run` (port.startRun; port.retry stays
  // blocked-only, so approved resumes through the run door). The run must pick up the REPAIRED
  // version, not the one the blocked run froze, and must not re-run what already completed.
  it("a blocked task's plan can be edited and the repaired plan is what the resumed run uses", async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    // the correction: same DAG, but step b now carries a marker the frozen v1 does not have, so
    // the resumed step's own output proves WHICH version was instantiated
    const repaired = await kernel.editPlan(t.id, draftFixture([
      stepFixture({ id: 'a', title: 'a', instructions: 'first' }),
      stepFixture({ id: 'b', title: 'b', instructions: 'second', dependsOn: ['a'], skillRefs: ['repaired-skill'] }),
    ]))
    expect(repaired.version).toBe(2)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.awaiting_approval)
    await kernel.approvePlan(t.id)
    expect((await kernel.state()).plans.get(t.id)?.approvedVersion).toBe(2)

    behavior.b = 'ok'
    const resumed = await port.startRun(t.id)
    expect(resumed.workflowId).toContain(':v2') // the LATEST approved version, not the blocked run's v1
    expect(await resumed.wait()).toBe('done')

    const state = await kernel.state()
    expect(state.runs.get(t.id)?.at(-1)?.planVersion).toBe(2)
    expect(state.steps.get(t.id)?.get('b')?.output).toContain('skills=[repaired-skill]') // ran the CORRECTED step
    expect(state.steps.get(t.id)?.get('a')?.attempt).toBe(1) // a completed under v1 and is not re-run
    expect(state.steps.get(t.id)?.get('b')?.attempt).toBe(2) // the step that never completed re-runs
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  }, 20_000)

  // A retry must re-enter the world the run failed in. Inheritance skips null-cwd runs: histories
  // from before the project-dir default carry bare retries (the history was exactly
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

  // Containment: an uncaught error in the run workflow AFTER the task is 'running' must not
  // strand it 'running' with a burned ERROR workflow — it settles 'blocked', the retryable state.
  // Inject a throw into the finish path for all its retries, then let the contain transaction through.
  it('an uncaught run-workflow failure is contained: the task settles blocked, not stuck running', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ id: 'a', title: 'a', instructions: 'only' })]))
    let finishThrows = 0
    beforeTransaction = async () => {
      // the LAST step's completion, which is the kernel's appended finish step: the injection has
      // to land in the run workflow's finish path. Armed on the FIRST step_completed it fell on the
      // finish STEP's own transactions instead — that step failed, the run settled blocked the
      // ordinary way, and nothing propagated to the caller.
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

  // §D#2: DBOS re-executes a step's fn() from scratch when a crash lands between the init
  // checkpoint's own transaction committing and DBOS recording that step's output. Resume replays
  // init's whole body, including this append — simulate it by calling appendRunInit twice with the
  // same deterministic args + workflowId. The old code drafted the running-transition under a FIXED
  // key with a `from` recomputed in a separate transaction, so the second run saw status already
  // 'running' and redrafted {from:running} under the same key → idempotency_conflict, bricking the
  // task. The in-transaction status re-check makes the second call a clean no-op instead.
  it('D2: re-running init (the resume replay window) is a no-op, not an idempotency conflict', async () => {
    const t = await approvedTask()
    const args = { taskId: t.id, planVersion: 1, retryIndex: 0, cwd: null }
    const workflowId = `run:${t.id}:v1`
    await log.transaction(tx => appendRunInit(tx, args, workflowId))
    await log.transaction(tx => appendRunInit(tx, args, workflowId)) // = DBOS replaying init fn() — must not throw
    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.run_started)).toHaveLength(1)
    const toStatus = z.object({ to: z.string() })
    const running = events.filter(e => e.kind === EVENT_KIND.task_status_changed && toStatus.parse(e.payload).to === TASK_STATUS.running)
    expect(running).toHaveLength(1)
  })

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
    expect(must(receipt, 'artifact produced event').seq).toBeLessThan(must(completed, 'step completed event').seq)
    const artifacts = (await kernel.state()).artifacts.get(t.id)
    expect(artifacts).toHaveLength(1)
    expect(must(artifacts?.[0], 'first artifact').path).toBe('report.md')
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
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'nope' })
    await expect(port.startRun(t.id)).rejects.toThrow(/approve/)
  })

  it('fails the step (no wedge) when modelRef is unresolvable', async () => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'bad model', spec: 'x' })
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
  }, 15_000) // two steps plus the appended finish step no longer fit bun's default 5s

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
      // the LAST step's completion (the kernel's appended finish step), so the cancel still lands
      // at the run's finish append and not one whole step before it
      if (!(await log.byTask(t.id)).some(e => e.kind === EVENT_KIND.step_completed && e.stepId === FINISH_STEP_ID)) return
      injected = true // set BEFORE the append: log.append re-enters this same hook
      await log.append({
        taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
        payload: { taskId: t.id, from: TASK_STATUS.running, to: TASK_STATUS.cancelled },
      })
    }
    try {
      // the live router cancels the run's DBOS workflow on ANY cancelled
      // status, not only ones cancelRun itself produced. That reaction races this run's own
      // finish step for real, so DBOS may now refuse to record the run's success outcome —
      // a DBOSWorkflowCancelledError here is the correct new result of that race, and orthogonal
      // to what this test protects (asserted below: the event log never records a stale 'done'
      // behind the injected cancel).
      await (await port.startRun(t.id)).wait().catch(err => {
        if (!(err instanceof DBOSError.DBOSWorkflowCancelledError)) throw err
      })
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
      .map(e => PAYLOAD_SCHEMAS.task_status_changed.parse(e.payload).to)
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
    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.split_resolved))).toBe(true)
    const resolved = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.split_resolved)
    expect(PAYLOAD_SCHEMAS.split_resolved.parse(must(resolved, 'split resolved event').payload).outcome).toBe('cancelled')
  })

  it('refuses to retry a task that is not blocked (no second concurrent run)', async () => {
    const t = await approvedTask()
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // approved, never run
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // done — nothing to retry
    expect((await kernel.state()).runs.get(t.id)).toHaveLength(1)
  }, 15_000) // two steps plus the appended finish step no longer fit bun's default 5s

  it('force-loads skills: skill_loaded events in init, bodies handed to the executor', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['style-guide'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')
    const events = await kernel.eventsFor(t.id)
    // per step: the kernel's finish step force-loads its own role skill, and counting both here
    // would say nothing about whether THIS step's declared skill was loaded
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
    expect(await handle.wait()).toBe('done')
    const done = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed)
    expect(PAYLOAD_SCHEMAS.step_completed.parse(must(done, 'step completed event').payload).summary).toContain('tools=[mcp__fixture__echo]')
  })

  it('unknown skill fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['ghost-skill'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('blocked')
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect(PAYLOAD_SCHEMAS.step_failed.parse(must(failed, 'step failed event').payload).class).toBe(FAILURE_CLASS.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('unknown tool ref fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ toolRefs: ['fixture/nosuch'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('blocked')
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect(PAYLOAD_SCHEMAS.step_failed.parse(must(failed, 'step failed event').payload).class).toBe(FAILURE_CLASS.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('a pre-M3 plan with no toolRefs in the log replays to done (no TypeError on undefined.length)', async () => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'legacy plan', spec: 'x' })
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

  // ── the grounded analyze step's freshness short-circuit ────────────────────────────────────
  // Asserted on the EXECUTOR SPY, not on a verdict object: the claim is "no model turn ran".

  it('fresh grounding notes skip the analyze turn entirely, and both completion events carry the evidence', async () => {
    const probe = scriptGrounding({
      notes: [
        { id: 'arch-overview', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/kernel.ts'] },
        { id: 'area-execution', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/execution/dbos-port.ts'] },
      ],
      commits: () => 0,
    })
    const t = await approvedTask({}, analyzeDraft())
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBeUndefined() // the executor was never resolved, let alone driven
    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call && e.stepId === STEP_ID.analyze)).toHaveLength(0)
    expect((await kernel.state()).steps.get(t.id)?.get(STEP_ID.analyze)?.status).toBe('completed')

    // CONDITION 2: `orc log` must answer WHY it skipped without re-running anything — the note
    // ids, each note's sourceRevision, and the HEAD sha the gate compared against.
    const coverage = PAYLOAD_SCHEMAS.analysis_completed.parse(
      must(events.find(e => e.kind === EVENT_KIND.analysis_completed), 'analysis completed event').payload)
    const scopeText = coverage.scope.join(' | ')
    expect(scopeText).toContain('arch-overview')
    expect(scopeText).toContain('area-execution')
    expect(scopeText).toContain(OLD_SHA)
    expect(scopeText).toContain(HEAD_SHA)
    // skipped-but-grounded stays distinguishable from ungrounded: analyzed true, but marked a skip
    expect(coverage.analyzed).toBe(true)
    expect(coverage.notesWritten).toBe(0)
    expect(coverage.confidence).toBe('medium')
    expect(coverage.gaps.join(' | ')).toContain('skipped')

    // the plan step reads ONLY this summary (depOutputs[analyze]), so the evidence repeats here
    const summary = PAYLOAD_SCHEMAS.step_completed.parse(
      must(events.find(e => e.kind === EVENT_KIND.step_completed), 'step completed event').payload).summary
    expect(summary).toContain('arch-overview')
    expect(summary).toContain('area-execution')
    expect(summary).toContain(OLD_SHA)
    expect(summary).toContain(HEAD_SHA)
    expect(summary).toContain('memory_read')
    expect(summary).toContain('SKIPPED')
    expect(probe.probes.filter(p => p === 'notes')).toHaveLength(1)
  }, 15_000)

  it('stale notes fall through to the full analyze: the executor runs', async () => {
    scriptGrounding({
      notes: [{ id: 'area-execution', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/execution/dbos-port.ts'] }],
      commits: () => 4, // its declared paths moved
    })
    const t = await approvedTask({}, analyzeDraft())
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBe(1)
    // nothing reusable → nothing injected: the scout gets exactly today's context
    expect(lastDepOutputs.get(spyKey(t.id, STEP_ID.analyze))).toEqual({})
    const events = await kernel.eventsFor(t.id)
    expect(events.some(e => e.kind === EVENT_KIND.analysis_completed)).toBe(false)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call && e.stepId === STEP_ID.analyze)).toHaveLength(1)
    const summary = PAYLOAD_SCHEMAS.step_completed.parse(
      must(events.find(e => e.kind === EVENT_KIND.step_completed), 'step completed event').payload).summary
    expect(summary).toContain('analyze:success') // the executor's own summary, unchanged
  }, 15_000)

  it('no grounding notes at all falls through to the full analyze', async () => {
    scriptGrounding({ notes: [] })
    const t = await approvedTask({}, analyzeDraft())
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBe(1)
    expect((await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.analysis_completed)).toBe(false)
  }, 15_000)

  // ── MIXED: some notes current, some stale → reuse the current half, re-scan only the stale paths ──

  it('a MIXED verdict runs the scout but hands it the reused notes and a path-scoped directive', async () => {
    const probe = scriptGrounding({
      notes: [
        // current because its declared paths are UNCHANGED in the working tree (commits→0 for its
        // rev); its `why` therefore names no paths — the reused half must never leak a path into scope
        { id: 'arch-overview', sourceRevision: HEAD_SHA, paths: ['packages/kernel/src/kernel.ts'] },
        { id: 'area-execution', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/execution/dbos-port.ts', 'packages/kernel/src/execution/interpreter.ts'] },
      ],
      commits: rev => (rev === HEAD_SHA ? 0 : 3), // arch-overview clean in the tree; area-execution moved
      changed: () => ['packages/kernel/src/execution/dbos-port.ts'], // git narrows it to ONE file
    })
    const t = await approvedTask({}, analyzeDraft())
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBe(1) // mixed is NOT a skip — the scout still runs
    expect(probe.probes.some(p => p.startsWith('changedPaths:'))).toBe(true)

    // the directive reaches the scout through depOutputs, under the synthetic 'grounding' key
    const directive = lastDepOutputs.get(spyKey(t.id, STEP_ID.analyze))?.grounding ?? ''
    expect(directive).toContain('arch-overview')       // reuse this
    expect(directive).toContain('area-execution')      // re-scan this
    expect(directive).toContain('memory_read')
    // the stale note DECLARES two files and git says one moved: what the scout is told to scan is
    // the narrow list. (Its `why` still quotes the declared paths — that is the REASON it is stale,
    // which the directive owes the scout; what must be narrow is the in-scope list.)
    expect(inScope(directive)).toContain('packages/kernel/src/execution/dbos-port.ts')
    expect(inScope(directive)).not.toContain('interpreter.ts')
    expect(directive).not.toContain('packages/kernel/src/kernel.ts') // a REUSED note's paths, never re-scanned
    expect(directive).toContain(HEAD_SHA)

    // and the decision is in the log, answerable without re-running anything
    const events = await kernel.eventsFor(t.id)
    const coverage = PAYLOAD_SCHEMAS.analysis_completed.parse(
      must(events.find(e => e.kind === EVENT_KIND.analysis_completed), 'analysis completed event').payload)
    expect(coverage.scope.join(' | ')).toContain('arch-overview')
    const gaps = coverage.gaps.join(' | ')
    expect(coverage.gaps[0]).toContain('incremental re-scan')
    expect(gaps).toContain('area-execution')
    expect(gaps).toContain('packages/kernel/src/execution/dbos-port.ts')
    expect(coverage.analyzed).toBe(true)
    expect(coverage.notesWritten).toBe(0)
    expect(coverage.confidence).toBe('medium')
  }, 15_000)

  // The plan step reads ONLY depOutputs[analyze] = this summary, so the reused notes must be cited
  // there by the PORT — asserted on the committed event, not on the executor's own summary, because
  // the whole point is that it holds even when the scout never mentions them.
  it('a MIXED run cites the reused notes in the committed step_completed summary', async () => {
    const MID_SHA = '2'.repeat(40)
    scriptGrounding({
      notes: [
        { id: 'arch-overview', sourceRevision: MID_SHA, paths: ['packages/kernel/src/kernel.ts'] },
        { id: 'area-execution', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/execution/dbos-port.ts'] },
      ],
      commits: rev => (rev === MID_SHA ? 0 : 7), // arch-overview's paths are quiet; the other moved
      changed: () => ['packages/kernel/src/execution/dbos-port.ts'],
    })
    const t = await approvedTask({}, analyzeDraft())
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    const summary = PAYLOAD_SCHEMAS.step_completed.parse(
      must((await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed), 'step completed event').payload).summary
    expect(summary).toContain('analyze:success') // the executor's own summary is still there
    expect(summary).toContain('arch-overview')   // + the port's mechanical citation
    expect(summary).toContain(MID_SHA)           // the revision it was written at
    expect(summary).toContain(HEAD_SHA)          // and the sha it was verified current against
    expect(summary).toContain('memory_read')
  }, 15_000)

  it('a MIXED verdict without the optional changedPaths probe scopes to the stale notes declared paths', async () => {
    scriptGrounding({
      notes: [
        { id: 'arch-overview', sourceRevision: HEAD_SHA, paths: ['packages/kernel/src/kernel.ts'] },
        { id: 'area-execution', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/execution/dbos-port.ts', 'packages/kernel/src/execution/interpreter.ts'] },
      ],
      commits: rev => (rev === HEAD_SHA ? 0 : 2), // arch-overview clean in the tree; area-execution moved
      // no `changed`: the source has NO changedPaths at all, exactly like every pre-existing one
    })
    const t = await approvedTask({}, analyzeDraft())
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBe(1)
    const directive = lastDepOutputs.get(spyKey(t.id, STEP_ID.analyze))?.grounding ?? ''
    expect(directive).toContain('arch-overview')
    // no narrowing available → the scoped list IS the note's whole declared list
    expect(inScope(directive)).toContain('packages/kernel/src/execution/dbos-port.ts')
    expect(inScope(directive)).toContain('interpreter.ts')
    expect(directive).not.toContain('packages/kernel/src/kernel.ts')
    expect((await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.analysis_completed)).toBe(true)
  }, 15_000)

  // Same determinism rule as the skip path, one branch deeper: the SCOPE is part of the recorded
  // checkpoint output, so a replay renders the identical directive without asking git again.
  it('a MIXED decision (verdict AND scope) is recorded once: a replay re-uses it and raises no idempotency conflict', async () => {
    let notesCalls = 0
    scriptGrounding({
      notes: () => (++notesCalls === 1
        ? [
            { id: 'arch-overview', sourceRevision: HEAD_SHA, paths: ['packages/kernel/src/kernel.ts'] },
            { id: 'area-execution', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/execution/dbos-port.ts'] },
          ]
        : [{ id: 'area-cli', sourceRevision: null, paths: [] }]), // the world moves mid-run
      commits: rev => (rev === HEAD_SHA ? 0 : 3), // arch-overview clean in the tree; area-execution moved
      changed: () => ['packages/kernel/src/execution/dbos-port.ts'],
    })
    const t = await approvedTask({}, analyzeDraft())
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(await h1.wait()).toBe('done')
    expect(await h2.wait()).toBe('done')

    expect(notesCalls).toBe(1)          // the second, different answer was never consulted
    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBe(1) // one scout turn, not two
    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.analysis_completed)).toHaveLength(1)
    expect(events.filter(e => e.kind === EVENT_KIND.step_completed && e.stepId === STEP_ID.analyze)).toHaveLength(1)
    expect(events.some(e => e.kind === EVENT_KIND.step_failed)).toBe(false)
    const gaps = PAYLOAD_SCHEMAS.analysis_completed.parse(
      must(events.find(e => e.kind === EVENT_KIND.analysis_completed), 'analysis completed event').payload).gaps.join(' | ')
    expect(gaps).toContain('area-execution') // the ORIGINAL scope, not the moved world's
  }, 20_000)

  // git unavailable is never evidence of currency, and a throwing probe must not fail the step
  it('a grounding source that throws analyzes instead of failing the step', async () => {
    scriptGrounding({ throws: true })
    const t = await approvedTask({}, analyzeDraft())
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBe(1)
    const events = await kernel.eventsFor(t.id)
    expect(events.some(e => e.kind === EVENT_KIND.step_failed)).toBe(false)
    expect(events.some(e => e.kind === EVENT_KIND.analysis_completed)).toBe(false)
  }, 15_000)

  // CONDITION 1: every probe call happens inside the 'grounding' checkpoint's fn, so DBOS records
  // the VERDICT as that step's output. An attached/replayed workflow therefore re-uses the recorded
  // decision instead of asking git again — scripted here as a source whose SECOND answer differs.
  it('the verdict is recorded once inside the checkpoint: a replay re-uses it, it does not re-probe', async () => {
    let notesCalls = 0
    scriptGrounding({
      notes: () => (++notesCalls === 1
        ? [{ id: 'arch-overview', sourceRevision: OLD_SHA, paths: ['packages/kernel/src/kernel.ts'] }]
        : [{ id: 'arch-overview', sourceRevision: null, paths: [] }]), // the world moves mid-run
      commits: () => 0,
    })
    const t = await approvedTask({}, analyzeDraft())
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(await h1.wait()).toBe('done')
    expect(await h2.wait()).toBe('done')

    expect(notesCalls).toBe(1)                    // the second, different answer was never consulted
    expect(startTurns.get(spyKey(t.id, STEP_ID.analyze))).toBeUndefined()  // the recorded verdict still says skip
    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.analysis_completed)).toHaveLength(1)
    expect(events.filter(e => e.kind === EVENT_KIND.step_completed && e.stepId === STEP_ID.analyze)).toHaveLength(1)
    const summary = PAYLOAD_SCHEMAS.step_completed.parse(
      must(events.find(e => e.kind === EVENT_KIND.step_completed), 'step completed event').payload).summary
    expect(summary).toContain(OLD_SHA) // still the ORIGINAL verdict's evidence
  }, 20_000)
})

describe('runQueueOptions', () => {
  // The regression this pins is two call sites deciding independently: startChildRun queued a child
  // on runs:<depth> while startRunAt (subtree follow, `orc run <childId>`, retry) passed no queue,
  // so the same run escaped the depth concurrency cap depending on who started it.
  it('leaves a root run unqueued and puts every deeper run on its depth queue', () => {
    expect(runQueueOptions(0)).toEqual({})            // runs:0 is never registered
    expect(runQueueOptions(1)).toEqual({ queueName: 'runs:1' })
    expect(runQueueOptions(3)).toEqual({ queueName: 'runs:3' })
  })
})
