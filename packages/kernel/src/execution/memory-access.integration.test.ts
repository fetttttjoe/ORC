import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND, MEMORY_ACCESS, MemoryAccessedPayload } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { scriptModel } from '@orc/executor-api-loop/test-model'
import { createMemory } from '@orc/memory'
import { createTestSurreal } from '@orc/memory/test-helpers'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, testConfig, TEST_PROJECT_ID } from '../test-helpers'
import { createDbosPort } from './dbos-port'

// Access counts are only worth anything if they measure what AGENTS pull — the CLI path is the
// rare case. tools.test.ts pins the rule against a fake store; this drives the real one through
// a real durable run, so the whole chain is under test: api-loop tool dispatch → memory tools →
// the store's event append → the projector → hits in the read model.
describe('agent-side memory access recording (integration)', () => {
  const cleanup: (() => Promise<void> | void)[] = []
  // LIFO: port and log close before the database they hold connections to is dropped
  afterAll(async () => { for (const c of cleanup.reverse()) await c() })

  it('records one access per delivered pull, and none for a search, a miss, or an empty traversal', async () => {
    const pg = await createTestDb(); cleanup.push(pg.drop)
    const ts = await createTestSurreal(); cleanup.push(ts.drop)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-access-'))
    cleanup.push(() => rmSync(vaultDir, { recursive: true, force: true }))

    const storage = await openStorage(pg.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    const kernel = new Kernel(log)
    const config = testConfig(pg.url, {
      vaultDir,
      projectDbUrl: ts.url, projectDbNamespace: ts.ns, projectDbName: ts.db,
      projectDbUser: ts.username, projectDbPassword: ts.password,
    })
    const memory = await createMemory({ log, config })
    await memory.projector.start()
    cleanup.push(() => memory.close())

    // two linked notes so the traversal has something to return
    await memory.store.write({ id: 'auth', title: 'Auth', summary: 'tokens', body: 'rotate hourly',
      links: [{ id: 'crypto', kind: 'depends_on' }] }, { source: 'cli' })
    await memory.store.write({ id: 'crypto', title: 'Crypto', summary: 'primitives' }, { source: 'cli' })
    await memory.projector.catchUp()

    // Scripted agent exercising every pull shape. Only the model's token generation is fake —
    // tool dispatch, the memory tools, the store, and the projector are all the shipped code.
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'memory_search', input: { query: 'auth' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'memory_read', input: { id: 'auth' } }] },
      { toolCalls: [{ toolCallId: 'c3', toolName: 'memory_read', input: { id: 'ghost-note' } }] },
      { toolCalls: [{ toolCallId: 'c4', toolName: 'memory_neighbors', input: { seed: 'auth' } }] },
      { toolCalls: [{ toolCallId: 'c5', toolName: 'memory_neighbors', input: { seed: 'crypto', kinds: ['supersedes'] } }] },
      { toolCalls: [{ toolCallId: 'c6', toolName: 'signal', input: { outcome: 'success', summary: 'pulled context' } }] },
    ])

    const port = await createDbosPort({
      storage, config,
      providers: new Map([['fake', { costs: {}, languageModel: () => model }]]),
      executors: new Map([['api-loop', apiLoopExecutor()]]),
      stepTools: p => memory.buildTools({
        source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken,
        executor: p.executor, model: p.model, role: p.role,
      }),
    })
    await port.launch()
    cleanup.push(() => port.shutdown())
    cleanup.push(() => log.close())

    const t = await kernel.createTask({ title: 'use memory', spec: 'pull the auth context' })
    // maxIterations must clear the six scripted turns — the fixture default of 5 would cap the
    // loop before the signal and block the run on an iteration limit, not on anything under test
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ modelRef: 'fake/m', maxIterations: 10 })]))
    await kernel.approvePlan(t.id)
    expect(await (await port.startRun(t.id)).wait()).toBe('done')

    // memory events are project-scoped (taskId: null), so read the whole log, not the task slice
    const accesses = (await log.all())
      .filter(e => e.kind === EVENT_KIND.memory_accessed)
      .map(e => MemoryAccessedPayload.parse(e.payload))

    // exactly two: the read that hit, and the traversal that returned something. The search, the
    // miss, and the kind-filtered traversal that matched nothing each recorded nothing.
    expect(accesses.map(a => `${a.mode}:${a.id}`)).toEqual([
      `${MEMORY_ACCESS.read}:auth`,
      `${MEMORY_ACCESS.neighbors}:auth`,
    ])

    // authorship is the agent's, carrying the step identity — not the CLI default. Without this
    // the counter could never answer "which step pulled this", only "something did".
    for (const a of accesses) {
      expect(a.author.source).toBe('agent')
      expect(a.author.taskId).toBe(t.id)
      expect(a.author.runToken).toContain(t.id)
    }

    // and the counter actually lands in the read model the agent's next search would consult
    await memory.projector.catchUp()
    const summaries = await memory.store.list()
    expect(summaries.find(n => n.id === 'auth')?.hits).toBe(2)
    expect(summaries.find(n => n.id === 'crypto')?.hits).toBe(0) // traversed THROUGH, never pulled
    expect(summaries.find(n => n.id === 'auth')?.lastAccessedAt).toBeString()
  }, 120_000)
})
