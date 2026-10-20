import { afterAll, describe, expect, it } from 'bun:test'
import pg from 'pg'
import {
  Door, EVENT_KIND, NO_CHAT, SignalOutcome,
  type AgentExecutor, type EventDraft, type ExecutorContext, type Origin, type SplitResult, type UnifiedEvent,
  RunOutcome,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { deriveSystemUrl } from '../config'
import { createTestDb, fakeProvider, fakeSkills, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig } from '../test-helpers'
import { createDbosPort } from './dbos-port'

// set BEFORE openStorage: buildRedactor snapshots process.env when the store opens
const SECRET = 'sk-ant-totally-not-a-real-key-9f3a'
process.env.ORC_REDACTION_PROBE_KEY = SECRET

const CLI: Origin = NO_CHAT(Door.cli)

// A step's return bypasses EventLog.append: this is the test guarding operation_outputs redaction.
const leaker: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    // shaped like a real tool result: the secret sits inside the step's RETURN value
    await ctx.checkpoint('leak', async () => ({ toolOutput: `env dump: ORC_REDACTION_PROBE_KEY=${SECRET}` }))
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SignalOutcome.success, summary: 'ok' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

describe('redaction covers what DBOS persists', () => {
  const cleanup: (() => Promise<void>)[] = []
  // LIFO teardown, registered at creation: a trailing shutdown is skipped when an assertion throws
  afterAll(async () => { for (const c of cleanup.reverse()) await c() })

  it('a secret in a step result never reaches the DBOS system database in plaintext', async () => {
    const db = await createTestDb()
    cleanup.push(db.drop)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    cleanup.push(() => storage.close())
    const kernel = new Kernel(storage.events)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(storage.events, CLI)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'leak probe', spec: 'return a secret from a step' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', title: 's1' })]), CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)

    const port = await createDbosPort({
      storage, config: testConfig(db.url), skills: fakeSkills,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', leaker]]),
    })
    await port.launch()
    cleanup.push(() => port.shutdown())
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)

    const sys = new pg.Client({ connectionString: deriveSystemUrl(db.url, TEST_PROJECT_ID) })
    await sys.connect()
    cleanup.push(() => sys.end())
    const { rows } = await sys.query(`SELECT output, error FROM dbos.operation_outputs`)

    expect(rows.length).toBeGreaterThan(0) // the step really did checkpoint
    const persisted = rows.map(r => `${r.output ?? ''}${r.error ?? ''}`).join('\n')
    expect(persisted).not.toContain(SECRET)
    expect(persisted).toContain('[REDACTED:ORC_REDACTION_PROBE_KEY]') // scrubbed, not merely dropped
  }, 120_000)
})
