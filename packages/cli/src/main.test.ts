import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Surreal } from 'surrealdb'
import { EVENT_KIND } from '@orc/contracts'
import { loadConfig, requireProject, type PluginHost } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'
import type { McpHub } from '@orc/mcp-client'
import { buildProgram, openKernel, runInit } from './main'

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealConfigs: Array<Pick<ReturnType<typeof loadConfig>, 'projectDbUrl' | 'projectDbNamespace' | 'projectDbUser' | 'projectDbPassword' | 'projectDbName'>> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
  for (const c of surrealConfigs) await dropSurrealDb(c)
})

// mirrors plugins/memory/src/test-helpers.ts's createTestSurreal drop shape (not cross-imported
// per the repo's no-cross-package-test-import convention) — both use the shape verified live
// against SurrealDB v3.2.0: `use()` selects only the namespace, and the (internally-generated,
// `t_[a-z0-9]+`) db name is inlined directly, since `REMOVE DATABASE IF EXISTS type::database($db)`
// is not a valid function path there (a parse error, easy to silently swallow via `.catch`).
// Connection details come from the same injected `config` the test below builds — no literals.
async function dropSurrealDb(config: Pick<ReturnType<typeof loadConfig>, 'projectDbUrl' | 'projectDbNamespace' | 'projectDbUser' | 'projectDbPassword' | 'projectDbName'>): Promise<void> {
  const s = new Surreal()
  await s.connect(config.projectDbUrl)
  await s.signin({ username: config.projectDbUser, password: config.projectDbPassword })
  await s.use({ namespace: config.projectDbNamespace })
  await s.query(`REMOVE DATABASE IF EXISTS \`${config.projectDbName}\`;`).catch(() => {})
  await s.close()
}

async function makeCli() {
  const db = await createTestDb()
  dbs.push(db)
  const { kernel } = await openKernel(db.url)
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '))
  })
  // fresh Command instance per invocation; commander does not re-parse cleanly
  const run = async (...args: string[]) => {
    await buildProgram(kernel).parseAsync(args, { from: 'user' })
    return lines
  }
  return { run, lines, kernel }
}

afterEach(() => {
  mock.restore()
})

describe('orc CLI', () => {
  it('init writes committed project identity into the given directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-init-'))
    await runInit(['--name', 'demo'], dir)
    expect(requireProject(loadConfig(dir)).projectName).toBe('demo')
  })

  it('buildProgram exposes init', async () => {
    const { kernel } = await makeCli()
    expect(buildProgram(kernel).commands.map(c => c.name())).toContain('init')
  })

  it('new → propose → approve → log round-trip', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'hello world', '--spec', 'do things')
    const taskId = lines[0]
    expect(taskId).toMatch(/[0-9a-f-]{36}/)

    await run('propose', taskId)
    expect(lines[1]).toContain('plan v1 proposed')

    await run('approve', taskId)
    expect(lines[2]).toContain('plan v1 approved')

    lines.length = 0
    await run('log', taskId)
    const kinds = lines.map(l => l.split(/\s+/).at(-1))
    expect(kinds).toEqual([
      EVENT_KIND.task_created, EVENT_KIND.plan_proposed, EVENT_KIND.task_status_changed,
      EVENT_KIND.plan_approved, EVENT_KIND.task_status_changed,
    ])
  })

  it('plan prints the plan as JSON', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'x')
    const taskId = lines[0]
    await run('propose', taskId, '--model', 'ollama/llama3')
    lines.length = 0
    await run('plan', taskId)
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.steps[0].modelRef).toBe('ollama/llama3')
    expect(plan.strategyRef).toBe('template:single')
  })

  it('tasks lists id, status and title', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'listed task')
    lines.length = 0
    await run('tasks')
    expect(lines[0]).toContain('draft')
    expect(lines[0]).toContain('listed task')
  })

  it('propose --file loads a plan draft from disk', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'file task')
    const taskId = lines[0]

    const draftPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-draft-')), 'draft.json')
    writeFileSync(draftPath, JSON.stringify({
      strategyRef: 'template:single',
      costEstimateUSD: null,
      steps: [{
        id: 's1',
        role: 'worker',
        title: 'do the thing',
        instructions: 'do the thing',
        executorRef: 'api-loop',
        modelRef: 'file/model',
        skillRefs: [],
        isolation: 'local',
        zone: [],
        maxIterations: 3,
        dependsOn: [],
      }],
    }))

    await run('propose', taskId, '--file', draftPath)
    lines.length = 0
    await run('plan', taskId)
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.steps[0].modelRef).toBe('file/model')
    expect(plan.steps[0].maxIterations).toBe(3)
  })

  it('propose --file rejects malformed JSON', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'bad file task')
    const taskId = lines[0]

    const badPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-draft-')), 'bad.json')
    writeFileSync(badPath, '{not json')

    await expect(run('propose', taskId, '--file', badPath)).rejects.toThrow()
  })

  it('edit round-trip bumps the plan version and logs plan_edited', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'edit task')
    const taskId = lines[0]
    await run('propose', taskId)

    lines.length = 0
    await run('edit', taskId, '--model', 'ollama/other')
    expect(lines[0]).toContain('plan v2 edited')

    lines.length = 0
    await run('plan', taskId)
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.version).toBe(2)
    expect(plan.steps[0].modelRef).toBe('ollama/other')

    lines.length = 0
    await run('log', taskId)
    const kinds = lines.map(l => l.split(/\s+/).at(-1))
    expect(kinds).toContain(EVENT_KIND.plan_edited)
  })

  // memory commands need `needPlugin()` to resolve, so this injects a plugin the way
  // plugin-commands.test.ts does — host/hub are untouched stubs, config/log are real.
  // config.projectDbName is a per-test throwaway SurrealDB db (dropped in afterAll below),
  // so this test is isolated from the shared `orc/memory` db and from any other test —
  // `rebuild` is safe to call since it only ever clears this test's own db.
  it('memory add/rebuild/ls/search/cat/rm round-trip against an isolated throwaway SurrealDB db', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-cli-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = { ...loadConfig(dir), projectDbName }
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url)
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const plugin = { host: {} as PluginHost, hub: {} as McpHub, config, log } // memory commands never touch host/hub
    const run = (...args: string[]) => buildProgram(kernel, undefined, plugin).parseAsync(args, { from: 'user' })

    const id = `cli-test-${Math.random().toString(36).slice(2, 10)}`
    await run('memory', 'add', '--id', id, '--title', 'T', '--summary', 'S', '--body', 'B', '--tags', 'x')

    // Primary isolated assertion: this test's own (per-test Postgres) log recorded the append —
    // true independent of SurrealDB, which every other assertion below depends on.
    const written = (await log.all()).find(e => e.kind === EVENT_KIND.memory_written)
    expect(written).toBeDefined()
    expect((written!.payload as { note: { id: string } }).note.id).toBe(id)

    // Isolated db — safe to clear-and-replay from this test's own event log only.
    await run('memory', 'rebuild')

    lines.length = 0
    await run('memory', 'ls')
    expect(lines.join('\n')).toContain(id)

    lines.length = 0
    await run('memory', 'cat', id)
    const note = JSON.parse(lines.join('\n'))
    expect(note.id).toBe(id)
    expect(note.title).toBe('T')
    expect(note.summary).toBe('S')
    expect(note.body).toBe('B')

    lines.length = 0
    await run('memory', 'search', 'x') // matches the 'x' tag
    expect(lines.join('\n')).toContain(id)

    await run('memory', 'rm', id) // rm's action already runs catchUp() itself
    lines.length = 0
    await run('memory', 'cat', id)
    expect(lines[0]).toContain(`no note '${id}'`)
  })
})
