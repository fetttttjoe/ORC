import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  EVENT_KIND, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort, dbosSend, type DbosPort } from './dbos-port'

// what the executor observed as the resumed value of the feedback yield
const seen: string[] = []

// scripted executor: yields a feedback gate, records what it resumes with, then signals done —
// mirrors fakeExecutor in dbos-port.test.ts, but for the feedback (not split) gate.
function feedbackFake(): AgentExecutor<unknown> {
  return {
    id: 'feedback-fake',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
      const answer = yield { type: 'feedback', question: 'analyze the codebase?', topic: 'consent', toolCallId: 'c1' }
      seen.push(String(answer))
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

const waitFor = async (pred: () => Promise<boolean>, ms = 10_000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await pred()) return true; await Bun.sleep(50) }
  return false
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
    const config = testConfig(db.url)
    port = await createDbosPort({
      storage, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['feedback-fake', feedbackFake()]]),
    })
    await port.launch()
    teardown = async () => { await port.shutdown(); await log.close(); await db.drop() }
  })
  afterAll(async () => { await teardown() })

  it('a feedback gate appends feedback_requested and resumes the turn with the human text', async () => {
    const t = await kernel.createTask({ title: 'feedback test', spec: 'ask then continue' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ executorRef: 'feedback-fake' })]))
    await kernel.approvePlan(t.id)

    const handle = await port.startRun(t.id)
    // deterministic step workflow id (spec: step:<taskId>:<stepId>:a<attempt>) — this IS the
    // DBOS.recv destination for the feedback topic, mirroring the split gate's `split:<id>` send.
    const runToken = `step:${t.id}:s1:a1`

    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested))).toBe(true)
    const requested = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.feedback_requested)
    expect(requested?.payload).toEqual({ question: 'analyze the codebase?', topic: 'consent' })

    expect(await kernel.replyFeedback(t.id, 'yes')).toBe('consent')

    expect(await handle.wait()).toBe('done')
    expect(seen).toEqual(['yes'])

    const completed = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed)
    expect((completed!.payload as { summary: string }).summary).toContain('got:yes')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  })
})
