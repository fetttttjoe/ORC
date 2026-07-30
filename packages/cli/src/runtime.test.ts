import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MEMORY_HEALTH,
  EVENT_KIND, SIGNAL_OUTCOME, STEP_ROLE, VERIFY_STEP_ID,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { Surreal } from 'surrealdb'
import { openStorage, Kernel, projectDatabaseName, type ProjectConfig } from '@orc/kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createMemory } from '@orc/memory'
import { buildProgram } from './main'
import { buildPlugins, buildRuntime } from './runtime'

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealBases: ProjectConfig[] = []
// Registered the moment each resource exists, drained LIFO BEFORE the databases go. A bare
// `await port.shutdown()` as the last statement of an it() is SKIPPED when an assertion above it
// throws, leaking a launched DBOS runtime into every later test file in the process — that is
// what turned one failed assertion on this branch into a 22-failure mystery, and it is why the
// db.drop() below got skipped and left orc_test_* databases behind. Same idiom as
// kernel/src/execution/memory-access.integration.test.ts.
const cleanup: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const c of cleanup.reverse()) await c()
  for (const d of dbs) await d.drop()
  for (const c of surrealBases) {
    const s = new Surreal()
    await s.connect(c.projectDbUrl)
    await s.signin({ username: c.projectDbUser, password: c.projectDbPassword })
    await s.use({ namespace: c.projectDbNamespace })
    await s.query(`REMOVE DATABASE IF EXISTS \`${projectDatabaseName(c.projectDbName, c.projectId)}\`;`).catch(() => {})
    await s.close()
  }
})

// captures the memory tools the port hands each step, then signals success
const toolProbe: { results: { name: string; isError: boolean; output: unknown }[] } = { results: [] }
const probeExecutor: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    const inputs: Record<string, unknown> = {
      memory_write: { id: 'x', title: 'X' },
      memory_search: { query: 'x' },
      memory_read: { id: 'x' },
      memory_neighbors: { seed: 'x' },
      memory_topics: {},
    }
    for (const t of ctx.extraTools.filter(t => t.name.startsWith('memory_'))) {
      const r = await t.execute(inputs[t.name])
      toolProbe.results.push({ name: t.name, isError: r.isError, output: r.output })
    }
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: 'probed' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

// records the extraTools names each step actually receives, keyed by step id — the mirror image
// of toolProbe above (which only cares about memory_* execute() results): this one never calls a
// tool, it just proves whether stepTools registered it, since memory_verify appending an event
// nobody asked for would be a second, unrelated way this test could fail.
const toolNamesByStep: Record<string, string[]> = {}
const toolNameExecutor: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    toolNamesByStep[ctx.step.id] = ctx.extraTools.map(t => t.name)
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: 'probed' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

// C.5: memory_verify is gated on the SAME predicate scoped_changes uses (role===auditor AND
// stepId===VERIFY_STEP_ID) — see plugins/memory/src/tools.ts memoryVerifyTool. 'buildRuntime
// degraded memory' below pins the negative half against a BROKEN store (no memoryStore, so the
// tool is absent regardless of role); this pins the positive half against a HEALTHY one, so the
// registration line itself (runtime.ts stepTools, `...(memoryStore ? memoryVerifyTool(...) : [])`)
// is what is on test. Declared FIRST, ahead of that test, for a DBOS reason, not an ordering
// preference: see the teardown comment inside the `it` below.
describe('stepTools memory_verify registration', () => {
  it('offers memory_verify to a healthy store\'s auditor verify step, and withholds it from a plain worker step', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-verify-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbName })
    surrealBases.push(config)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', toolNameExecutor)
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    // Torn down HERE, not via the shared `cleanup` array: DBOS registration is process-global (one
    // `DBOS.launch()` per process), and `cleanup` only drains at the file's afterAll — the NEXT
    // test's buildRuntime() call ('buildRuntime degraded memory' below) would collide with this
    // port still being "launched". Shutting it down immediately, in `finally` so a thrown
    // assertion cannot skip it, is what lets the two coexist in one file.
    try {
      const verifyTask = await kernel.createTask({ title: 'verify step', spec: 'audits' })
      await kernel.proposePlan(verifyTask.id, draftFixture([stepFixture({ id: VERIFY_STEP_ID, role: STEP_ROLE.auditor })]))
      await kernel.approvePlan(verifyTask.id)
      expect(await (await port.startRun(verifyTask.id)).wait()).toBe('done')

      const workerTask = await kernel.createTask({ title: 'worker step', spec: 'implements' })
      await kernel.proposePlan(workerTask.id, draftFixture([stepFixture({ id: 's1', role: STEP_ROLE.worker })]))
      await kernel.approvePlan(workerTask.id)
      expect(await (await port.startRun(workerTask.id)).wait()).toBe('done')

      expect(toolNamesByStep[VERIFY_STEP_ID]).toContain('memory_verify')
      expect(toolNamesByStep['s1']).not.toContain('memory_verify')
    } finally {
      await port.shutdown()
      await log.close()
    }
  }, 60_000)
})

describe('buildRuntime degraded memory', () => {
  it('a broken Surreal config yields one warning + explicit unavailable tools; execution still completes', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-'))
    const config = testConfig(db.url, {
      vaultDir,
      skillsDir: path.join(vaultDir, 'skills'),
      projectDbUrl: 'not-a-url', // malformed on purpose: createMemory must throw, runtime must degrade
    })
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', probeExecutor)

    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    cleanup.push(() => log.close(), () => port.shutdown())
    mock.restore()
    expect(warns.filter(w => w.includes('memory unavailable; continuing in degraded mode'))).toHaveLength(1)

    const t = await kernel.createTask({ title: 'degraded run', spec: 'still executes' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture()]))
    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    // all five memory tools exist and each returns an explicit isError result with the reason.
    // FIVE, deliberately: memory_verify is NOT one of them and must not be added here. It is gated
    // twice — to the auditor's verify step (this run's fixture step is neither) and to a healthy
    // memory (this run has none) — so a sixth name appearing in this set means a gate came off.
    expect(new Set(toolProbe.results.map(r => r.name))).toEqual(
      new Set(['memory_write', 'memory_search', 'memory_read', 'memory_neighbors', 'memory_topics']))
    for (const r of toolProbe.results) {
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r.output)).toContain('memory unavailable')
    }
  }, 60_000)
})

describe('status memory health', () => {
  it('reports healthy, pending-events, and unreachable states without failing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-status-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbName })
    surrealBases.push(config)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const status = async (cfg: typeof config, taskId: string) => {
      lines.length = 0
      await buildProgram(kernel, undefined, { host, hub, config: cfg, log }).parseAsync(['status', taskId], { from: 'user' })
      return lines.join('\n')
    }

    const t = await kernel.createTask({ title: 'health check' })
    // ok: derived database opens (auto-created) with cursor 0 and no memory events
    const memory = await createMemory({ log, config })
    await memory.close()
    expect(await status(config, t.id)).toContain(`memory: ${MEMORY_HEALTH.ok}`)

    // behind, not broken: a projector that has not drained yet is a healthy system mid-write
    await log.append({
      taskId: null, stepId: null, runToken: null, kind: 'memory_written',
      payload: {
        note: { id: 'pending-note', title: 'P', scope: 'project', kind: 'fact', sourceRevision: null, categories: [], tags: [], links: [], paths: [], summary: '', body: '' },
        author: { source: 'cli' },
      },
    })
    expect(await status(config, t.id)).toContain(`memory: ${MEMORY_HEALTH.catchingUp} (1 event(s) not yet projected)`)

    // unreachable database → the one real fault, and status still exits normally
    const broken = testConfig(db.url, { ...config, projectDbUrl: 'not-a-url' })
    expect(await status(broken, t.id)).toContain(`memory: ${MEMORY_HEALTH.unreachable}`)

    mock.restore()
  }, 30_000)
})
