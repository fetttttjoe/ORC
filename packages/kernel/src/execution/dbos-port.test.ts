import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  EVENT_KIND, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type ModelProvider, type PlanDraft, type UnifiedEvent,
} from '@orc/contracts'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { loadConfig } from '../config'
import { createTestDb } from '../test-helpers'
import { createDbosPort, type DbosPort } from './dbos-port'

const fakeProvider: ModelProvider<unknown> = {
  manifest: { id: 'fake', providerKind: 'fake', baseUrl: null, contextWindow: null, costs: {} },
  languageModel: () => ({}),
}

// One DBOS runtime per process: registerWorkflow throws on duplicate names, so the whole file
// shares ONE port + DB. Per-task scripting isolates the scenarios (behavior keyed by taskId,
// which the executor recovers from runToken = step:<taskId>:<stepId>:a<attempt>).
const behaviors = new Map<string, Record<string, 'ok' | 'fail'>>()

function fakeExecutor(): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    getCapabilities: () => ({ tools: false, streaming: false }),
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncIterable<UnifiedEvent> {
      const taskId = ctx.runToken.split(':')[1]!
      const behavior = behaviors.get(taskId) ?? {}
      const outcome = behavior[ctx.step.id] === 'fail' ? SIGNAL_OUTCOME.failure : SIGNAL_OUTCOME.success
      const summary = `${ctx.step.id}:${outcome} deps=[${Object.keys(ctx.depOutputs).sort().join(',')}]`
      const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome, summary }
      await ctx.checkpoint(
        'model:1',
        async () => summary,
        (): EventDraft[] => [{ kind: EVENT_KIND.agent_call, payload: { stepId: ctx.step.id, runToken: ctx.runToken, iteration: 1, request: {}, response: { summary } }, usage: { inputTokens: 1, outputTokens: 1, costUSD: 0.001, estimated: false } }],
      )
      await ctx.checkpoint(
        'signal:1',
        async () => signal,
        (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }],
      )
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

const twoStepDraft = (): PlanDraft => ({
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [
    { id: 'a', role: 'worker', title: 'a', instructions: 'first', executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], isolation: 'local', zone: [], maxIterations: 3, dependsOn: [] },
    { id: 'b', role: 'worker', title: 'b', instructions: 'second', executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], isolation: 'local', zone: [], maxIterations: 3, dependsOn: ['a'] },
  ],
})

describe('DBOS execution port (integration)', () => {
  let kernel: Kernel
  let port: DbosPort
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const db = await createTestDb()
    const log = await EventLog.open(db.url)
    kernel = new Kernel(log)
    const config = { ...loadConfig(), databaseUrl: db.url, systemDatabaseUrl: `${db.url}_dbos_sys` }
    port = await createDbosPort({
      log, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', fakeExecutor()]]),
    })
    await port.launch()
    teardown = async () => { await port.shutdown(); await log.close(); await db.drop() }
  })
  afterAll(async () => { await teardown() })

  async function approvedTask(behavior: Record<string, 'ok' | 'fail'> = {}) {
    const t = await kernel.createTask({ title: 'exec test', spec: 'run the dag' })
    behaviors.set(t.id, behavior)
    await kernel.proposePlan(t.id, twoStepDraft())
    await kernel.approvePlan(t.id)
    return t
  }

  it('runs a 2-step DAG to done, threading dep outputs, in order', async () => {
    const t = await approvedTask()
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')

    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.status).toBe('completed')
    expect(state.steps.get(t.id)?.get('b')?.status).toBe('completed')
    // b saw a's output (the signal summary)
    expect(state.steps.get(t.id)?.get('b')?.output).toContain('deps=[a]')
    // event ordering: run_started before any step_started; a completes before b starts
    const kinds = (await kernel.eventsFor(t.id)).map(e => e.kind)
    expect(kinds.indexOf(EVENT_KIND.run_started)).toBeLessThan(kinds.indexOf(EVENT_KIND.step_started))
  })

  it('startRun is idempotent — second call attaches, no duplicate run_started', async () => {
    const t = await approvedTask()
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(h1.workflowId).toBe(h2.workflowId)
    await h1.wait()
    const runs = (await kernel.state()).runs.get(t.id) ?? []
    expect(runs).toHaveLength(1)
  })

  it('failed step blocks task; retry re-runs only the failed step to done', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const t = await approvedTask(behavior)
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    behavior.b = 'ok' // human "fixed the world"
    const retry = await port.retry(t.id)
    expect(retry.workflowId).toContain(':r1')
    expect(await retry.wait()).toBe('done')

    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.attempt).toBe(1) // completed step NOT re-run
    expect(state.steps.get(t.id)?.get('b')?.attempt).toBe(2)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  })

  it('refuses to run an unapproved task', async () => {
    const t = await kernel.createTask({ title: 'nope' })
    await expect(port.startRun(t.id)).rejects.toThrow(/approve/)
  })
})
