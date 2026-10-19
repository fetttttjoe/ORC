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

// The finish step's own question and the decision it records, named once so the assertions below
// pin what the executor actually sent rather than a re-typed copy.
const FINISH_TOPIC = 'finish'
const FINISH_QUESTION = 'SUMMARY: ran s1 and wrote nothing. Reply approve to finish.'
const DECISION_DRAFT = { title: 'E2E decision', context: 'c', decision: 'd', consequences: 'q' }
const RECORD_CALL_ID = 'record-1'

// this test drives the CLI door end to end; the run's own appends get their origin from the runtime
const CLI = NO_CHAT(Door.cli)

// The draft's ONLY authored step, named here rather than inline in the proposePlan call because the
// appended finish step INHERITS executorRef/modelRef/maxIterations from it (withFinishStepFull) —
// so the author assertion below reads the expected executor and model straight off this object
// instead of re-typing two strings that would silently stop matching if the fixture changed.
const LAST_STEP = stepFixture({ id: 's1' })

// What the finish step observed, asserted in the TEST body rather than thrown from inside the
// generator: a throw inside a DBOS step workflow surfaces as a retried/failed run, which reports
// "the task did not complete" instead of "task_claims errored" — the actual finding.
const finishProbe: {
  toolNames: string[]
  taskClaims?: { output: unknown; isError: boolean }
  decision?: { output: unknown; isError: boolean }
  replay?: { output: unknown; isError: boolean }
  answer?: string
} = { toolNames: [] }

// ONE executor under the id every step of this plan names ('api-loop', stepFixture's default, which
// the kernel-appended finish step inherits from the draft's last step), branching on the step id:
// s1 just succeeds, the finish step drives the real sequence — read the task's claims, ask the human,
// record the decision the human approved, then signal.
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
      // The decision is recorded ONLY on the human's approval word — the ADR is written `accepted`
      // because a person already approved its wording in the gate above, so a step that recorded it
      // regardless would be stamping consent nobody gave.
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

// End to end over the REAL runtime (Postgres event log, DBOS workflows): the
// kernel appends the finish step, the port hands that step the reconcile tools, the step's question
// parks the run, `orc reply`'s kernel path resumes it, and the approved decision lands in the log
// attributed to the step. Each half is unit-tested elsewhere; only this composition can show that
// the tools reach the step AND the reply resumes it.
describe('the finish step, end to end', () => {
  it('a quick task runs s1, then the finish step: asks once, is approved, records the decision, and the task completes', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-finish-'))
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), knowledge: { plugin: DEFAULT_KNOWLEDGE_PLUGIN, options: {} } })
    // Seeded the way `orc init` seeds a real project: the finish step declares ROLE_SKILL.finisher,
    // and a temp skills dir that nothing seeds fails the run at step init with "unknown skill
    // 'role-finisher'".
    seedShippedSkills(config.skillsDir)
    const checkout = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-finish-checkout-')))
    checkouts.push(checkout)
    sh(checkout, 'init', '-q')
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    // dbosSend, not the bare `new Kernel(log)` of runtime.test.ts: replyFeedback must SEND on the
    // parked step workflow's recv topic, and a kernel without it appends feedback_provided and
    // leaves the run parked until the gate poll expires.
    const kernel = new Kernel(log, undefined, undefined, dbosSend)
    // the workspace must sit at THIS config's dir: buildRuntime resolves the auto-heal authors from it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', finishExecutor)
    const port = await buildRuntime({ host, hub, config, storage, kernel })
    // In `finally`, not after the assertions: DBOS registration is process-global, and a leaked
    // launched runtime poisons every later test file in the process (runtime.test.ts's precedent).
    try {
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'quick', spec: 'do' }, CLI)
      const plan = await kernel.proposePlan(t.id, draftFixture([LAST_STEP]), CLI)
      expect(plan.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
      await kernel.approvePlan(t.id, undefined, undefined, CLI)

      const handle = await port.startRun(t.id, { cwd: checkout })
      expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested), 20_000)).toBe(true)
      const asked = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.feedback_requested)
      // the question belongs to the FINISH step, not to s1 — the envelope is what an operator's
      // `orc status` reads to say which step is waiting
      expect(asked?.stepId).toBe(FINISH_STEP_ID)
      expect(await kernel.replyFeedback(t.id, APPROVAL_ANSWER, CLI)).toBe(FINISH_TOPIC)
      expect(await handle.wait()).toBe(RunOutcome.done)

      // the step saw the human's word (so isApprovalAnswer had something real to judge) and got a
      // working task_claims — both are the tools/resume seam this test exists for
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
