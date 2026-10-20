import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  APPROVAL_ANSWER, AUTHOR_SOURCE, DEFAULT_KNOWLEDGE_PLUGIN, decisionSlugOf, DecisionStatus, Door, EVENT_KIND, FINISH_STEP_ID, isApprovalAnswer,
  KnowledgeToolName, KnowledgeWrittenPayload, NO_CHAT, parseModelRef, SignalOutcome, STEP_ROLE, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { dbosSend, openStorage, Kernel } from '@orc/kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, sh, testConfig, TEST_PROJECT_ID, TEST_WORKSPACE_ID, waitFor } from '@orc/kernel/test-helpers'
import { buildPlugins, buildRuntime } from './runtime'
import { seedShippedSkills } from './shipped-skills'

const dbs: Array<{ drop: () => Promise<void> }> = []
const checkouts: string[] = []
afterAll(async () => {
  for (const c of checkouts) rmSync(c, { recursive: true, force: true })
  for (const d of dbs) await d.drop()
})

const FINISH_TOPIC = 'finish'
const FINISH_QUESTION = 'SUMMARY: ran s1 and wrote nothing. Reply approve to finish.'
const DECISION_DRAFT = { title: 'E2E decision', context: 'c', decision: 'd', consequences: 'q' }
const RECORD_CALL_ID = 'record-1'

// this test drives the CLI door end to end; the run's own appends get their origin from the runtime
const CLI = NO_CHAT(Door.cli)

// the finish step inherits executorRef/modelRef/maxIterations from this authored step
const LAST_STEP = stepFixture({ id: 's1' })

// asserted in the test body: a throw inside a DBOS step workflow surfaces as a failed run
const finishProbe: {
  toolNames: string[]
  taskClaims?: { output: unknown; isError: boolean }
  decision?: { output: unknown; isError: boolean }
  replay?: { output: unknown; isError: boolean }
  answer?: string
} = { toolNames: [] }

const finishExecutor: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
    let summary = 'ran'
    if (ctx.step.id === FINISH_STEP_ID) {
      finishProbe.toolNames = ctx.extraTools.map(t => t.name)
      const taskClaims = ctx.extraTools.find(t => t.name === KnowledgeToolName.taskClaims)
      if (taskClaims !== undefined) finishProbe.taskClaims = await taskClaims.execute({}, undefined)
      const answer = String(yield { type: 'feedback', question: FINISH_QUESTION, topic: FINISH_TOPIC, toolCallId: 'c1' })
      finishProbe.answer = answer
      // recorded only on the human's approval word: otherwise it would stamp consent nobody gave
      if (isApprovalAnswer(answer)) {
        const record = ctx.extraTools.find(t => t.name === KnowledgeToolName.recordDecision)
        if (record !== undefined) {
          finishProbe.decision = await record.execute(DECISION_DRAFT, RECORD_CALL_ID)
          finishProbe.replay = await record.execute(DECISION_DRAFT, RECORD_CALL_ID)
        }
      }
      summary = `finished: ${answer}`
    }
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary }
    await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
      { kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } },
    ])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

describe('the finish step, end to end', () => {
  it('a quick task runs s1, then the finish step: asks once, is approved, records the decision, and the task completes', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-finish-'))
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), knowledge: { plugin: DEFAULT_KNOWLEDGE_PLUGIN, options: {} } })
    // seeded like `orc init`: the finish step declares ROLE_SKILL.finisher, an empty skills dir fails
    seedShippedSkills(config.skillsDir)
    const checkout = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-finish-checkout-')))
    checkouts.push(checkout)
    sh(checkout, 'init', '-q')
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    // dbosSend, not a bare Kernel: replyFeedback must send on the parked step's recv topic
    const kernel = new Kernel(log, undefined, undefined, dbosSend)
    // the workspace must sit at THIS config's dir: buildRuntime resolves the auto-heal authors from it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', finishExecutor)
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    // in `finally`: DBOS registration is process-global and a leaked runtime poisons later files
    try {
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'quick', spec: 'do' }, CLI)
      const plan = await kernel.proposePlan(t.id, draftFixture([LAST_STEP]), CLI)
      expect(plan.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
      await kernel.approvePlan(t.id, undefined, undefined, CLI)

      const handle = await port.startRun(t.id, { cwd: checkout })
      expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested), 20_000)).toBe(true)
      const asked = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.feedback_requested)
      expect(asked?.stepId).toBe(FINISH_STEP_ID)
      expect(await kernel.replyFeedback(t.id, APPROVAL_ANSWER, CLI)).toBe(FINISH_TOPIC)
      expect(await handle.wait()).toBe(RunOutcome.done)

      expect(finishProbe.answer).toBe(APPROVAL_ANSWER)
      expect(isApprovalAnswer(finishProbe.answer ?? '')).toBe(true)
      expect(finishProbe.toolNames).toContain(KnowledgeToolName.taskClaims)
      expect(finishProbe.toolNames).toContain(KnowledgeToolName.recordDecision)
      expect(finishProbe.taskClaims).toEqual({ output: { claims: [], retired: [], missing: [] }, isError: false })

      const id = decisionSlugOf(DECISION_DRAFT.title)
      expect(finishProbe.decision).toEqual({ output: { id, status: DecisionStatus.accepted, superseded: null, warnings: [] }, isError: false })
      expect(finishProbe.replay).toEqual(finishProbe.decision)

      const written = (await log.after(0, [EVENT_KIND.knowledge_written])).filter(e => e.taskId === t.id)
      expect(written).toHaveLength(1)
      const payload = KnowledgeWrittenPayload.parse(written[0]?.payload)
      expect(payload.decisionsRecorded.map(d => d.id)).toEqual([id])
      const location = payload.decisionsRecorded[0]?.location ?? ''
      expect(existsSync(path.join(checkout, location))).toBe(true)
      expect(readdirSync(path.join(checkout, path.dirname(location)))).toEqual([path.basename(location)])
      expect(existsSync(path.join(config.dir, location))).toBe(false)
      expect(payload.author).toMatchObject({
        source: AUTHOR_SOURCE.agent, workspaceId: TEST_WORKSPACE_ID, taskId: t.id, stepId: FINISH_STEP_ID,
        role: STEP_ROLE.finisher, executor: LAST_STEP.executorRef, model: parseModelRef(LAST_STEP.modelRef).modelId,
      })
      expect((await kernel.listTaskKnowledgeWrites(t.id)).files).toContain(location)
      expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    } finally {
      await port.shutdown()
      await log.close()
    }
  }, 60_000)
})
