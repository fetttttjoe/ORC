import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { ClaimClass, COMMIT_STEP_ID, DEFAULT_KNOWLEDGE_PLUGIN, Door, NO_CHAT,
  EVENT_KIND, FINISH_STEP_ID, KNOWLEDGE_REFUSAL, KnowledgeToolName, PlanNoteToolName, ROLE_SKILL, SignalOutcome, STEP_ID, STEP_ROLE, VERIFY_STEP_ID,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { openStorage, Kernel, SCOPED_CHANGES_TOOL_NAME, TASK_PLAN_TOOL_NAME, type ProjectConfig } from '@orc/kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, sh, testConfig, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'

// these tests arrange through the CLI door; the runtime's own authors are Door.supervisor
const CLI = NO_CHAT(Door.cli)
import { buildProgram } from './main'
import { buildPlugins, buildRuntime, seedPhases } from './runtime'
import { seedShippedSkills } from './shipped-skills'
import { openKnowledge } from './knowledge-open'

const dbs: Array<{ drop: () => Promise<void> }> = []
// registered at creation, drained LIFO before the databases: a bare shutdown is skipped on a throw
const cleanup: Array<() => Promise<void> | void> = []
afterAll(async () => {
  for (const c of cleanup.reverse()) await c()
  for (const d of dbs) await d.drop()
})
afterEach(() => mock.restore())

// records the extraTools names each step actually receives, keyed by step id
const toolNamesByStep: Record<string, string[]> = {}
const knowledgePresentByStep: Record<string, boolean> = {}
// scoped_changes' own result per step: proves claimsAt is wired, not just that the tool exists
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

// bin.ts opens storage before buildRuntime, so buildRuntime's own 'storage' phase never runs
describe('seedPhases (the boot line accounts for a storage open it did not perform)', () => {
  it("leads with 'storage' when the caller opened it and timed it", () => {
    expect(seedPhases(true, 1360)).toEqual([['storage', 1360]])
  })

  it('stays empty when buildRuntime will time its own open — no invented phase', () => {
    // no shared storage: buildRuntime opens it itself and bootPhase records the real duration
    expect(seedPhases(false, undefined)).toEqual([])
    // shared storage the caller did not time: absence wins over a fabricated zero
    expect(seedPhases(true, undefined)).toEqual([])
    // a duration with no shared storage is not this path's business — buildRuntime times its own
    expect(seedPhases(false, 1360)).toEqual([])
  })
})

describe('stepTools knowledge surfaces per step', () => {
  it('every step gets the knowledge tools; only the plan step gets the plan tools; the plan and finish steps get the decision tools; audit steps get knowledge_check', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-verify-'))
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills') })
    // seeded like `orc init`: an unseeded skills dir fails at step init on role-finisher
    seedShippedSkills(config.skillsDir)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    // the workspace must sit at THIS config's dir: buildRuntime resolves the auto-heal authors from it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', toolNameExecutor)
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    // torn down HERE, in `finally`: DBOS launch is process-global; the next test builds its own
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

      // the kernel appends the finish step and proposePlan refuses a draft naming it
      const finishTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'finish step', spec: 'reconciles' }, CLI)
      await kernel.proposePlan(finishTask.id, draftFixture([stepFixture({ id: 'lead', role: STEP_ROLE.worker })]), CLI)
      await kernel.approvePlan(finishTask.id, undefined, undefined, CLI)
      expect(await (await port.startRun(finishTask.id)).wait()).toBe(RunOutcome.done)

      const planTask = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'plan step', spec: 'decomposes' }, CLI)
      await kernel.proposePlan(planTask.id, draftFixture([stepFixture({ id: STEP_ID.plan, role: STEP_ROLE.auditor })]), CLI)
      await kernel.approvePlan(planTask.id, undefined, undefined, CLI)
      expect(await (await port.startRun(planTask.id)).wait()).toBe(RunOutcome.done)

      const family = (step: string) => new Set((toolNamesByStep[step] ?? []).filter(n => n.startsWith('knowledge_')))
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
      // an empty array is fine (nothing written); null (the degraded no-callback path) is not
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
  it('lands in the run cwd checkout, not the supervisor\'s, the evidence names the task and step, and nothing warns about memory', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-knowledge-'))
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-rt-elsewhere-')))
    cleanup.push(() => rmSync(vaultDir, { recursive: true, force: true }), () => rmSync(elsewhere, { recursive: true, force: true }))
    sh(elsewhere, 'init', '-q')
    mkdirSync(path.join(elsewhere, path.dirname(ANCHOR)), { recursive: true })
    writeFileSync(path.join(elsewhere, ANCHOR), 'export const a = 1\n')
    const config = testConfig(db.url, {
      vaultDir, skillsDir: path.join(vaultDir, 'skills'),
      knowledge: { plugin: DEFAULT_KNOWLEDGE_PLUGIN, options: {} },
    })
    seedShippedSkills(config.skillsDir)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', knowledgeWriteExecutor)
    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
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
      expect(warns.filter(w => w.includes('memory'))).toEqual([])
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
      vaultDir, skillsDir: path.join(vaultDir, 'skills'),
      knowledge: { plugin: DEFAULT_KNOWLEDGE_PLUGIN, options: {} },
      autoCommit: true,
    })
    seedShippedSkills(config.skillsDir)
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

// buildRuntime names each missing kernel-appended role skill once at boot, not at proposePlan
describe('buildRuntime role-skill pre-flight', () => {
  it('warns at boot for a skills dir nothing seeded, naming the skill and the fix — and still boots', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-skills-'))
    // deliberately NOT seedShippedSkills(config.skillsDir) — that absence IS the case under test.
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills') })
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)

    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    // shut down HERE, in `finally`: DBOS launch is process-global; the next test builds its own
    try {
      const named = warns.filter(w => w.includes(ROLE_SKILL.finisher))
      // ONE line, not one per caller of the index: a repeated warning reads as a repeated fault
      expect(named).toHaveLength(1)
      // the skill, where it was looked for, and the command that fixes it
      expect(named[0]).toContain(config.skillsDir)
      expect(named[0]).toContain('orc init')
      for (const skill of Object.values(ROLE_SKILL)) expect(warns.some(w => w.includes(skill))).toBe(true)
    } finally {
      await port.shutdown()
      await log.close()
    }
  }, 60_000)
})

describe('a run with knowledge off', () => {
  it('runs its step to done; the step\'s knowledge write answers off and appends nothing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-off-'))
    cleanup.push(() => rmSync(vaultDir, { recursive: true, force: true }))
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), knowledge: null })
    seedShippedSkills(config.skillsDir)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const writes: Array<{ isError: boolean; output: unknown }> = []
    const offExecutor: AgentExecutor<unknown> = {
      id: 'api-loop',
      async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
        const write = ctx.extraTools.find(t => t.name === KnowledgeToolName.write)
        if (ctx.step.id === WRITING_STEP && write)
          writes.push(await write.execute({ add: [{ text: 'Never lands.', class: ClaimClass.fact, anchors: [{ path: ANCHOR }] }], why: 'probe' }, 'call-1'))
        const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary: 'probed' }
        await ctx.checkpoint('signal:1', async () => signal,
          (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
        yield { type: 'signal', signal }
        yield { type: 'done' }
      },
    }
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', offExecutor)
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    try {
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'knowledge off', spec: 'runs without knowledge' }, CLI)
      await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: WRITING_STEP })]), CLI)
      await kernel.approvePlan(t.id, undefined, undefined, CLI)
      expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)
      expect(writes).toEqual([{ output: { error: KNOWLEDGE_REFUSAL.unavailable(KNOWLEDGE_REFUSAL.off()) }, isError: true }])
      expect(await log.after(0, [EVENT_KIND.knowledge_written])).toEqual([])
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
    const base = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills') })
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

describe('orc status knowledge health', () => {
  it('prints the knowledge line', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-status-'))
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills') })
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'health check' }, CLI)
    await buildProgram(kernel, undefined, { host, hub, config, log }).parseAsync(['status', t.id], { from: 'user' })
    expect(lines.join('\n')).toContain('knowledge:')
  }, 30_000)
})
