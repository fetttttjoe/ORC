import { afterAll, describe, expect, it } from 'bun:test'
import pg from 'pg'
import {
  EVENT_KIND, SIGNAL_OUTCOME,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { deriveSystemUrl } from '../config'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort } from './dbos-port'

// set BEFORE openStorage: buildRedactor snapshots process.env when the store opens
const SECRET = 'sk-ant-totally-not-a-real-key-9f3a'
process.env.ORC_REDACTION_PROBE_KEY = SECRET

// A step's return value does NOT flow through EventLog.append — DBOS serializes it straight
// into operation_outputs in its own system database (same cluster, same credentials). This is
// the one test standing between that table and plaintext tool output / model turns.
const leaker: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    // shaped like a real tool result: the secret sits inside the step's RETURN value
    await ctx.checkpoint('leak', async () => ({ toolOutput: `env dump: ORC_REDACTION_PROBE_KEY=${SECRET}` }))
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: 'ok' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

describe('redaction covers what DBOS persists', () => {
  const cleanup: (() => Promise<void>)[] = []
  afterAll(async () => { for (const c of cleanup) await c() })

  it('a secret in a step result never reaches the DBOS system database in plaintext', async () => {
    const db = await createTestDb()
    cleanup.push(db.drop)
    const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const kernel = new Kernel(storage.events)
    const t = await kernel.createTask({ title: 'leak probe', spec: 'return a secret from a step' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', title: 's1' })]))
    await kernel.approvePlan(t.id)

    const port = await createDbosPort({
      storage, config: testConfig(db.url),
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', leaker]]),
    })
    await port.launch()
    expect(await (await port.startRun(t.id)).wait()).toBe('done')
    await port.shutdown()

    const sys = new pg.Client({ connectionString: deriveSystemUrl(db.url, TEST_PROJECT_ID) })
    await sys.connect()
    const { rows } = await sys.query(`SELECT output, error FROM dbos.operation_outputs`)
    await sys.end()

    expect(rows.length).toBeGreaterThan(0) // the step really did checkpoint
    const persisted = rows.map(r => `${r.output ?? ''}${r.error ?? ''}`).join('\n')
    expect(persisted).not.toContain(SECRET)
    expect(persisted).toContain('[REDACTED:ORC_REDACTION_PROBE_KEY]') // scrubbed, not merely dropped
    await storage.close()
  }, 120_000)
})
