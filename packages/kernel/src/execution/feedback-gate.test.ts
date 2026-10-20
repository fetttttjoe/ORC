import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  Door, EVENT_KIND, FINISH_STEP_ID, NO_CHAT, PAYLOAD_SCHEMAS, SignalOutcome, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type Origin, type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, fakeSkills, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig, waitFor } from '../test-helpers'
import { createDbosPort, dbosSend, type DbosPort } from './dbos-port'

// what the executor observed as the resumed value of the feedback yield
const seen: string[] = []

const CLI: Origin = NO_CHAT(Door.cli)

// scripted executor: yields a feedback gate, records what it resumes with, then signals done
function feedbackFake(): AgentExecutor<unknown> {
  return {
    id: 'feedback-fake',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
      // the finish step runs this executor too and must not open a second gate; it succeeds at once
      let answer = 'finished'
      if (ctx.step.id !== FINISH_STEP_ID) {
        answer = String(yield { type: 'feedback', question: 'analyze the codebase?', topic: 'consent', toolCallId: 'c1' })
        seen.push(answer)
      }
      const summary = `got:${answer}`
      const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary }
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
    await seedTestWorkspace(log, CLI)
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
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'feedback test', spec: 'ask then continue' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ executorRef: 'feedback-fake' })]), CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)

    const handle = await port.startRun(t.id)
    // the deterministic step workflow id is the DBOS.recv destination for the feedback topic
    const runToken = `step:${t.id}:s1:a1`

    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested), 10_000)).toBe(true)
    const requested = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.feedback_requested)
    expect(requested?.payload).toEqual({ question: 'analyze the codebase?', topic: 'consent' })

    expect(await kernel.replyFeedback(t.id, 'yes', CLI)).toBe('consent')

    expect(await handle.wait()).toBe(RunOutcome.done)
    expect(seen).toEqual(['yes'])

    const completed = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed)
    expect(PAYLOAD_SCHEMAS.step_completed.parse(must(completed, 'step completed event').payload).summary).toContain('got:yes')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    // 30s: two DBOS step workflows run (scripted step + finish step); bun's default 5s timed out
  }, 30_000)
})
