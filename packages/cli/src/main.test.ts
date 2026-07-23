import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import { Surreal } from 'surrealdb'
import { EVENT_KIND, MemoryAccessedPayload, type ExecutionPort, type OperationSpec } from '@orc/contracts'
import { loadConfig, projectDatabaseName, requireProject, type ProjectConfig } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { buildProgram, openKernel, runInit } from './main'

// exitOverride must reach NESTED subcommands too (e.g. `memory neighbors`): commander only
// copies the setting to children created afterwards, and buildProgram creates them all before
// any test can call exitOverride — so a subcommand option error would process.exit(1) and kill
// the whole test process mid-suite instead of rejecting.
const overrideExits = (program: ReturnType<typeof buildProgram>): ReturnType<typeof buildProgram> => {
  const walk = (c: Command): void => {
    c.exitOverride()
    for (const sub of c.commands) walk(sub)
  }
  walk(program)
  return program
}
import { buildPlugins } from './runtime'

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealConfigs: ProjectConfig[] = []
// Teardown drops one Postgres DB per makeCli/openKernel (14+ here) plus each throwaway Surreal db.
// Each pg drop runs its handle's registered closers first (createTestDb.onClose) and then DROPs on
// its own admin connection; serial drops blew bun's default 5s hook budget under a contended pg
// (same fix as kernel.test.ts) — the dbs are distinct, so drop them concurrently.
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
  const { kernel, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '))
  })
  // fresh Command instance per invocation; commander does not re-parse cleanly
  const run = async (...args: string[]) => {
    await overrideExits(buildProgram(kernel)).parseAsync(args, { from: 'user' })
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
    const config = requireProject(loadConfig(dir))
    expect(config.projectName).toBe('demo')
    for (const name of ['codebase-analysis', 'plan-authoring', 'documentation', 'web-research'])
      expect(existsSync(path.join(config.skillsDir, name, 'SKILL.md'))).toBe(true)
  })

  it('init honors a custom skills directory and preserves existing skill files', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-init-custom-'))
    mkdirSync(path.join(dir, '.orc'), { recursive: true })
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ skillsDir: 'custom/skills' }))
    const existing = path.join(dir, 'custom', 'skills', 'documentation', 'SKILL.md')
    mkdirSync(path.dirname(existing), { recursive: true })
    writeFileSync(existing, 'user-owned documentation skill')

    await runInit(['--name', 'demo'], dir)

    expect(readFileSync(existing, 'utf8')).toBe('user-owned documentation skill')
    for (const name of ['codebase-analysis', 'plan-authoring', 'web-research'])
      expect(existsSync(path.join(dir, 'custom', 'skills', name, 'SKILL.md'))).toBe(true)
  })

  it('buildProgram exposes pre-bootstrap init and db commands', async () => {
    const { kernel } = await makeCli()
    expect(buildProgram(kernel).commands.map(c => c.name())).toEqual(expect.arrayContaining(['init', 'db']))
  })

  it('replay reconstructs operation state at a sequence and appends nothing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => {
      await overrideExits(buildProgram(kernel)).parseAsync(args, { from: 'user' })
    }

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

  it('replay --at below the task range explains that sequences are global', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const t = await kernel.createTask({ title: 'audit me', spec: '' })
    const events = await kernel.eventsFor(t.id)
    const first = events[0]!.seq
    const errors: string[] = []
    spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
    const prevExit = process.exitCode
    await overrideExits(buildProgram(kernel)).parseAsync(['replay', t.id, '--at', String(first - 1)], { from: 'user' })
    expect(errors.join('\n')).toContain('sequences are GLOBAL')
    expect(errors.join('\n')).toContain(`${first}..${events.at(-1)!.seq}`)
    process.exitCode = prevExit // the out-of-range replay sets exitCode 1 by design — don't leak it to the test process
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

  it('log and replay reject unknown task ids', async () => {
    const { run } = await makeCli()
    await expect(run('log', 'missing-task')).rejects.toThrow("no task 'missing-task'")
    await expect(run('replay', 'missing-task')).rejects.toThrow("no task 'missing-task'")
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
    await run('plan', taskId, '--json')
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.steps[0].skillRefs).toEqual(['documentation'])
  })

  it('plan prints the plan as JSON', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'x')
    const taskId = lines[0]
    await run('propose', taskId, '--model', 'ollama/llama3')
    lines.length = 0
    await run('plan', taskId, '--json')
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.steps[0].modelRef).toBe('ollama/llama3')
    expect(plan.strategyRef).toBe('template:single')

    lines.length = 0
    await run('plan', taskId) // default render is the human review, not JSON
    expect(lines.join('\n')).toContain('cost estimate:')
  })

  it('plan and approve reject non-integer versions during argument parsing', async () => {
    const { kernel } = await makeCli()
    const parse = (...args: string[]) => {
      return overrideExits(buildProgram(kernel)).parseAsync(args, { from: 'user' })
    }
    await expect(parse('plan', 'missing', '--version', 'nope')).rejects.toThrow(/integer/)
    await expect(parse('approve', 'missing', '--version', '1.5')).rejects.toThrow(/integer/)
    await expect(parse('replay', 'missing', '--at', '1e2')).rejects.toThrow(/integer/)
  })

  it('tasks makes an empty project explicit', async () => {
    const { run, lines } = await makeCli()
    await run('tasks')
    expect(lines).toEqual(['_no tasks_'])
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
    await run('plan', taskId, '--json')
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
    await run('plan', taskId, '--json')
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

  it('status shows the analysis coverage once the analyze step has reported it', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })
    const t = await kernel.createTask({ title: 'grounded' })
    await kernel.reportCoverage(
      { taskId: t.id, stepId: 'analyze', runToken: `step:${t.id}:analyze:a1` },
      { analyzed: true, scope: ['packages'], gaps: ['no tests read'], confidence: 'medium', notesWritten: 3 },
    )
    lines.length = 0
    await run('status', t.id)
    const out = lines.join('\n')
    expect(out).toContain('analysis')
    expect(out).toContain('no tests read') // the gap surfaces so the human sees what was NOT covered
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
  // A DBOS-cancelled workflow's getResult() rejects. Every stub port in this file has
  // `wait: async () => outcome`, so no test ever exercised the rejecting path — and `orc run`
  // only handled the resolve branch, printing a raw driver error and exit 1 for an advertised
  // action ("ctrl-c stops the run") while `orc status` correctly showed 'cancelled'.
  it('run reports a cancelled workflow as cancelled, not as a crash', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const cancellingPort: ExecutionPort = {
      startRun: async () => ({
        workflowId: 'wf-1',
        wait: async () => { throw new Error('Workflow wf-1 was cancelled') },
      }),
      retry: async () => { throw new Error('unused') },
      cancelRun: async () => {},
    }
    const run = (...args: string[]) => buildProgram(kernel, async () => cancellingPort).parseAsync(args, { from: 'user' })

    await run('new', 'cancel me')
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)
    // the cancel that raced the run: the task is already terminal when wait() rejects, which is
    // exactly the state `orc cancel` leaves behind (it appends under the project lock)
    await log.append({
      taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId, from: 'running', to: 'cancelled' },
    })

    lines.length = 0
    await run('run', taskId)
    expect(lines.join('\n')).toContain('run finished: cancelled')
    await log.close()
  })

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
    const run = (...args: string[]) => overrideExits(buildProgram(kernel, undefined, plugin)).parseAsync(args, { from: 'user' })

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

    // `cat` is a read: it records one access, and `ls` surfaces the count so a human can see
    // which knowledge is actually load-bearing. A miss records nothing — the note wasn't read.
    const accesses = () => log.all().then(es => es.filter(e => e.kind === EVENT_KIND.memory_accessed))
    expect(await accesses()).toHaveLength(1)
    lines.length = 0
    await run('memory', 'ls')
    expect(lines.join('\n')).toContain('hits 1')

    await expect(run('memory', 'cat', 'no-such-note-here')).rejects.toThrow()
    expect(await accesses()).toHaveLength(1)

    await run('memory', 'rm', id) // rm's action already runs catchUp() itself
    lines.length = 0
    await expect(run('memory', 'cat', id)).rejects.toThrow(`no note '${id}'`)
    expect(await accesses()).toHaveLength(1) // a deleted note is a miss, not a read

    // Empty results print a sentinel, the way `tasks` does. Zero bytes reads as "no such note"
    // when the honest answer is "the read model returned nothing" — the agent-facing tools
    // already say exactly that, so the human must not get less.
    lines.length = 0
    await run('memory', 'ls')
    expect(lines.join('\n').trim()).toBe('_no notes_')
    lines.length = 0
    await run('memory', 'search', 'definitely-not-present-anywhere')
    expect(lines.join('\n').trim()).toBe('_no notes_')

    // --- neighbors traversal (M4b) -------------------------------------------------------------
    // memory add has no --links flag, so seed a linked graph the way the cancel-sweep test seeds
    // notes: append memory_written directly, then rebuild the read model from this test's own log.
    // Chain: seed --depends_on--> hop1 --relates_to--> hop2, plus seed --refines--> other.
    const seedNote = (nid: string, links: Array<{ id: string; kind: string }> = []) =>
      log.append({
        taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
        payload: { note: { id: nid, title: nid, links }, author: { source: 'cli' } },
      })
    await seedNote('nb-seed', [{ id: 'nb-hop1', kind: 'depends_on' }, { id: 'nb-other', kind: 'refines' }])
    await seedNote('nb-hop1', [{ id: 'nb-hop2', kind: 'relates_to' }])
    await seedNote('nb-hop2')
    await seedNote('nb-other')
    await seedNote('nb-isolated') // no links either way
    await run('memory', 'rebuild')

    const accessCount = () => log.all().then(es => es.filter(e => e.kind === EVENT_KIND.memory_accessed).length)

    // 1. bare neighbors prints the linked neighbor with its via/depth/score/title row.
    const beforeHit = await accessCount()
    lines.length = 0
    await run('memory', 'neighbors', 'nb-seed')
    const nbOut = lines.join('\n')
    expect(nbOut).toContain('nb-hop1')
    expect(nbOut).toContain('nb-other')
    // row shape: id\t<dir> via\tdepth\tscore(2dp)\ttitle  (dir: → seed→n, ← n→seed)
    const hop1Row = lines.find(l => l.startsWith('nb-hop1\t'))!
    expect(hop1Row).toBeDefined()
    const cols = hop1Row.split('\t')
    expect(cols[1]).toMatch(/^[→←] depends_on$/) // direction-tagged link kind
    expect(cols[2]).toBe('1')               // depth (1 hop from the seed)
    expect(cols[3]).toMatch(/^\d+\.\d{2}$/) // score, 2 decimals
    expect(cols[4]).toMatch(/^act \d+\.\d\d$/) // activation column (2 decimals)
    expect(cols[5]).toBe('nb-hop1')         // title

    // Acceptance #3: a hit records exactly one memory_accessed(mode:neighbors) against the SEED.
    const afterHit = await accessCount()
    expect(afterHit).toBe(beforeHit + 1)
    const accessed = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_accessed)
    const lastAccess = MemoryAccessedPayload.parse(accessed.at(-1)!.payload)
    expect(lastAccess.mode).toBe('neighbors')
    expect(lastAccess.id).toBe('nb-seed')

    // 2. --kinds depends_on narrows: nb-other (refines) is excluded, nb-hop1 (depends_on) stays.
    lines.length = 0
    await run('memory', 'neighbors', 'nb-seed', '--kinds', 'depends_on')
    const kindsOut = lines.join('\n')
    expect(kindsOut).toContain('nb-hop1')
    expect(kindsOut).not.toContain('nb-other')

    // an unknown kind is a friendly error, not a silent empty result (matches --strategy).
    await expect(run('memory', 'neighbors', 'nb-seed', '--kinds', 'not-a-kind')).rejects.toThrow(/unknown --kinds/)

    // 3. --depth 1 bounds traversal: the 2-hop nb-hop2 is absent at depth 1, present by default (2).
    lines.length = 0
    await run('memory', 'neighbors', 'nb-seed', '--depth', '1')
    expect(lines.join('\n')).not.toContain('nb-hop2')
    lines.length = 0
    await run('memory', 'neighbors', 'nb-seed', '--depth', '2')
    expect(lines.join('\n')).toContain('nb-hop2')

    // depth < 1 is rejected at parse time (store default is 2, rank needs a positive hop count).
    await expect(run('memory', 'neighbors', 'nb-seed', '--depth', '0')).rejects.toThrow(/positive integer/)

    // 4. --scope selects: the seeded notes live in the default 'project' scope; an explicit
    // --scope project still finds them.
    lines.length = 0
    await run('memory', 'neighbors', 'nb-seed', '--scope', 'project')
    expect(lines.join('\n')).toContain('nb-hop1')

    // 6. empty case: an isolated seed prints the sentinel and records NO new access.
    const beforeMiss = await accessCount()
    lines.length = 0
    await run('memory', 'neighbors', 'nb-isolated')
    expect(lines.join('\n').trim()).toBe('_no neighbors_')
    expect(await accessCount()).toBe(beforeMiss) // a miss records nothing

    // quick capture: same plugin wiring, zero ceremony, slugged-title id
    lines.length = 0
    await run('note', 'Quick Capture Works!', '--summary', 'from the test')
    expect(lines.join('\n')).toContain("noted 'quick-capture-works'")
    lines.length = 0
    await run('memory', 'cat', 'quick-capture-works')
    expect(lines.join('\n')).toContain('from the test')

    await hub.close()
    await host.shutdown()
    await log.close()
  })
})

describe('cancel-sweep wiring (real plugin, stub port)', () => {
  it('cancel sweeps the task-owned orphan, keeps the adopted id, and stamps provenance', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-cancel-sweep-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { host, hub } = await buildPlugins(config)
    const stubPort: ExecutionPort = {
      startRun: async () => { throw new Error('unused') },
      retry: async () => { throw new Error('unused') },
      cancelRun: async () => {},
    }
    const run = (...args: string[]) =>
      buildProgram(kernel, async () => stubPort, { host, hub, config, log }).parseAsync(args, { from: 'user' })

    await run('new', 'sweep wiring')
    const taskId = lines[0]!
    const write = (id: string, author: Record<string, unknown>) => log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id, title: id }, author },
    })
    await write('wiring-orphan', { source: 'agent', taskId })
    await write('wiring-adopted', { source: 'agent', taskId })
    await write('wiring-adopted', { source: 'cli' }) // re-written by a live writer -> adopted

    lines.length = 0
    await run('cancel', taskId)
    const out = lines.join('\n')
    expect(out).toContain('cancelled')
    expect(out).toContain('swept wiring-orphan')
    expect(out).not.toContain('swept wiring-adopted')
    const deleted = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_deleted)
    expect(deleted.map(e => (e.payload as { id: string }).id)).toEqual(['wiring-orphan'])
    expect((deleted[0]!.payload as { author: { taskId?: string } }).author.taskId).toBe(taskId)

    // failure path: a sweep failure warns; the cancel itself still exits clean
    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const afterSpy = spyOn(log, 'after').mockImplementation(async () => { throw new Error('surreal down') })
    lines.length = 0
    await run('cancel', taskId) // must not reject
    expect(lines.join('\n')).toContain('cancelled')
    expect(warns.join('\n')).toContain('sweep skipped: surreal down')
    afterSpy.mockRestore(); warnSpy.mockRestore()
    await log.close()
  })
})
