import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  EVENT_KIND, FAILURE_CLASS, MAX_AUTO_CONTINUATIONS, PAYLOAD_SCHEMAS, SIGNAL_OUTCOME, TASK_STATUS,
  continuationTopic,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig, waitFor } from '../test-helpers'
import { createDbosPort, dbosSend, type DbosPort } from './dbos-port'

// The continuation contract under test: the agent REPORTS `partial`, the runtime GRANTS.
// Auto-continue while the round cap allows (no budget is configured here, so the cap is the only
// brake); past it, the ask parks on the standing feedback gate and a human decides. Before this
// existed, a partial-shaped ending was an agent_error whose retry forgot everything but the
// workspace — test 1 is the discriminator (a partial run now ENDS DONE, it used to block).

// rounds each task should signal `partial` before succeeding — 0 means success immediately
const partialsByTask = new Map<string, number>()
// what each round's ctx.continuation looked like, in invocation order
const continuations = new Map<string, Array<{ round: number; summary: string } | undefined>>()

function continuationFake(): AgentExecutor<unknown> {
  return {
    id: 'continuation-fake',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | string | undefined> {
      const taskId = ctx.runToken.split(':')[1]!
      const seen = continuations.get(taskId) ?? []
      seen.push(ctx.continuation)
      continuations.set(taskId, seen)
      const round = seen.length - 1
      const outcome = round < (partialsByTask.get(taskId) ?? 0) ? SIGNAL_OUTCOME.partial : SIGNAL_OUTCOME.success
      const summary = `round ${round}: ${outcome === SIGNAL_OUTCOME.partial ? `did part ${round}, remaining after ${round}` : 'finished'}`
      const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome, summary }
      // the loop's own checkpoint naming (per-iteration, restarts each round) — the port must
      // round-prefix it or round 1 replays round 0's recorded signal as its own
      await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
        { kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } },
      ])
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

describe('partial-signal continuation', () => {
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
      storage, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['continuation-fake', continuationFake()]]),
    })
    await port.launch()
    teardown = async () => { await port.shutdown(); await log.close(); await db.drop() }
  })
  afterAll(async () => { await teardown() })

  const newTask = async (partials: number) => {
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: `continuation x${partials}`, spec: 'finish the job' })
    partialsByTask.set(t.id, partials)
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ executorRef: 'continuation-fake' })]))
    await kernel.approvePlan(t.id)
    return t
  }

  it('one partial auto-continues to done, handing the summary to the next round — no human involved', async () => {
    const t = await newTask(1)
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    const rounds = continuations.get(t.id)!
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toBeUndefined() // round 0 is an ordinary first prompt
    // the previous round's summary IS the handoff — the only context that crosses the boundary
    expect(rounds[1]).toEqual({ round: 1, summary: 'round 0: did part 0, remaining after 0' })

    const events = await kernel.eventsFor(t.id)
    expect(events.filter(e => e.kind === EVENT_KIND.feedback_requested)).toHaveLength(0)
    // both rounds' signals are durable facts, and the step completed exactly once
    expect(events.filter(e => e.kind === EVENT_KIND.signal_received)).toHaveLength(2)
    expect(events.filter(e => e.kind === EVENT_KIND.step_completed)).toHaveLength(1)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  }, 30_000)

  it('past the round cap the gate asks, and a decline stops the step as the HUMAN\'s decision', async () => {
    const t = await newTask(99) // never finishes on its own — the cap must be what stops it
    const handle = await port.startRun(t.id)

    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested), 15_000)).toBe(true)
    // rounds 1..cap were auto-granted; the ask names the state and carries the latest report
    expect(continuations.get(t.id)).toHaveLength(MAX_AUTO_CONTINUATIONS + 1)
    const asked = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.feedback_requested)
    const q = PAYLOAD_SCHEMAS.feedback_requested.parse(asked!.payload)
    expect(q.question).toContain('round cap reached')
    expect(q.question).toContain(`remaining after ${MAX_AUTO_CONTINUATIONS}`)

    expect(await kernel.replyFeedback(t.id, 'no — stop here')).toBe(q.topic)
    expect(await handle.wait()).toBe('blocked')

    const failed = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_failed)
    const p = PAYLOAD_SCHEMAS.step_failed.parse(failed!.payload)
    expect(p.class).toBe(FAILURE_CLASS.human_abort) // a decision, never a malfunction
    expect(p.message).toContain('continuation declined')
    expect(p.message).toContain(`remaining after ${MAX_AUTO_CONTINUATIONS}`) // the report survives for the operator
  }, 30_000)

  it('an approval at the gate grants exactly one more round, and the loop continues from it', async () => {
    const t = await newTask(MAX_AUTO_CONTINUATIONS + 1) // one round PAST the auto allowance
    const handle = await port.startRun(t.id)

    expect(await waitFor(async () => (await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.feedback_requested), 15_000)).toBe(true)
    expect(await kernel.replyFeedback(t.id, 'approve')).toBe(continuationTopic('s1', MAX_AUTO_CONTINUATIONS))

    expect(await handle.wait()).toBe('done')
    expect(continuations.get(t.id)).toHaveLength(MAX_AUTO_CONTINUATIONS + 2)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  }, 30_000)
})
