import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  APPROVAL_ANSWER, AUTHOR_SOURCE, DECISION_STATUS, Door, EVENT_KIND, FINISH_STEP_ID, isApprovalAnswer, NO_CHAT,
  MemoryWrittenPayload, NOTE_KIND, NOTE_TIER, parseModelRef, SignalOutcome, slugId, STEP_ROLE, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { dbosSend, openStorage, Kernel, type ProjectConfig } from '@orc/kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, testConfig, TEST_PROJECT_ID, TEST_WORKSPACE_ID, waitFor } from '@orc/kernel/test-helpers'
import { FINISH_TOOL_NAME } from '@orc/memory'
import { buildPlugins, buildRuntime } from './runtime'
import { seedShippedSkills } from './shipped-skills'
import { dropSurrealDb, testSurrealDbName } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealBases: ProjectConfig[] = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
  await Promise.all(surrealBases.map(c => dropSurrealDb(c)))
})

// The finish step's own question and the decision it records, named once so the assertions below
// pin what the executor actually sent rather than a re-typed copy.
const FINISH_TOPIC = 'finish'
const FINISH_QUESTION = 'SUMMARY: ran s1 and wrote nothing. Reply approve to finish.'
const DECISION_DRAFT = { title: 'E2E decision', context: 'c', decision: 'd', consequences: 'q' }

// this test drives the CLI door end to end; the run's own appends get their origin from the runtime
const CLI = NO_CHAT(Door.cli)

// The draft's ONLY authored step, named here rather than inline in the proposePlan call because the
// appended finish step INHERITS executorRef/modelRef/maxIterations from it (withFinishStepFull) —
// so the author assertion below reads the expected executor and model straight off this object
// instead of re-typing two strings that would silently stop matching if the fixture changed.
const LAST_STEP = stepFixture({ id: 's1' })

// What the finish step observed, asserted in the TEST body rather than thrown from inside the
// generator: a throw inside a DBOS step workflow surfaces as a retried/failed run, which reports
// "the task did not complete" instead of "task_notes errored" — the actual finding.
const finishProbe: {
  toolNames: string[]
  taskNotes?: { output: unknown; isError: boolean }
  decision?: { output: unknown; isError: boolean }
  answer?: string
} = { toolNames: [] }

// ONE executor under the id every step of this plan names ('api-loop', stepFixture's default, which
// the kernel-appended finish step inherits from the draft's last step), branching on the step id:
// s1 just succeeds, the finish step drives the real sequence — read the task's notes, ask the human,
// record the decision the human approved, then signal.
const finishExecutor: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
    let summary = 'ran'
    if (ctx.step.id === FINISH_STEP_ID) {
      finishProbe.toolNames = ctx.extraTools.map(t => t.name)
      const taskNotes = ctx.extraTools.find(t => t.name === FINISH_TOOL_NAME.taskNotes)
      if (taskNotes !== undefined) finishProbe.taskNotes = await taskNotes.execute({}, undefined)
      const answer = String(yield { type: 'feedback', question: FINISH_QUESTION, topic: FINISH_TOPIC, toolCallId: 'c1' })
      finishProbe.answer = answer
      // The decision is recorded ONLY on the human's approval word — the ADR is written `accepted`
      // because a person already approved its wording in the gate above, so a step that recorded it
      // regardless would be stamping consent nobody gave.
      if (isApprovalAnswer(answer)) {
        const record = ctx.extraTools.find(t => t.name === FINISH_TOOL_NAME.recordDecision)
        if (record !== undefined) finishProbe.decision = await record.execute(DECISION_DRAFT, undefined)
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

// End to end over the REAL runtime (Postgres event log, SurrealDB read model, DBOS workflows): the
// kernel appends the finish step, the port hands that step the reconcile tools, the step's question
// parks the run, `orc reply`'s kernel path resumes it, and the approved decision lands in the log
// attributed to the step. Each half is unit-tested elsewhere; only this composition can show that
// the tools reach the step AND the reply resumes it.
describe('the finish step, end to end', () => {
  it('a quick task runs s1, then the finish step: asks once, is approved, records the decision, and the task completes', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-finish-'))
    const projectDbName = testSurrealDbName()
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbName })
    // Seeded the way `orc init` seeds a real project: the finish step declares ROLE_SKILL.finisher,
    // and a temp skills dir that nothing seeds fails the run at step init with "unknown skill
    // 'role-finisher'".
    seedShippedSkills(config.skillsDir)
    surrealBases.push(config)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    // dbosSend, not the bare `new Kernel(log)` of runtime.test.ts: replyFeedback must SEND on the
    // parked step workflow's recv topic, and a kernel without it appends feedback_provided and
    // leaves the run parked until the gate poll expires.
    const kernel = new Kernel(log, undefined, undefined, dbosSend)
    // the workspace must sit at THIS config's dir: buildRuntime resolves the consolidation and
    // auto-heal authors from the directory it serves, and refuses when nothing claims it
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

      const handle = await port.startRun(t.id)
      expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested), 20_000)).toBe(true)
      const asked = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.feedback_requested)
      // the question belongs to the FINISH step, not to s1 — the envelope is what an operator's
      // `orc status` reads to say which step is waiting
      expect(asked?.stepId).toBe(FINISH_STEP_ID)
      expect(await kernel.replyFeedback(t.id, APPROVAL_ANSWER, CLI)).toBe(FINISH_TOPIC)
      expect(await handle.wait()).toBe(RunOutcome.done)

      // the step saw the human's word (so isApprovalAnswer had something real to judge) and got a
      // working task_notes — both are the tools/resume seam this test exists for
      expect(finishProbe.answer).toBe(APPROVAL_ANSWER)
      expect(isApprovalAnswer(finishProbe.answer ?? '')).toBe(true)
      // Both tools REACHED the step, asserted before their results so a gate that withheld one
      // fails as "the tool never arrived" instead of as an undefined result. The exact set of the
      // finish step's surface is runtime.test.ts's assertion; this is the composition's own check.
      expect(finishProbe.toolNames).toContain(FINISH_TOOL_NAME.taskNotes)
      expect(finishProbe.toolNames).toContain(FINISH_TOOL_NAME.recordDecision)
      // `{ notes: [] }` — the wrapper key is the contract; empty is honest for this fixture, whose
      // scripted steps write no notes and whose consolidation note is authored AFTER the task
      // settles. A bare array (or a thrown listing) would show up here as a shape change.
      expect(finishProbe.taskNotes).toEqual({ output: { notes: [] }, isError: false })
      // the id the tool reports is the slugged title — the same id the logged note carries below
      expect(finishProbe.decision).toEqual({ output: { id: slugId(DECISION_DRAFT.title), status: DECISION_STATUS.accepted }, isError: false })

      // The LOG is the truth: the read model is a projection of it. `log.all()`, NOT
      // `kernel.eventsFor(t.id)` — MEASURED: the store appends every memory event with
      // `taskId: null` in the envelope (store.ts, and kernel.ts:318/:338 say so), so byTask returns
      // none of them and a task-scoped filter here would be an assertion that can never pass. The
      // writing task lives on `payload.author.taskId`, which is what this narrows on.
      const written = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_written).map(e => MemoryWrittenPayload.parse(e.payload))
      const adr = written.find(w => w.author.taskId === t.id && w.note.tier === NOTE_TIER.semantic && w.note.kind === NOTE_KIND.decision)
      // The PIPELINE fields too, not just the envelope ones: `role`/`executor`/`model` are what
      // composeAuthor renders into the note's createdBy ('api-loop·m·finisher'), and they are the
      // half the port could silently stop forwarding — an author missing them still satisfies
      // MemoryAuthor (all three are optional) and still writes a note, one that reads as a bare
      // 'agent' in the vault forever, since createdBy is sticky across rewrites.
      expect(adr?.author).toMatchObject({
        source: AUTHOR_SOURCE.agent, workspaceId: TEST_WORKSPACE_ID, taskId: t.id, stepId: FINISH_STEP_ID,
        role: STEP_ROLE.finisher, executor: LAST_STEP.executorRef, model: parseModelRef(LAST_STEP.modelRef).modelId,
      })
      expect(adr?.note).toMatchObject({ id: slugId(DECISION_DRAFT.title), status: DECISION_STATUS.accepted })
      expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    } finally {
      await port.shutdown()
      await log.close()
    }
  }, 60_000)
})
