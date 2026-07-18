import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EVENT_KIND, SIGNAL_OUTCOME,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort, type DbosPort } from './dbos-port'
import { createVaultProjector, type VaultProjector } from '@orc/vault-projector'

// fake executor emitting a realistic transcript: agent text + a tool call/result + a success signal
function fakeExecutor(): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
      const base = { stepId: ctx.step.id, runToken: ctx.runToken }
      await ctx.checkpoint('model:1', async () => 'ok', (): EventDraft[] => [
        { kind: EVENT_KIND.agent_call, payload: { ...base, iteration: 1, request: {}, response: { text: 'writing the file' } }, usage: { inputTokens: 5, outputTokens: 3, costUSD: 0.001, estimated: false } },
      ])
      await ctx.checkpoint('tools:1', async () => 'ok', (): EventDraft[] => [
        { kind: EVENT_KIND.tool_call, payload: { ...base, iteration: 1, toolCallId: 'c1', toolName: 'fs_write', input: { path: 'out.txt' } } },
        { kind: EVENT_KIND.tool_result, payload: { ...base, iteration: 1, toolCallId: 'c1', toolName: 'fs_write', output: { written: 'out.txt' }, isError: false } },
      ])
      const signal = { ...base, outcome: SIGNAL_OUTCOME.success, summary: 'done: wrote out.txt' }
      await ctx.checkpoint('signal:1', async () => signal, (): EventDraft[] => [
        { kind: EVENT_KIND.signal_received, payload: { ...base, signal } },
      ])
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

describe('vault projection over a real run (e2e)', () => {
  let kernel: Kernel
  let port: DbosPort
  let projector: VaultProjector
  let log: EventLog
  let vaultDir: string
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const db = await createTestDb()
    vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-e2e-'))
    log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    kernel = new Kernel(log)
    const config = testConfig(db.url, { vaultDir })
    port = await createDbosPort({
      log, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', fakeExecutor()]]),
    })
    await port.launch()
    projector = createVaultProjector({ log, config })
    await projector.start() // live subscribe for the whole run
    teardown = async () => {
      await projector.close()
      await port.shutdown()
      await log.close()
      rmSync(vaultDir, { recursive: true, force: true })
      await db.drop()
    }
  })
  afterAll(() => teardown())

  it('projects the full run: working-graph DAG, session transcript, log, root index', async () => {
    const t = await kernel.createTask({ title: 'e2e demo', spec: 'write a file' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', modelRef: 'fake/m' })]))
    await kernel.approvePlan(t.id)

    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')

    await projector.close() // final authoritative sync (also flushes any live-debounced render)

    const idx = readFileSync(path.join(vaultDir, `tasks/${t.id}/index.md`), 'utf8')
    expect(idx).toContain('type: task')
    expect(idx).toContain('graph TD') // live working graph rendered

    const session = readFileSync(path.join(vaultDir, `tasks/${t.id}/sessions/s1.md`), 'utf8')
    expect(session).toContain('fs_write')            // tool call in the transcript
    expect(session).toContain('writing the file')    // agent text
    expect(session).toContain('done: wrote out.txt') // signal summary

    const logMd = readFileSync(path.join(vaultDir, `tasks/${t.id}/log.md`), 'utf8')
    for (const kind of ['run_started', 'step_started', 'agent_call', 'tool_call', 'tool_result', 'signal_received', 'step_completed'])
      expect(logMd).toContain(kind)

    expect(existsSync(path.join(vaultDir, 'index.md'))).toBe(true)
  })
})
