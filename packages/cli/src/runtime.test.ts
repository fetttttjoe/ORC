import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { MEMORY_HEALTH, ClaimClass, COMMIT_STEP_ID, DEFAULT_KNOWLEDGE_PLUGIN, Door, NO_CHAT,
  EVENT_KIND, FINISH_STEP_ID, KNOWLEDGE_REFUSAL, KnowledgeToolName, PlanNoteToolName, ROLE_SKILL, SignalOutcome, STEP_ID, STEP_ROLE, VERIFY_STEP_ID,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { Surreal } from 'surrealdb'
import { openStorage, Kernel, projectDatabaseName, SCOPED_CHANGES_TOOL_NAME, TASK_PLAN_TOOL_NAME, type ProjectConfig } from '@orc/kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, sh, testConfig, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { authorFixture, draftFixture, stepFixture } from '@orc/contracts/fixtures'

// these tests arrange through the CLI door; the runtime's own authors are Door.supervisor
const CLI = NO_CHAT(Door.cli)
import { createMemory } from '@orc/memory'
import { buildProgram } from './main'
import { buildPlugins, buildRuntime, seedPhases, workspaceStamps } from './runtime'
import { testSurrealDbName } from './test-helpers'
import { seedShippedSkills } from './shipped-skills'
import { openKnowledge } from './knowledge-open'

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
afterEach(() => mock.restore())

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
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary: 'probed' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

// records the extraTools names each step actually receives, keyed by step id — the mirror image
// of toolProbe above (which only cares about memory_* execute() results): this one never calls a
// tool, it just proves whether stepTools registered it.
const toolNamesByStep: Record<string, string[]> = {}
// whether the port forwarded ctx.knowledge (dbos-port.ts's `...(stepKnowledge && { knowledge })`,
// fed by runtime.ts's stepTools returning `knowledge: stepKnowledge.knowledge`), keyed by step id
const knowledgePresentByStep: Record<string, boolean> = {}
// scoped_changes' own execute() result per step — proves runtime.ts actually wired
// stepKnowledge.citing into scopedChangesTool's claimsAt, not just that the tool exists
const scopedChangesByStep: Record<string, { isError: boolean; output: unknown }> = {}
const ScopedChangesOutput = z.object({ citingClaims: z.array(z.unknown()).nullable(), degraded: z.array(z.string()).optional() })
const toolNameExecutor: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    toolNamesByStep[ctx.step.id] = ctx.extraTools.map(t => t.name)
    knowledgePresentByStep[ctx.step.id] = ctx.knowledge !== undefined
    const scopedChanges = ctx.extraTools.find(t => t.name === SCOPED_CHANGES_TOOL_NAME)
    if (scopedChanges) scopedChangesByStep[ctx.step.id] = await scopedChanges.execute({})
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary: 'probed' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

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

describe('stepTools knowledge and memory surfaces per step', () => {
  it('every step gets the knowledge tools; only the plan step gets the plan tools; the plan and finish steps get the decision tools; audit steps get knowledge_check', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-verify-'))
    const projectDbName = testSurrealDbName()
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
    // the workspace must sit at THIS config's dir: buildRuntime resolves the auto-heal authors from it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
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
      const verifyTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'verify step', spec: 'audits' }, CLI)
      await kernel.proposePlan(verifyTask.id, draftFixture([stepFixture({ id: VERIFY_STEP_ID, role: STEP_ROLE.auditor })]), CLI)
      await kernel.approvePlan(verifyTask.id, undefined, undefined, CLI)
      expect(await (await port.startRun(verifyTask.id)).wait()).toBe(RunOutcome.done)

      const workerTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'worker step', spec: 'implements' }, CLI)
      await kernel.proposePlan(workerTask.id, draftFixture([stepFixture({ id: 's1', role: STEP_ROLE.worker })]), CLI)
      await kernel.approvePlan(workerTask.id, undefined, undefined, CLI)
      expect(await (await port.startRun(workerTask.id)).wait()).toBe(RunOutcome.done)

      const healTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'heal step', spec: 'confirms notes' }, CLI)
      await kernel.proposePlan(healTask.id, draftFixture([stepFixture({ id: AUDITOR_STEP_NAMED_FOR_ITS_JOB, role: STEP_ROLE.auditor })]), CLI)
      await kernel.approvePlan(healTask.id, undefined, undefined, CLI)
      expect(await (await port.startRun(healTask.id)).wait()).toBe(RunOutcome.done)

      // The finish step is APPENDED by the kernel to every root plan, and proposePlan
      // REFUSES a draft that names it — so the fixture is a plain one-step draft and the step under
      // test is the one the kernel added. That is the only shape this step ever has in production; a
      // hand-authored 'finish' step could not reach the port at all.
      const finishTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'finish step', spec: 'reconciles' }, CLI)
      await kernel.proposePlan(finishTask.id, draftFixture([stepFixture({ id: 'lead', role: STEP_ROLE.worker })]), CLI)
      await kernel.approvePlan(finishTask.id, undefined, undefined, CLI)
      expect(await (await port.startRun(finishTask.id)).wait()).toBe(RunOutcome.done)

      const planTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'plan step', spec: 'decomposes' }, CLI)
      await kernel.proposePlan(planTask.id, draftFixture([stepFixture({ id: STEP_ID.plan, role: STEP_ROLE.auditor })]), CLI)
      await kernel.approvePlan(planTask.id, undefined, undefined, CLI)
      expect(await (await port.startRun(planTask.id)).wait()).toBe(RunOutcome.done)

      const family = (step: string) => new Set((toolNamesByStep[step] ?? []).filter(n => n.startsWith('memory_') || n.startsWith('knowledge_')))
      const knowledge = [KnowledgeToolName.card, KnowledgeToolName.search, KnowledgeToolName.write]
      expect(family(VERIFY_STEP_ID)).toEqual(new Set([...knowledge, KnowledgeToolName.check]))
      expect(family(AUDITOR_STEP_NAMED_FOR_ITS_JOB)).toEqual(new Set([...knowledge, KnowledgeToolName.check]))
      expect(family('s1')).toEqual(new Set(knowledge))
      expect(family(STEP_ID.plan)).toEqual(new Set(knowledge))
      expect(family(FINISH_STEP_ID)).toEqual(new Set(knowledge))
      const planTools = [PlanNoteToolName.write, PlanNoteToolName.read, PlanNoteToolName.finalize]
      const planToolsOf = (step: string) => new Set((toolNamesByStep[step] ?? []).filter(n => planTools.some(t => t === n)))
      expect(planToolsOf(STEP_ID.plan)).toEqual(new Set(planTools))
      for (const step of [VERIFY_STEP_ID, AUDITOR_STEP_NAMED_FOR_ITS_JOB, 's1', FINISH_STEP_ID]) expect(planToolsOf(step)).toEqual(new Set())
      const decisions = [KnowledgeToolName.decisionList, KnowledgeToolName.decisionRead, KnowledgeToolName.recordDecision]
      const decisionsOf = (step: string) => new Set((toolNamesByStep[step] ?? []).filter(n => decisions.some(d => d === n)))
      expect(decisionsOf(STEP_ID.plan)).toEqual(new Set(decisions))
      expect(decisionsOf(FINISH_STEP_ID)).toEqual(new Set(decisions))
      for (const step of [VERIFY_STEP_ID, AUDITOR_STEP_NAMED_FOR_ITS_JOB, 's1']) expect(decisionsOf(step)).toEqual(new Set())
      expect(new Set(toolNamesByStep[FINISH_STEP_ID]))
        .toEqual(new Set([...(toolNamesByStep['s1'] ?? []), KnowledgeToolName.taskClaims, SCOPED_CHANGES_TOOL_NAME, TASK_PLAN_TOOL_NAME, ...decisions]))
      expect(toolNamesByStep['s1']).not.toContain(KnowledgeToolName.taskClaims)
      expect(toolNamesByStep['s1']).not.toContain(SCOPED_CHANGES_TOOL_NAME)
      expect(toolNamesByStep['s1']).not.toContain(TASK_PLAN_TOOL_NAME)
      // the port forwards ctx.knowledge to every step, not only the ones that get task_claims
      expect(knowledgePresentByStep['s1']).toBe(true)
      expect(knowledgePresentByStep[FINISH_STEP_ID]).toBe(true)
      // scoped_changes' claimsAt is actually wired to stepKnowledge.citing — an empty array is
      // fine (nothing was written), but null (the no-callback degraded path) is not
      const scopedOut = ScopedChangesOutput.parse(scopedChangesByStep[VERIFY_STEP_ID]?.output)
      expect(scopedOut.citingClaims).not.toBeNull()
      expect(scopedOut).not.toHaveProperty('degraded')
    } finally {
      await port.shutdown()
      await log.close()
    }
  }, 60_000)
})

const WRITING_STEP = 's1'
const ANCHOR = 'src/a.ts'
const knowledgeWrites: Array<{ isError: boolean; output: unknown }> = []
const knowledgeWriteExecutor: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    const write = ctx.extraTools.find(t => t.name === KnowledgeToolName.write)
    if (ctx.step.id === WRITING_STEP && write)
      knowledgeWrites.push(await write.execute({ add: [{ text: 'Lives in the run dir.', class: ClaimClass.fact, anchors: [{ path: ANCHOR }] }], why: 'probe' }, 'call-1'))
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary: 'probed' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

describe('a step writes knowledge into the directory it runs in', () => {
  it('lands in the run cwd checkout, not the supervisor\'s, and the evidence names the task and step', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-knowledge-'))
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-rt-elsewhere-')))
    cleanup.push(() => rmSync(vaultDir, { recursive: true, force: true }), () => rmSync(elsewhere, { recursive: true, force: true }))
    sh(elsewhere, 'init', '-q')
    mkdirSync(path.join(elsewhere, path.dirname(ANCHOR)), { recursive: true })
    writeFileSync(path.join(elsewhere, ANCHOR), 'export const a = 1\n')
    const config = testConfig(db.url, {
      vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbName: testSurrealDbName(),
      knowledge: { plugin: DEFAULT_KNOWLEDGE_PLUGIN, options: {} },
    })
    seedShippedSkills(config.skillsDir)
    surrealBases.push(config)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', knowledgeWriteExecutor)
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    try {
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'writes knowledge', spec: 'records a claim' }, CLI)
      await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: WRITING_STEP })]), CLI)
      await kernel.approvePlan(t.id, undefined, undefined, CLI)
      expect(await (await port.startRun(t.id, { cwd: elsewhere })).wait()).toBe(RunOutcome.done)

      const bucket = path.join('knowledge', `${ANCHOR}.md`)
      expect(existsSync(path.join(elsewhere, bucket))).toBe(true)
      expect(existsSync(path.join(config.dir, bucket))).toBe(false)
      expect(knowledgeWrites.map(w => w.isError)).toEqual([false])
      const written = await log.after(0, [EVENT_KIND.knowledge_written])
      expect(written.map(e => ({ taskId: e.taskId, stepId: e.stepId }))).toEqual([{ taskId: t.id, stepId: WRITING_STEP }])
    } finally {
      await port.shutdown()
      await log.close()
    }
  }, 60_000)

  const commitToolResults: Array<{ isError: boolean; output: unknown }> = []
  const COMMIT_MESSAGE = 'feat: record the probed claim\n\nCommitted by the runtime test\'s probe executor.'
  const commitProbeExecutor: AgentExecutor<unknown> = {
    id: 'api-loop',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const write = ctx.extraTools.find(t => t.name === KnowledgeToolName.write)
      if (ctx.step.id === WRITING_STEP && write)
        knowledgeWrites.push(await write.execute({ add: [{ text: 'Lives in the run dir.', class: ClaimClass.fact, anchors: [{ path: ANCHOR }] }], why: 'probe' }, 'call-1'))
      if (ctx.step.id === COMMIT_STEP_ID) {
        const preview = ctx.extraTools.find(t => t.name === 'commit_preview')
        const commit = ctx.extraTools.find(t => t.name === 'git_commit')
        if (preview) await preview.execute({})
        if (commit) commitToolResults.push(await commit.execute({ message: COMMIT_MESSAGE }))
      }
      const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary: 'probed' }
      await ctx.checkpoint('signal:1', async () => signal,
        (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }

  it('the commit step commits into the run cwd checkout, not the supervisor\'s', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-commit-'))
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-rt-commit-elsewhere-')))
    cleanup.push(() => rmSync(vaultDir, { recursive: true, force: true }), () => rmSync(elsewhere, { recursive: true, force: true }))
    sh(elsewhere, 'init', '-q')
    sh(elsewhere, 'config', 'user.email', 't@t.t')
    sh(elsewhere, 'config', 'user.name', 't')
    mkdirSync(path.join(elsewhere, path.dirname(ANCHOR)), { recursive: true })
    writeFileSync(path.join(elsewhere, ANCHOR), 'export const a = 1\n')
    sh(elsewhere, 'add', '-A')
    sh(elsewhere, 'commit', '-qm', 'base')
    const elsewhereHeadBefore = sh(elsewhere, 'rev-parse', 'HEAD')

    const config = testConfig(db.url, {
      vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbName: testSurrealDbName(),
      knowledge: { plugin: DEFAULT_KNOWLEDGE_PLUGIN, options: {} },
      autoCommit: true,
    })
    seedShippedSkills(config.skillsDir)
    surrealBases.push(config)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const configHeadBefore = sh(config.dir, 'rev-parse', 'HEAD')
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', commitProbeExecutor)
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    try {
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'writes then commits', spec: 'records a claim, then commits it' }, CLI)
      await kernel.proposePlan(t.id, draftFixture([
        stepFixture({ id: WRITING_STEP }),
        stepFixture({ id: COMMIT_STEP_ID, role: STEP_ROLE.committer, dependsOn: [WRITING_STEP] }),
      ]), CLI)
      await kernel.approvePlan(t.id, undefined, undefined, CLI)
      expect(await (await port.startRun(t.id, { cwd: elsewhere })).wait()).toBe(RunOutcome.done)

      expect(commitToolResults.map(r => r.isError)).toEqual([false])
      const bucket = path.join('knowledge', `${ANCHOR}.md`)
      const elsewhereHeadAfter = sh(elsewhere, 'rev-parse', 'HEAD')
      expect(elsewhereHeadAfter).not.toBe(elsewhereHeadBefore)
      expect(sh(elsewhere, 'log', '--oneline', '-1')).toContain('feat: record the probed claim')
      const committedPaths = sh(elsewhere, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(l => l !== '')
      expect(committedPaths).toContain(bucket)
      expect(sh(config.dir, 'rev-parse', 'HEAD')).toBe(configHeadBefore)
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
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)

    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const port = await buildRuntime({ host, hub, config, storage, kernel })
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

describe('buildRuntime unavailable knowledge', () => {
  it('warns once with the reason when the configured plugin cannot open, and stays silent when knowledge is off', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-kwarn-'))
    cleanup.push(() => rmSync(vaultDir, { recursive: true, force: true }))
    const base = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbUrl: 'not-a-url' })
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    const bootWarnings = async (knowledge: ProjectConfig['knowledge']): Promise<string[]> => {
      const config = { ...base, knowledge }
      const { host, hub } = await buildPlugins(config)
      const warns: string[] = []
      spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
      const port = await buildRuntime({ host, hub, config, storage, kernel })
      try {
        return warns.filter(w => w.startsWith(KNOWLEDGE_REFUSAL.unavailable('')))
      } finally {
        await port.shutdown()
        mock.restore()
      }
    }
    try {
      await seedTestWorkspace(log, CLI, realpathSync(base.dir))
      const broken = { plugin: 'no-such-plugin', options: {} }
      const opening = openKnowledge({ knowledge: broken })
      if (!('unavailable' in opening)) throw new Error('an unknown plugin opened')
      expect(await bootWarnings(broken)).toEqual([KNOWLEDGE_REFUSAL.unavailable(opening.unavailable)])
      expect(await bootWarnings(null)).toEqual([])
    } finally {
      await log.close()
    }
  }, 60_000)
})

describe('buildRuntime degraded memory', () => {
  it('a broken Surreal config yields one warning; execution still completes, and no step holds a memory tool', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-'))
    const config = testConfig(db.url, {
      vaultDir,
      skillsDir: path.join(vaultDir, 'skills'),
      projectDbUrl: 'not-a-url', // malformed on purpose: createMemory must throw, runtime must degrade
      knowledge: null, // off too: this run also covers a step completing with knowledge unavailable
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
    // the workspace must sit at THIS config's dir: buildRuntime resolves the auto-heal authors from it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', probeExecutor)

    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    try {
      expect(warns.filter(w => w.includes('memory unavailable; continuing in degraded mode'))).toHaveLength(1)
      // ...and the role-skill pre-flight stays SILENT here: this harness seeds the shipped set the
      // way `orc init` does, and a warning that fires for a correctly seeded project is noise an
      // operator learns to ignore — which is how the real one would then get missed.
      expect(warns.filter(w => w.includes(ROLE_SKILL.finisher))).toEqual([])

      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'degraded run', spec: 'still executes' }, CLI)
      await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: STEP_ID.plan, role: STEP_ROLE.auditor })]), CLI)
      await kernel.approvePlan(t.id, undefined, undefined, CLI)
      expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)

      expect(new Set(toolProbe.results.map(r => r.name))).toEqual(new Set())
    } finally {
      try {
        await port.shutdown()
      } finally {
        await log.close()
      }
    }
  }, 60_000)
})

describe('status memory health', () => {
  it('reports healthy, pending-events, and unreachable states without failing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-status-'))
    const projectDbName = testSurrealDbName()
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
    // the workspace must sit at THIS config's dir: buildRuntime resolves the auto-heal authors from it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const status = async (cfg: typeof config, taskId: string) => {
      lines.length = 0
      await buildProgram(kernel, undefined, { host, hub, config: cfg, log }).parseAsync(['status', taskId], { from: 'user' })
      return lines.join('\n')
    }

    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'health check' }, CLI)
    // ok: derived database opens (auto-created) with cursor 0 and no memory events
    const memory = await createMemory({ log, config })
    await memory.close()
    expect(await status(config, t.id)).toContain(`memory: ${MEMORY_HEALTH.ok}`)

    // behind, not broken: a projector that has not drained yet is a healthy system mid-write
    await log.append({
      ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: {
        note: { id: 'pending-note', title: 'P', scope: 'project', kind: 'fact', sourceRevision: null, categories: [], tags: [], links: [], paths: [], summary: '', body: '' },
        author: authorFixture(),
      },
    })
    expect(await status(config, t.id)).toContain(`memory: ${MEMORY_HEALTH.catchingUp} (1 event(s) not yet projected)`)

    // unreachable database → the one real fault, and status still exits normally
    const broken = testConfig(db.url, { ...config, projectDbUrl: 'not-a-url' })
    expect(await status(broken, t.id)).toContain(`memory: ${MEMORY_HEALTH.unreachable}`)
  }, 30_000)
})

// One supervisor serves every checkout at once, so a note's stamps must come from the AUTHOR's
// workspace: a step running in a worktree that stamped the supervisor's HEAD would read clean
// until its branch merged, and drifted afterwards.
describe('workspaceStamps', () => {
  const repo = (contents: string): string => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-rt-stamps-')))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    sh(dir, 'init', '-q'); sh(dir, 'config', 'user.email', 't@t.t'); sh(dir, 'config', 'user.name', 't')
    writeFileSync(path.join(dir, 'a.ts'), contents)
    sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'base')
    return dir
  }

  it('stamps each author from their own workspace directory, and an orphan author not at all', async () => {
    const dirs = new Map([['ws-a', repo('export const a = 1\n')], ['ws-b', repo('export const a = 2\n')]])
    const stampsFor = workspaceStamps(async id => dirs.get(id) ?? null)
    const inA = stampsFor(authorFixture({ workspaceId: 'ws-a' }))
    const inB = stampsFor(authorFixture({ workspaceId: 'ws-b' }))

    expect(await inA.revision()).toMatch(/^[0-9a-f]{40}$/)
    expect(await inA.revision()).not.toBe(await inB.revision())
    expect(await inA.blob('a.ts')).not.toBe(await inB.blob('a.ts'))

    // a workspace the log does not carry is a defect, not a reason to stamp another tree
    const orphan = stampsFor(authorFixture({ workspaceId: 'ws-gone' }))
    expect(await orphan.revision()).toBeNull()
    expect(await orphan.blob('a.ts')).toBeNull()
  })
})
