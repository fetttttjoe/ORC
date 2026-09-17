import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MEMORY_HEALTH,
  EVENT_KIND, FINISH_STEP_ID, MEMORY_TOOL_NAME, ROLE_SKILL, SIGNAL_OUTCOME, STEP_ROLE, VERIFY_STEP_ID,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { Surreal } from 'surrealdb'
import { openStorage, Kernel, projectDatabaseName, SCOPED_CHANGES_TOOL_NAME, type ProjectConfig } from '@orc/kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, testConfig, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createMemory, FINISH_TOOL_NAME } from '@orc/memory'
import { buildProgram } from './main'
import { buildPlugins, buildRuntime, seedPhases } from './runtime'
import { seedShippedSkills } from './shipped-skills'

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
      memory_recheck: {},
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

// C.5: memory_verify is gated on contracts' stepMayVerify — the same predicate scoped_changes uses.
// 'buildRuntime degraded memory' below pins the negative half against a BROKEN store (no
// memoryStore, so the tool is absent regardless of role); this pins the positive half against a
// HEALTHY one, so the registration line itself (runtime.ts stepTools) is what is on test. Declared
// FIRST for a DBOS reason, not an ordering preference: see the teardown comment inside the `it`.
// any auditor step earns the tool, whatever a plan calls it — named once rather than inline
const AUDITOR_STEP_NAMED_FOR_ITS_JOB = 'heal'

// The boot line must account for the storage open, and on the real `orc serve` path bin.ts opens
// storage BEFORE buildRuntime — so buildRuntime's own bootPhase('storage', ...) never runs there
// and the phase silently vanished from the line. Seeding is the fix; these pin the rule.
describe('seedPhases (the boot line accounts for a storage open it did not perform)', () => {
  it("leads with 'storage' when the caller opened it and timed it", () => {
    expect(seedPhases(true, 1360)).toEqual([['storage', 1360]])
  })

  it('stays empty when buildRuntime will time its own open — no invented phase', () => {
    // no shared storage: buildRuntime opens it itself and bootPhase records the real duration
    expect(seedPhases(false, undefined)).toEqual([])
    // shared storage but the caller did not time it: reporting a number nobody measured is worse
    // than omitting the phase, so absence wins over a fabricated zero
    expect(seedPhases(true, undefined)).toEqual([])
    // a duration with no shared storage is not this path's business — buildRuntime times its own
    expect(seedPhases(false, 1360)).toEqual([])
  })
})

describe('stepTools memory_verify registration', () => {
  it('offers memory_verify to a healthy store\'s auditor verify step, and withholds it from a plain worker step', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-verify-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbName })
    // Seeded the way `orc init` seeds a real project: the kernel appends a finish step declaring
    // ROLE_SKILL.finisher to every root plan, and a temp skills dir that nothing seeds fails the
    // run at step init with "unknown skill 'role-finisher'". ONE seeder (shipped-skills.ts) — a
    // harness pointing at the repo's own vault instead would hide exactly the case where orc ships
    // a skill no project has yet.
    seedShippedSkills(config.skillsDir)
    surrealBases.push(config)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    // the workspace must sit at THIS config's dir: buildRuntime resolves the consolidation and
    // auto-heal authors from the directory it serves, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
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
      const verifyTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'verify step', spec: 'audits' })
      await kernel.proposePlan(verifyTask.id, draftFixture([stepFixture({ id: VERIFY_STEP_ID, role: STEP_ROLE.auditor })]))
      await kernel.approvePlan(verifyTask.id)
      expect(await (await port.startRun(verifyTask.id)).wait()).toBe('done')

      const workerTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'worker step', spec: 'implements' })
      await kernel.proposePlan(workerTask.id, draftFixture([stepFixture({ id: 's1', role: STEP_ROLE.worker })]))
      await kernel.approvePlan(workerTask.id)
      expect(await (await port.startRun(workerTask.id)).wait()).toBe('done')

      // an auditor step named for its JOB, not for this gate — the case that silently lost the tool
      const healTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'heal step', spec: 'confirms notes' })
      await kernel.proposePlan(healTask.id, draftFixture([stepFixture({ id: AUDITOR_STEP_NAMED_FOR_ITS_JOB, role: STEP_ROLE.auditor })]))
      await kernel.approvePlan(healTask.id)
      expect(await (await port.startRun(healTask.id)).wait()).toBe('done')

      // The finish step is APPENDED by the kernel to every root plan, and proposePlan
      // REFUSES a draft that names it — so the fixture is a plain one-step draft and the step under
      // test is the one the kernel added. That is the only shape this step ever has in production; a
      // hand-authored 'finish' step could not reach the port at all.
      const finishTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'finish step', spec: 'reconciles' })
      await kernel.proposePlan(finishTask.id, draftFixture([stepFixture({ id: 'lead', role: STEP_ROLE.worker })]))
      await kernel.approvePlan(finishTask.id)
      expect(await (await port.startRun(finishTask.id)).wait()).toBe('done')

      expect(toolNamesByStep[VERIFY_STEP_ID]).toContain(MEMORY_TOOL_NAME.verify)
      expect(toolNamesByStep[AUDITOR_STEP_NAMED_FOR_ITS_JOB]).toContain(MEMORY_TOOL_NAME.verify)
      expect(toolNamesByStep['s1']).not.toContain(MEMORY_TOOL_NAME.verify)

      // The finish step's surface as an EXACT set of its own: a plain worker step's tools
      // PLUS exactly the three stepMayReconcile arms. Expressed as a delta against 's1' rather than
      // a re-listed surface so the shared part cannot drift between the two assertions, and exact
      // rather than toContain because the failure this catches is a gate coming OFF — an ordinary
      // step gaining record_decision, which a containment check would never see.
      expect(new Set(toolNamesByStep[FINISH_STEP_ID]))
        .toEqual(new Set([...(toolNamesByStep['s1'] ?? []), FINISH_TOOL_NAME.taskNotes, FINISH_TOOL_NAME.recordDecision, SCOPED_CHANGES_TOOL_NAME]))
      expect(toolNamesByStep['s1']).not.toContain(FINISH_TOOL_NAME.recordDecision)
      expect(toolNamesByStep['s1']).not.toContain(FINISH_TOOL_NAME.taskNotes)
      expect(toolNamesByStep['s1']).not.toContain(SCOPED_CHANGES_TOOL_NAME)
    } finally {
      await port.shutdown()
      await log.close()
    }
  }, 60_000)
})

// The kernel APPENDS steps a planner never authored — the finish step declares
// ROLE_SKILL.finisher, the commit step ROLE_SKILL.committer — so a checkout whose skills dir was
// never seeded is already broken before anyone asks it to do anything. It used to say so only at
// proposePlan ("unknown skill 'role-finisher'"), which is correct but arrives when a human is
// already trying to start work. buildRuntime names it once per missing skill at boot instead.
describe('buildRuntime role-skill pre-flight', () => {
  it('warns at boot for a skills dir nothing seeded, naming the skill and the fix — and still boots', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-skills-'))
    // deliberately NOT seedShippedSkills(config.skillsDir) — that absence IS the case under test.
    // projectDbUrl is malformed so no Surreal database is created for a run that never touches
    // memory: the pre-flight reads the skill index, which has nothing to do with the read model.
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbUrl: 'not-a-url' })
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)

    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    mock.restore()
    // Shut down HERE in `finally`, not via the shared `cleanup` array: DBOS launch is
    // process-global, and the degraded-memory test below builds its own runtime.
    try {
      const named = warns.filter(w => w.includes(ROLE_SKILL.finisher))
      // ONE line, not one per caller of the index: a repeated warning reads as a repeated fault
      expect(named).toHaveLength(1)
      // the skill, where it was looked for, and the command that fixes it — a warning an operator
      // cannot act on is one they learn to scroll past
      expect(named[0]).toContain(config.skillsDir)
      expect(named[0]).toContain('orc init')
      // every shipped role skill is missing here, so each gets its own line — the finish step is
      // not the only kernel-appended step that declares one
      for (const skill of Object.values(ROLE_SKILL)) expect(warns.some(w => w.includes(skill))).toBe(true)
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
    // Seeded the way `orc init` seeds a real project: the kernel appends a finish step declaring
    // ROLE_SKILL.finisher to every root plan, and a temp skills dir that nothing seeds fails the
    // run at step init with "unknown skill 'role-finisher'". ONE seeder (shipped-skills.ts) — a
    // harness pointing at the repo's own vault instead would hide exactly the case where orc ships
    // a skill no project has yet.
    seedShippedSkills(config.skillsDir)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    // the workspace must sit at THIS config's dir: buildRuntime resolves the consolidation and
    // auto-heal authors from the directory it serves, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', probeExecutor)

    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    cleanup.push(() => log.close(), () => port.shutdown())
    mock.restore()
    expect(warns.filter(w => w.includes('memory unavailable; continuing in degraded mode'))).toHaveLength(1)
    // ...and the role-skill pre-flight stays SILENT here: this harness seeds the shipped set the
    // way `orc init` does, and a warning that fires for a correctly seeded project is noise an
    // operator learns to ignore — which is how the real one would then get missed.
    expect(warns.filter(w => w.includes(ROLE_SKILL.finisher))).toEqual([])

    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'degraded run', spec: 'still executes' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture()]))
    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    // all six memory tools exist and each returns an explicit isError result with the reason.
    // SIX, deliberately: memory_verify is NOT one of them and must not be added here. It is gated
    // twice — to the auditor's verify step (this run's fixture step is neither) and to a healthy
    // memory (this run has none) — so a seventh name appearing in this set means a gate came off.
    expect(new Set(toolProbe.results.map(r => r.name))).toEqual(
      new Set(['memory_write', 'memory_search', 'memory_read', 'memory_neighbors', 'memory_topics', 'memory_recheck']))
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
    // Seeded the way `orc init` seeds a real project: the kernel appends a finish step declaring
    // ROLE_SKILL.finisher to every root plan, and a temp skills dir that nothing seeds fails the
    // run at step init with "unknown skill 'role-finisher'". ONE seeder (shipped-skills.ts) — a
    // harness pointing at the repo's own vault instead would hide exactly the case where orc ships
    // a skill no project has yet.
    seedShippedSkills(config.skillsDir)
    surrealBases.push(config)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    // the workspace must sit at THIS config's dir: buildRuntime resolves the consolidation and
    // auto-heal authors from the directory it serves, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const status = async (cfg: typeof config, taskId: string) => {
      lines.length = 0
      await buildProgram(kernel, undefined, { host, hub, config: cfg, log }).parseAsync(['status', taskId], { from: 'user' })
      return lines.join('\n')
    }

    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'health check' })
    // ok: derived database opens (auto-created) with cursor 0 and no memory events
    const memory = await createMemory({ log, config })
    await memory.close()
    expect(await status(config, t.id)).toContain(`memory: ${MEMORY_HEALTH.ok}`)

    // behind, not broken: a projector that has not drained yet is a healthy system mid-write
    await log.append({
      taskId: null, stepId: null, runToken: null, kind: 'memory_written',
      payload: {
        note: { id: 'pending-note', title: 'P', scope: 'project', kind: 'fact', sourceRevision: null, categories: [], tags: [], links: [], paths: [], summary: '', body: '' },
        author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID },
      },
    })
    expect(await status(config, t.id)).toContain(`memory: ${MEMORY_HEALTH.catchingUp} (1 event(s) not yet projected)`)

    // unreachable database → the one real fault, and status still exits normally
    const broken = testConfig(db.url, { ...config, projectDbUrl: 'not-a-url' })
    expect(await status(broken, t.id)).toContain(`memory: ${MEMORY_HEALTH.unreachable}`)

    mock.restore()
  }, 30_000)
})
