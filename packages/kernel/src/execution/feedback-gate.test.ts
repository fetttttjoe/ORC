import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  EVENT_KIND, FINISH_STEP_ID, PAYLOAD_SCHEMAS, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, fakeSkills, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig, waitFor } from '../test-helpers'
import { createDbosPort, dbosSend, type DbosPort } from './dbos-port'

// what the executor observed as the resumed value of the feedback yield
const seen: string[] = []

// scripted executor: yields a feedback gate, records what it resumes with, then signals done —
// mirrors fakeExecutor in dbos-port.test.ts, but for the feedback (not split) gate.
function feedbackFake(): AgentExecutor<unknown> {
  return {
    id: 'feedback-fake',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
      // The kernel appends a finish step to every root plan, and it runs this same fake executor.
      // It must NOT open a second gate: nobody answers it, so the run would park forever and this
      // file's subject — the ONE scripted question and the text it resumes with — would never be
      // reached. It signals success straight away instead.
      let answer = 'finished'
      if (ctx.step.id !== FINISH_STEP_ID) {
        answer = String(yield { type: 'feedback', question: 'analyze the codebase?', topic: 'consent', toolCallId: 'c1' })
        seen.push(answer)
      }
      const summary = `got:${answer}`
      const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary }
      await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
        { kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } },
      ])
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}


describe('durable conversational gate (feedback)', () => {
  let kernel: Kernel
  let port: DbosPort
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const db = await createTestDb()
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    kernel = new Kernel(log, undefined, undefined, dbosSend)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    const config = testConfig(db.url)
    port = await createDbosPort({
      storage, config, skills: fakeSkills,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['feedback-fake', feedbackFake()]]),
    })
    await port.launch()
    teardown = async () => { await port.shutdown(); await log.close(); await db.drop() }
  })
  afterAll(async () => { await teardown() })

  it('a feedback gate appends feedback_requested and resumes the turn with the human text', async () => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'feedback test', spec: 'ask then continue' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ executorRef: 'feedback-fake' })]))
    await kernel.approvePlan(t.id)

    const handle = await port.startRun(t.id)
    // deterministic step workflow id (spec: step:<taskId>:<stepId>:a<attempt>) — this IS the
    // DBOS.recv destination for the feedback topic, mirroring the split gate's `split:<id>` send.
    const runToken = `step:${t.id}:s1:a1`

    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested), 10_000)).toBe(true)
    const requested = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.feedback_requested)
    expect(requested?.payload).toEqual({ question: 'analyze the codebase?', topic: 'consent' })

    expect(await kernel.replyFeedback(t.id, 'yes')).toBe('consent')

    expect(await handle.wait()).toBe('done')
    expect(seen).toEqual(['yes'])

    const completed = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed)
    expect(PAYLOAD_SCHEMAS.step_completed.parse(completed!.payload).summary).toContain('got:yes')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    // 30s, the budget the other gate tests (continuation.test.ts) use: the run is two DBOS step
    // workflows now — the scripted step and the kernel's appended finish step — and bun's default
    // 5s timed out on the second one while the gate itself worked.
  }, 30_000)
})
