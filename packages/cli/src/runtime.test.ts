import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  EVENT_KIND, SIGNAL_OUTCOME,
  type AgentExecutor, type EventDraft, type ExecutorContext, type SplitResult, type UnifiedEvent,
} from '@orc/contracts'
import { Surreal } from 'surrealdb'
import { EventLog, Kernel, projectDatabaseName, type ProjectConfig } from '@orc/kernel'
import { createTestDb, fakeProvider, testConfig, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createMemory } from '@orc/memory'
import { buildProgram } from './main'
import { buildPlugins, buildRuntime } from './runtime'

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealBases: ProjectConfig[] = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
  for (const c of surrealBases) {
    const s = new Surreal()
    await s.connect(c.projectDbUrl)
    await s.signin({ username: c.projectDbUser, password: c.projectDbPassword })
    await s.use({ namespace: c.projectDbNamespace })
    await s.query(`REMOVE DATABASE IF EXISTS \`${projectDatabaseName(c.projectDbName, c.projectId)}\`;`).catch(() => {})
    await s.close()
  }
})

// captures the memory tools the port hands each step, then signals success
const toolProbe: { results: { name: string; isError: boolean; output: unknown }[] } = { results: [] }
const probeExecutor: AgentExecutor<unknown> = {
  id: 'api-loop',
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncGenerator<UnifiedEvent, void, SplitResult[] | undefined> {
    const inputs: Record<string, unknown> = {
      memory_write: { id: 'x', title: 'X' },
      memory_search: { query: 'x' },
      memory_read: { id: 'x' },
      memory_neighbors: { seed: 'x' },
    }
    for (const t of ctx.extraTools.filter(t => t.name.startsWith('memory_'))) {
      const r = await t.execute(inputs[t.name])
      toolProbe.results.push({ name: t.name, isError: r.isError, output: r.output })
    }
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: 'probed' }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

describe('buildRuntime degraded memory', () => {
  it('a broken Surreal config yields one warning + explicit unavailable tools; execution still completes', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-'))
    const config = testConfig(db.url, {
      vaultDir,
      skillsDir: path.join(vaultDir, 'skills'),
      projectDbUrl: 'not-a-url', // malformed on purpose: createMemory must throw, runtime must degrade
    })
    const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    const kernel = new Kernel(log)
    const { host, hub } = await buildPlugins(config)
    host.providers.set('fake', fakeProvider)
    host.executors.set('api-loop', probeExecutor)

    const warns: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const port = await buildRuntime({ host, hub, config, log, kernel })
    mock.restore()
    expect(warns.filter(w => w.includes('memory unavailable; continuing in degraded mode'))).toHaveLength(1)

    const t = await kernel.createTask({ title: 'degraded run', spec: 'still executes' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture()]))
    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    // all four memory tools exist and each returns an explicit isError result with the reason
    expect(new Set(toolProbe.results.map(r => r.name))).toEqual(
      new Set(['memory_write', 'memory_search', 'memory_read', 'memory_neighbors']))
    for (const r of toolProbe.results) {
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r.output)).toContain('memory unavailable')
    }

    await port.shutdown()
    await log.close()
  }, 60_000)
})

describe('status memory health', () => {
  it('reports healthy, pending-events, and unreachable states without failing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-rt-status-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = testConfig(db.url, { vaultDir, skillsDir: path.join(vaultDir, 'skills'), projectDbName })
    surrealBases.push(config)
    const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    const kernel = new Kernel(log)
    const { host, hub } = await buildPlugins(config)
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const status = async (cfg: typeof config, taskId: string) => {
      lines.length = 0
      await buildProgram(kernel, undefined, { host, hub, config: cfg, log }).parseAsync(['status', taskId], { from: 'user' })
      return lines.join('\n')
    }

    const t = await kernel.createTask({ title: 'health check' })
    // healthy: derived database opens (auto-created) with cursor 0 and no memory events
    const memory = await createMemory({ log, config })
    await memory.close()
    expect(await status(config, t.id)).toContain('memory: healthy')

    // one unapplied event → degraded with the pending count
    await log.append({
      taskId: null, stepId: null, runToken: null, kind: 'memory_written',
      payload: {
        note: { id: 'pending-note', title: 'P', scope: 'project', kind: 'fact', sourceRevision: null, categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' },
        author: { source: 'cli' },
      },
    })
    expect(await status(config, t.id)).toContain('memory: degraded (1 unapplied events)')

    // unreachable database → degraded, status still exits normally
    const broken = testConfig(db.url, { ...config, projectDbUrl: 'not-a-url' })
    expect(await status(broken, t.id)).toContain('memory: degraded (unreachable:')

    mock.restore()
    await hub.close()
    await host.shutdown()
    await log.close()
  }, 30_000)
})
