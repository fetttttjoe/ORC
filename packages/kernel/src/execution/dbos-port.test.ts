import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Client } from 'pg'
import {
  EVENT_KIND, FAILURE_CLASS, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type PlanDraft,
  type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { loadConfig, deriveSystemUrl } from '../config'
import { createTestDb, fakeProvider } from '../test-helpers'
import { createDbosPort, type DbosPort } from './dbos-port'

// One DBOS runtime per process: registerWorkflow throws on duplicate names, so the whole file
// shares ONE port + DB. Per-task scripting isolates the scenarios (behavior keyed by taskId,
// which the executor recovers from runToken = step:<taskId>:<stepId>:a<attempt>).
const behaviors = new Map<string, Record<string, 'ok' | 'fail'>>()

function fakeExecutor(): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const taskId = ctx.runToken.split(':')[1]!
      const behavior = behaviors.get(taskId) ?? {}
      const outcome = behavior[ctx.step.id] === 'fail' ? SIGNAL_OUTCOME.failure : SIGNAL_OUTCOME.success
      const summary = `${ctx.step.id}:${outcome} deps=[${Object.keys(ctx.depOutputs).sort().join(',')}] skills=[${ctx.skills.map(s => s.name)}] tools=[${ctx.extraTools.map(t => t.name)}]`
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

const twoStepDraft = (): PlanDraft => draftFixture([
  stepFixture({ id: 'a', title: 'a', instructions: 'first' }),
  stepFixture({ id: 'b', title: 'b', instructions: 'second', dependsOn: ['a'] }),
])

describe('DBOS execution port (integration)', () => {
  let kernel: Kernel
  let port: DbosPort
  let teardown: () => Promise<void>
  let dbUrl: string

  beforeAll(async () => {
    const db = await createTestDb()
    dbUrl = db.url
    const log = await EventLog.open(db.url)
    kernel = new Kernel(log)
    const config = { ...loadConfig(), databaseUrl: db.url, systemDatabaseUrl: deriveSystemUrl(db.url) }
    port = await createDbosPort({
      log, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', fakeExecutor()]]),
      skills: {
        load: async (name: string) => {
          if (name === 'ghost-skill') throw new Error(`unknown skill 'ghost-skill'`)
          return { name, body: `body of ${name}`, hash: `hash-${name}` }
        },
      },
      tools: {
        close: async () => {},
        resolve: async (refs: string[]) => refs.map(ref => {
          if (ref === 'fixture/nosuch') throw new Error(`unknown tool 'nosuch' on MCP server 'fixture'`)
          return {
            ref, name: `mcp__${ref.replaceAll('/', '__')}`, description: 'd', inputSchema: {},
            execute: async () => ({ output: { ok: true }, isError: false }),
          }
        }),
      },
    })
    await port.launch()
    teardown = async () => { await port.shutdown(); await log.close(); await db.drop() }
  })
  afterAll(async () => { await teardown() })

  async function approvedTask(behavior: Record<string, 'ok' | 'fail'> = {}, draft: PlanDraft = twoStepDraft()) {
    const t = await kernel.createTask({ title: 'exec test', spec: 'run the dag' })
    behaviors.set(t.id, behavior)
    await kernel.proposePlan(t.id, draft)
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

  it('fails the step (no wedge) when modelRef is unresolvable', async () => {
    const t = await kernel.createTask({ title: 'bad model', spec: 'x' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ modelRef: 'nope/x' })]))
    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)
    const failure = (await kernel.state()).steps.get(t.id)?.get('s1')?.failure
    expect(failure?.class).toBeTruthy()
    expect(failure?.message).toContain('nope/x')
  })

  it('refuses to cancel a done task (no status event appended)', async () => {
    const t = await approvedTask()
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    const before = (await kernel.eventsFor(t.id)).length
    await expect(port.cancelRun(t.id)).rejects.toThrow(/running or blocked/)
    expect((await kernel.eventsFor(t.id)).length).toBe(before)
  })

  it('refuses to retry a task that is not blocked (no second concurrent run)', async () => {
    const t = await approvedTask()
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // approved, never run
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    await expect(port.retry(t.id)).rejects.toThrow(/blocked/) // done — nothing to retry
    expect((await kernel.state()).runs.get(t.id)).toHaveLength(1)
  })

  it('force-loads skills: skill_loaded events in init, bodies handed to the executor', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['style-guide'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')
    const events = await kernel.eventsFor(t.id)
    const loaded = events.filter(e => e.kind === EVENT_KIND.skill_loaded)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.payload).toMatchObject({ name: 'style-guide', hash: 'hash-style-guide' })
    const done = events.find(e => e.kind === EVENT_KIND.step_completed)
    expect((done!.payload as { summary: string }).summary).toContain('skills=[style-guide]')
  })

  it('resolves toolRefs into executor extraTools', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ toolRefs: ['fixture/echo'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')
    const done = (await kernel.eventsFor(t.id)).find(e => e.kind === EVENT_KIND.step_completed)
    expect((done!.payload as { summary: string }).summary).toContain('tools=[mcp__fixture__echo]')
  })

  it('unknown skill fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ skillRefs: ['ghost-skill'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('blocked')
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect((failed!.payload as { class: string }).class).toBe(FAILURE_CLASS.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('unknown tool ref fails the step as validation_error before any model call', async () => {
    const t = await approvedTask({}, draftFixture([stepFixture({ toolRefs: ['fixture/nosuch'] })]))
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('blocked')
    const events = await kernel.eventsFor(t.id)
    const failed = events.find(e => e.kind === EVENT_KIND.step_failed)
    expect((failed!.payload as { class: string }).class).toBe(FAILURE_CLASS.validation_error)
    expect(events.filter(e => e.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('a pre-M3 plan with no toolRefs in the log replays to done (no TypeError on undefined.length)', async () => {
    const t = await kernel.createTask({ title: 'legacy plan', spec: 'x' })
    // Kernel.proposePlan and even a direct EventLog.append re-parse payloads through the Plan
    // zod schema, which would restore toolRefs via its .default([]) — masking the bug. The only
    // honest way to reproduce a row that predates the field is to write it straight into the
    // events table, bypassing that parse, exactly like a pre-M3 row already sitting in the log.
    const draft = draftFixture([stepFixture()])
    const legacyStep: Record<string, unknown> = { ...stepFixture() }
    delete legacyStep.toolRefs
    const legacyPlan = { ...draft, steps: [legacyStep], taskId: t.id, version: 1 }
    const client = new Client({ connectionString: dbUrl })
    await client.connect()
    try {
      await client.query(
        'insert into events (task_id, step_id, run_token, kind, payload) values ($1, $2, $3, $4, $5)',
        [t.id, null, null, EVENT_KIND.plan_proposed, JSON.stringify({ plan: legacyPlan })],
      )
      await client.query(
        'insert into events (task_id, step_id, run_token, kind, payload) values ($1, $2, $3, $4, $5)',
        [t.id, null, null, EVENT_KIND.task_status_changed, JSON.stringify({ taskId: t.id, from: TASK_STATUS.draft, to: TASK_STATUS.awaiting_approval })],
      )
    } finally {
      await client.end()
    }

    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    expect((await kernel.eventsFor(t.id)).some(e => e.kind === EVENT_KIND.step_failed)).toBe(false)
  })
})
