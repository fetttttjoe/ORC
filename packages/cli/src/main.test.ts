import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Surreal } from 'surrealdb'
import { EVENT_KIND, type ExecutionPort, type OperationSpec } from '@orc/contracts'
import { loadConfig, projectDatabaseName, requireProject, type ProjectConfig } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { buildProgram, openKernel, runInit } from './main'
import { buildPlugins } from './runtime'

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealConfigs: ProjectConfig[] = []
// Teardown drops one Postgres DB per makeCli/openKernel (14+ here) plus each throwaway Surreal db.
// Each pg drop is a DROP DATABASE WITH FORCE on its own admin connection; serial drops blew bun's
// default 5s hook budget under a contended pg (same fix as kernel.test.ts) — the dbs are distinct,
// so drop them concurrently, with headroom for a loaded box.
afterAll(async () => {
  await Promise.all([...dbs.map(d => d.drop()), ...surrealConfigs.map(c => dropSurrealDb(c))])
}, 30_000)

// mirrors plugins/memory/src/test-helpers.ts's createTestSurreal drop shape (not cross-imported
// per the repo's no-cross-package-test-import convention) — both use the shape verified live
// against SurrealDB v3.2.0: `use()` selects only the namespace, and the (internally-generated,
// `t_[a-z0-9]+`) db name is inlined directly, since `REMOVE DATABASE IF EXISTS type::database($db)`
// is not a valid function path there (a parse error, easy to silently swallow via `.catch`).
// Connection details come from the same injected `config` the test below builds — no literals.
async function dropSurrealDb(config: ProjectConfig): Promise<void> {
  const s = new Surreal()
  await s.connect(config.projectDbUrl)
  await s.signin({ username: config.projectDbUser, password: config.projectDbPassword })
  await s.use({ namespace: config.projectDbNamespace })
  // createMemory opens the project-derived name; drop base and derived alike
  for (const name of [config.projectDbName, projectDatabaseName(config.projectDbName, config.projectId)])
    await s.query(`REMOVE DATABASE IF EXISTS \`${name}\`;`).catch(() => {})
  await s.close()
}

async function makeCli() {
  const db = await createTestDb()
  dbs.push(db)
  const { kernel } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
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

  it('replay reconstructs operation state at a sequence and appends nothing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })

    const t = await kernel.createTask({ title: 'audit me' })
    const opContext = { taskId: t.id, stepId: 's1', runToken: `step:${t.id}:s1:a1` }
    const spec: OperationSpec = { operationId: `${opContext.runToken}:model:1`, kind: 'model', name: 'fake/m', before: { q: 1 } }
    await storage.operations.beginOperation(opContext, spec)
    const startSeq = (await log.byTask(t.id)).at(-1)!.seq
    await storage.operations.completeOperation(opContext, spec, 1, { text: 'answer' })
    const countBefore = (await log.all()).length

    lines.length = 0
    await run('replay', t.id, '--at', String(startSeq))
    expect(JSON.parse(lines.join('\n')).operations[spec.operationId].status).toBe('started')

    lines.length = 0
    await run('replay', t.id)
    expect(JSON.parse(lines.join('\n')).operations[spec.operationId].status).toBe('completed')

    await expect(run('replay', t.id, '--at', 'x')).rejects.toThrow(/non-negative integer/)
    await expect(run('replay', t.id, '--at', '-1')).rejects.toThrow(/non-negative integer/)
    expect((await log.all()).length).toBe(countBefore) // replay never mutates history
    await log.close()
  })

  it('log --json prints the full stored envelope', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })
    const t = await kernel.createTask({ title: 'json log' })
    lines.length = 0
    await run('log', t.id, '--json')
    const records = JSON.parse(lines.join('\n'))
    expect(records[0]).toMatchObject({ kind: 'task_created', projectId: TEST_PROJECT_ID, idempotencyKey: null })
    expect(records[0].seq).toBeGreaterThan(0)
    await log.close()
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

  it('new rejects an unrecognized --strategy value instead of silently falling through', async () => {
    const { run } = await makeCli()
    await expect(run('new', 'x', '--strategy', 'grounded')).rejects.toThrow(/unknown --strategy 'grounded'/)
  })

  it('propose --skill places the named skills in the template step', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'documented task')
    const taskId = lines[0]!
    await run('propose', taskId, '--model', 'ollama/llama3', '--skill', 'documentation')
    lines.length = 0
    await run('plan', taskId)
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.steps[0].skillRefs).toEqual(['documentation'])
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

  it('plan-note appends plan_annotated; reply resolves the open feedback topic and notifies its runToken', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const sent: Array<{ id: string; message: string; topic: string }> = []
    const { kernel, log } = await openKernel(db.url, {
      projectId: TEST_PROJECT_ID,
      send: async (id, message, topic) => { sent.push({ id, message, topic }) },
    })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    // `reply` calls needPort() before replyFeedback (DBOS.send needs DBOS launched in-process) —
    // this stub only satisfies that gate; `reply` never calls any of its methods. The real
    // send path is exercised through the injected `send` above, not through this fake port.
    const stubPort: ExecutionPort = {
      startRun: async () => { throw new Error('unused in this test') },
      retry: async () => { throw new Error('unused in this test') },
      cancelRun: async () => {},
    }
    const run = async (...args: string[]) => buildProgram(kernel, async () => stubPort).parseAsync(args, { from: 'user' })

    await run('new', 'grounded task')
    const taskId = lines[0]!
    await run('propose', taskId)

    // simulate a running plan step raising a feedback gate — normally appended by the DBOS
    // port's `feedback` branch (Task 2); Task 5 only adds the human-facing reply/annotate surface
    const runToken = `step:${taskId}:plan:a1`
    await log.append({ taskId, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'db choice?', topic: 'auth-1' } })

    lines.length = 0
    await run('plan-note', taskId, 'db', 'use bcrypt', '--ref', 'api')
    expect(lines[0]).toContain("noted on 'db'")
    expect((await log.byTask(taskId)).some(e => e.kind === EVENT_KIND.plan_annotated)).toBe(true)

    lines.length = 0
    await run('reply', taskId, 'approve')
    expect(lines[0]).toContain('auth-1')
    expect(sent).toEqual([{ id: runToken, message: 'approve', topic: 'feedback:auth-1' }])

    lines.length = 0
    await run('reply', taskId, 'again')
    expect(lines[0]).toContain('no open feedback')

    await log.close()
  })

  it('reply requires a live execution port (needPort gate, same as run/retry/cancel)', async () => {
    const { run } = await makeCli() // no portFactory
    await expect(run('reply', 'whatever', 'approve')).rejects.toThrow(/execution commands are unavailable/)
  })

  it('status surfaces the open feedback question so the human sees what to reply to', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })
    const t = await kernel.createTask({ title: 'grounded' })
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes or approve?', topic: 'plan-1' } })

    lines.length = 0
    await run('status', t.id)
    expect(lines.join('\n')).toContain('changes or approve?')
    await log.close()
  })

  it('plan-revise annotates each scoped note with the text, then resumes the open feedback', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const sent: Array<{ id: string; message: string; topic: string }> = []
    const { kernel, log } = await openKernel(db.url, {
      projectId: TEST_PROJECT_ID,
      send: async (id, message, topic) => { sent.push({ id, message, topic }) },
    })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const stubPort: ExecutionPort = {
      startRun: async () => { throw new Error('unused in this test') },
      retry: async () => { throw new Error('unused in this test') },
      cancelRun: async () => {},
    }
    const run = async (...args: string[]) => buildProgram(kernel, async () => stubPort).parseAsync(args, { from: 'user' })

    await run('new', 'grounded task')
    const taskId = lines[0]!
    await run('propose', taskId)
    const runToken = `step:${taskId}:plan:a1`
    await log.append({ taskId, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes?', topic: 'auth-1' } })

    lines.length = 0
    await run('plan-revise', taskId, 'use argon2', '--scope', 'db', 'api')
    const annotated = (await log.byTask(taskId)).filter(e => e.kind === EVENT_KIND.plan_annotated)
    expect(annotated.map(e => (e.payload as { targetNote: string }).targetNote).sort()).toEqual(['api', 'db'])
    expect(annotated.every(e => (e.payload as { text: string }).text === 'use argon2')).toBe(true)
    // one send resumes the plan agent with the revise text — it reads the queued annotations on wake
    expect(sent).toEqual([{ id: runToken, message: 'use argon2', topic: 'feedback:auth-1' }])
    await log.close()
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
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { host, hub } = await buildPlugins(config) // real plugin wiring — no stub casts
    const plugin = { host, hub, config, log }
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

    await hub.close()
    await host.shutdown()
    await log.close()
  })
})
