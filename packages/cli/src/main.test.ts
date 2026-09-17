import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import { Surreal } from 'surrealdb'
import { ApprovalPolicy, EVENT_KIND, MemoryAccessedPayload, MemoryDeletedPayload, MemoryWrittenPayload, NOTE_TIER, ROLE_SKILL, RUN_OUTCOME, TASK_STATUS, WORKSPACE_KIND, claimId, type ExecutionPort, type OperationSpec, type RunOutcome, type TaskNode, type TaskStatus } from '@orc/contracts'
import { loadConfig, projectDatabaseName, requireProject, type EventLog, type ProjectConfig } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { singleStepDraft } from './plan-template'
import { buildProgram, openKernel, runInit } from './main'
import { withMemory } from './memory-open'
import { CommandFailure } from './exit'
import { watchSubtree } from './watch'

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
import { archivedRefusal } from './workspace-ops'

// memory_written / memory_deleted payloads parsed through their owning schemas at the read
// boundary, the same way main.ts's claims fold reads them.
const notePayloadId = (payload: unknown): string => MemoryWrittenPayload.parse(payload).note.id
// Read the kind off the LOG rather than through `memory cat`, which would record a memory_accessed
// event and throw off the access-count assertions this same test makes.
const notePayloadKind = (payload: unknown): string | undefined => {
  const note = MemoryWrittenPayload.parse(payload).note
  return note.tier === NOTE_TIER.semantic ? note.kind : undefined
}
const deletedAuthorTaskId = (payload: unknown): string | null | undefined =>
  MemoryDeletedPayload.parse(payload).author.taskId

const dbs: Array<{ drop: () => Promise<void> }> = []
const surrealConfigs: ProjectConfig[] = []
// Process-scoped resources (a real plugin host, an MCP hub, an event-log pool) registered the
// moment they are created and drained LIFO. A bare `await host.shutdown()` as the last statement
// of an it() is SKIPPED when an assertion above it throws, which leaks the host into every later
// test file in the process — that is what turned one failed assertion on this branch into a
// 22-failure mystery, and it is why the db.drop() below got skipped too. Same idiom as
// kernel/src/execution/memory-access.integration.test.ts.
const cleanup: Array<() => Promise<void> | void> = []
// Teardown drops one Postgres DB per makeCli/openKernel (14+ here) plus each throwaway Surreal db.
// Each pg drop runs its handle's registered closers first (createTestDb.onClose) and then DROPs on
// its own admin connection; serial drops blew bun's default 5s hook budget under a contended pg
// (same fix as kernel.test.ts) — the dbs are distinct, so drop them concurrently.
afterAll(async () => {
  for (const c of cleanup.reverse()) await c()
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
  // buildProgram(kernel) has no project context, so `new` cannot resolve a cwd workspace here —
  // the tests below pass --workspace explicitly, and this is the record they name.
  await seedTestWorkspace(storage.events)
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '))
  })
  // fresh Command instance per invocation; commander does not re-parse cleanly
  const run = async (...args: string[]) => {
    await overrideExits(buildProgram(kernel)).parseAsync(args, { from: 'user' })
    return lines
  }
  // exposed for tests that must append a raw event the kernel would never produce itself (an
  // orphaned task_created naming a workspace the fold never saw)
  return { run, lines, kernel, storage }
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

  // An existing project could not receive a NEWLY shipped skill: init refused outright once
  // identity existed, and --force minted a whole new project (a different projectId — every task,
  // note and event orphaned) just to top up a directory. Seeding is now unconditional and identity
  // minting is the part that is guarded, so `orc init` is the answer to "I pulled a release that
  // ships a new role skill".
  it('init is idempotent: a second run keeps the identity and re-seeds a deleted skill', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-init-again-'))
    await runInit(['--name', 'demo'], dir)
    const first = requireProject(loadConfig(dir))
    const skill = path.join(first.skillsDir, ROLE_SKILL.finisher, 'SKILL.md')
    expect(existsSync(skill)).toBe(true)
    rmSync(path.dirname(skill), { recursive: true, force: true })

    await runInit(['--name', 'ignored'], dir) // exits 0 — no throw, no new identity

    const second = requireProject(loadConfig(dir))
    expect(second.projectId).toBe(first.projectId)
    expect(second.projectName).toBe('demo') // the existing identity wins; --name is not a rename
    expect(existsSync(skill)).toBe(true)    // the deleted skill is back
  })

  it('buildProgram exposes pre-bootstrap init and db commands', async () => {
    const { kernel } = await makeCli()
    expect(buildProgram(kernel).commands.map(c => c.name())).toEqual(expect.arrayContaining(['init', 'db']))
  })

  it('replay reconstructs operation state at a sequence and appends nothing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => {
      await overrideExits(buildProgram(kernel)).parseAsync(args, { from: 'user' })
    }

    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'audit me' })
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
  })

  it('replay --at below the task range explains that sequences are global', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'audit me', spec: '' })
    const events = await kernel.eventsFor(t.id)
    const first = events[0]!.seq
    const errors: string[] = []
    spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
    // The command reports the problem and FAILS — as a thrown outcome, not by writing
    // process.exitCode. Running this test can no longer change the exit status of the test process,
    // which is what used to make a 0-failure suite exit 1 in CI depending on file order.
    await expect(overrideExits(buildProgram(kernel)).parseAsync(['replay', t.id, '--at', String(first - 1)], { from: 'user' }))
      .rejects.toBeInstanceOf(CommandFailure)
    expect(errors.join('\n')).toContain('sequences are GLOBAL')
    expect(errors.join('\n')).toContain(`${first}..${events.at(-1)!.seq}`)
    expect(process.exitCode ?? 0).toBe(0) // the global stays untouched — that is the point
  })

  it('log --json prints the full stored envelope', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'json log' })
    lines.length = 0
    await run('log', t.id, '--json')
    const records = JSON.parse(lines.join('\n'))
    expect(records[0]).toMatchObject({ kind: 'task_created', projectId: TEST_PROJECT_ID, idempotencyKey: null })
    expect(records[0].seq).toBeGreaterThan(0)
  })

  it('log and replay reject unknown task ids', async () => {
    const { run } = await makeCli()
    await expect(run('log', 'missing-task')).rejects.toThrow("no task 'missing-task'")
    await expect(run('replay', 'missing-task')).rejects.toThrow("no task 'missing-task'")
  })

  it('new → propose → approve → log round-trip', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'hello world', '--spec', 'do things', '--workspace', TEST_WORKSPACE_ID)
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

  it('new --workspace binds the task to the named workspace', async () => {
    const { run, kernel } = await makeCli()
    const w = await kernel.createWorkspace({ title: 'W', cwd: '/w', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false })
    const [id] = await run('new', 'T', '--workspace', w.id)
    expect(id).toBeDefined()
    expect((await kernel.getTask(id ?? ''))?.workspaceId).toBe(w.id)
  })

  // The kernel accepts a task in an archived workspace, and should: archiving is not a fact about
  // whether a record may be REFERENCED, and a merged workspace's subtree keeps growing. The refusal
  // belongs at the door, where a human named the id: that operator archived the checkout on purpose,
  // so a task filed there is work the default listing hides and the directory may no longer hold.
  it('new --workspace refuses an archived workspace and names the way back', async () => {
    const { run, kernel } = await makeCli()
    const w = await kernel.createWorkspace({ title: 'Done', cwd: '/done', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false })
    await kernel.setWorkspaceArchived(w.id, true)
    await expect(run('new', 'T', '--workspace', w.id)).rejects.toThrow(archivedRefusal(w.id))
    expect((await kernel.listTasks()).some(t => t.workspaceId === w.id)).toBe(false)
    // restored, the same command works — the refusal is about standing, not about the id
    await kernel.setWorkspaceArchived(w.id, false)
    const [id] = await run('new', 'T', '--workspace', w.id)
    expect((await kernel.getTask(id ?? ''))?.workspaceId).toBe(w.id)
  })

  // A child of a task in workspace B belongs to B, wherever the operator happened to type the
  // command. Binding it to the cwd instead would let ONE subtree straddle two working directories —
  // the thing proposeSplit's inheritance exists to prevent.
  it('new --parent inherits the parent\'s workspace instead of the directory the command was typed in', async () => {
    const { run, lines, kernel } = await makeCli()
    const other = await kernel.createWorkspace({ title: 'Other', cwd: '/other', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false })
    await run('new', 'P', '--workspace', other.id)
    const parentId = lines[0]!
    lines.length = 0
    await run('new', 'C', '--parent', parentId) // no --workspace: the parent decides
    const childId = lines[0]!
    expect((await kernel.getTask(childId))?.workspaceId).toBe(other.id)
    // …and an explicit --workspace still overrides the parent, for a deliberate re-home
    lines.length = 0
    await run('new', 'C2', '--parent', parentId, '--workspace', TEST_WORKSPACE_ID)
    expect((await kernel.getTask(lines[0]!))?.workspaceId).toBe(TEST_WORKSPACE_ID)
  })

  it('new rejects an unrecognized --strategy value instead of silently falling through', async () => {
    const { run } = await makeCli()
    await expect(run('new', 'x', '--strategy', 'grounded', '--workspace', TEST_WORKSPACE_ID)).rejects.toThrow(/unknown --strategy 'grounded'/)
  })

  it('propose --skill places the named skills in the template step', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'documented task', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId, '--model', 'ollama/llama3', '--skill', 'documentation')
    lines.length = 0
    await run('plan', taskId, '--json')
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.steps[0].skillRefs).toEqual(['documentation'])
  })

  it('plan prints the plan as JSON', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'x', '--workspace', TEST_WORKSPACE_ID)
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
    // graph --port used a bare parseInt, so '--port 0' bound port 0 and '--port nope' fed NaN to
    // the server; both must die at parse time like every other numeric option in this file
    await expect(parse('graph', '--port', '0')).rejects.toThrow(/positive integer/)
    await expect(parse('graph', '--port', 'nope')).rejects.toThrow(/integer/)
  })

  it('tasks makes an empty project explicit', async () => {
    const { run, lines } = await makeCli()
    await run('tasks')
    expect(lines).toEqual(['_no tasks_'])
  })

  it('tasks lists id, status and title, indented under its workspace heading', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'listed task', '--workspace', TEST_WORKSPACE_ID)
    lines.length = 0
    await run('tasks')
    expect(lines[0]).toContain(TEST_WORKSPACE.title) // the group heading comes first
    expect(lines[1]).toContain('draft')
    expect(lines[1]).toContain('listed task')
  })

  // groups.map(...) alone would drop a workspace with zero tasks — this pins that a bare heading
  // still prints, since "nothing is running here" is itself information an operator needs.
  it('tasks prints tasks grouped under their workspace, and an empty workspace still gets a heading', async () => {
    const { run, kernel } = await makeCli()
    const empty = await kernel.createWorkspace({ title: 'Empty', cwd: '/empty', branch: 'e', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false })
    const w = await kernel.createWorkspace({ title: 'Feature X', cwd: '/w', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false })
    await kernel.createTask({ title: 'inside', workspaceId: w.id })
    const out = (await run('tasks')).join('\n')
    expect(out.indexOf('Feature X')).toBeLessThan(out.indexOf('inside'))
    expect(out).toContain(`# ${empty.title}  (${empty.branch})  ${empty.cwd}`)
  })

  // A task naming a workspace the fold never saw is a log defect (Task 7's grouping is only as
  // trustworthy as its handling of the case it cannot group) — it must surface loudly, not vanish
  // from a view keyed by workspace.
  it('tasks prints an orphaned task under a loud heading, never hidden', async () => {
    const { run, storage } = await makeCli()
    const orphan: TaskNode = {
      id: 'orphan-1', parentId: null, workspaceId: 'workspace-the-fold-never-saw', type: 'generic',
      title: 'ghost task', spec: '', status: TASK_STATUS.draft, zone: [], budgetUSD: null,
      depth: 0, createdAt: '2026-09-14T00:00:00.000Z',
    }
    await storage.events.append({
      taskId: orphan.id, stepId: null, runToken: null,
      kind: EVENT_KIND.task_created, payload: { task: orphan },
    })
    const out = (await run('tasks')).join('\n')
    // an -1 (heading absent) would sort "before" any real index, so pin the heading's presence too
    expect(out).toContain('# ORPHANED — workspace missing from the log')
    expect(out.indexOf('# ORPHANED — workspace missing from the log')).toBeLessThan(out.indexOf('ghost task'))
  })

  it('propose --file loads a plan draft from disk', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'file task', '--workspace', TEST_WORKSPACE_ID)
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
    await run('new', 'bad file task', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]

    const badPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-draft-')), 'bad.json')
    writeFileSync(badPath, '{not json')

    await expect(run('propose', taskId, '--file', badPath)).rejects.toThrow()
  })

  it('edit round-trip bumps the plan version and logs plan_edited', async () => {
    const { run, lines } = await makeCli()
    await run('new', 'edit task', '--workspace', TEST_WORKSPACE_ID)
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
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    // `reply` calls needPort() before replyFeedback (DBOS.send needs DBOS launched in-process), and
    // then ATTACHES to the run it just unblocked — answering without driving is what left runs
    // parked. The real send path is still the injected `send` above; startRun here only stands in
    // for the driver so the reply can complete.
    const stubPort: ExecutionPort = {
      startRun: async () => ({ workflowId: 'run:x:v1', wait: async () => RUN_OUTCOME.done }),
      retry: async () => { throw new Error('unused in this test') },
      cancelRun: async () => {},
    }
    const run = async (...args: string[]) => buildProgram(kernel, async () => stubPort).parseAsync(args, { from: 'user' })

    await run('new', 'grounded task', '--workspace', TEST_WORKSPACE_ID)
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
    // The answer is what this asserts. Nothing in this harness holds a runtime, so the watch that
    // follows reports the tree as it stands — stopped short of done — and exits non-zero for it.
    await expect(run('reply', taskId, 'approve')).rejects.toBeInstanceOf(CommandFailure)
    expect(lines[0]).toContain('auth-1')
    expect(sent).toEqual([{ id: runToken, message: 'approve', topic: 'feedback:auth-1' }])

    lines.length = 0
    await run('reply', taskId, 'again')
    expect(lines[0]).toContain('no open feedback')
  })

  it('reply requires a live execution port (needPort gate, same as run/retry/cancel)', async () => {
    const { run } = await makeCli() // no portFactory
    await expect(run('reply', 'whatever', 'approve')).rejects.toThrow(/execution commands are unavailable/)
  })

  it('status surfaces the open feedback question so the human sees what to reply to', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded' })
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes or approve?', topic: 'plan-1' } })

    lines.length = 0
    await run('status', t.id)
    expect(lines.join('\n')).toContain('changes or approve?')
  })

  it('status shows the analysis coverage once the analyze step has reported it', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded' })
    await kernel.reportCoverage(
      { taskId: t.id, stepId: 'analyze', runToken: `step:${t.id}:analyze:a1` },
      { analyzed: true, scope: ['packages'], gaps: ['no tests read'], confidence: 'medium', notesWritten: 3 },
    )
    lines.length = 0
    await run('status', t.id)
    const out = lines.join('\n')
    expect(out).toContain('analysis')
    expect(out).toContain('no tests read') // the gap surfaces so the human sees what was NOT covered
  })

  it('status prints a per-step usage/cost line for a step with recorded agent_call usage', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel).parseAsync(args, { from: 'user' })

    await run('new', 'usage task', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId) // singleStepDraft's one step, id 's1'

    const runToken = `step:${taskId}:s1:a1`
    await log.append({
      taskId, stepId: 's1', runToken, kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 111, outputTokens: 22, costUSD: 0.0123, estimated: false },
    })

    lines.length = 0
    await run('status', taskId)
    const stepLineIdx = lines.findIndex(l => l.includes('s1') && l.includes('pending'))
    expect(stepLineIdx).toBeGreaterThanOrEqual(0)
    // the usage line lives directly under the step's own row — a per-step render, not a reuse of
    // the trailing task-total line further down
    expect(lines[stepLineIdx + 1]).toContain('tokens in/out: 111/22')
    expect(lines[stepLineIdx + 1]).toContain('cost: $0.0123')
  })

  it('plan-revise annotates each scoped note with the text, then resumes the open feedback', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const sent: Array<{ id: string; message: string; topic: string }> = []
    const { kernel, log } = await openKernel(db.url, {
      projectId: TEST_PROJECT_ID,
      send: async (id, message, topic) => { sent.push({ id, message, topic }) },
    })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const stubPort: ExecutionPort = {
      startRun: async () => { throw new Error('unused in this test') },
      retry: async () => { throw new Error('unused in this test') },
      cancelRun: async () => {},
    }
    const run = async (...args: string[]) => buildProgram(kernel, async () => stubPort).parseAsync(args, { from: 'user' })

    await run('new', 'grounded task', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    const runToken = `step:${taskId}:plan:a1`
    await log.append({ taskId, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes?', topic: 'auth-1' } })

    lines.length = 0
    await run('plan-revise', taskId, 'use argon2', '--scope', 'db', 'api')
    const annotated = (await log.byTask(taskId)).filter(e => e.kind === EVENT_KIND.plan_annotated)
    expect(annotated.map(e => e.payload.targetNote).sort()).toEqual(['api', 'db'])
    expect(annotated.every(e => e.payload.text === 'use argon2')).toBe(true)
    // one send resumes the plan agent with the revise text — it reads the queued annotations on wake
    expect(sent).toEqual([{ id: runToken, message: 'use argon2', topic: 'feedback:auth-1' }])
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
  it('run reports a cancelled run as cancelled, not as a crash', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = (...args: string[]) => buildProgram(kernel, async () => forbiddenPort()).parseAsync(args, { from: 'user' })

    await run('new', 'cancel me', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)

    lines.length = 0
    // cancelled is reported as the outcome it is, and the command exits non-zero for it — the
    // status `orc cancel` from another terminal leaves behind, read off the log rather than off a
    // rejected getResult(), because the watcher no longer holds the workflow handle
    let failure: unknown = null
    const watched = run('run', taskId).catch((e: unknown) => { failure = e })
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.cancelled)
    await watched
    expect(failure).toBeInstanceOf(CommandFailure)
    expect(lines.join('\n')).toContain(`run finished: ${RUN_OUTCOME.cancelled}`)
  }, 15_000)

  // one split child, shaped like the ones `task_split` proposes — the only variable is the policy
  const splitArgs = (taskId: string, toolCallId: string, title: string, policy: ApprovalPolicy) => ({
    parentTaskId: taskId, stepId: 's1', runToken: `step:${taskId}:s1:a1`, toolCallId, title, spec: '',
    plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
    parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
    policy, maxDepth: 3,
  })

  it('the run watch names a child the manual policy gated — the wait that emits no event', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = (...args: string[]) => buildProgram(kernel, async () => forbiddenPort()).parseAsync(args, { from: 'user' })

    await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})))

    lines.length = 0
    const watched = run('run', taskId)
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await watched
    // a gated child is a stopping point, not a hang: the watch ends and names what unblocks it
    expect(lines.join('\n')).toContain('gated child')
    expect(lines.join('\n')).toContain(`orc approve ${child.childTaskId}`)
  }, 15_000)

  it('a split gated mid-run is named while the watch is still attached', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = (...args: string[]) => buildProgram(kernel, async () => forbiddenPort()).parseAsync(args, { from: 'user' })

    await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)

    lines.length = 0
    const watched = run('run', taskId)
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})))
    // split_proposed arrives over LISTEN/NOTIFY, so the advisory lands a tick or two later
    await until(() => lines.join('\n').includes('orc approve'))
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await watched

    expect(lines.join('\n')).toContain(`orc approve ${child.childTaskId}`)
  }, 15_000)

  it('a question parked on a child parks the parent tail, naming the CHILD to reply to', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    // the parent is inside join_splits' recv while the child works: its own stream stays silent
    const port: ExecutionPort = {
      startRun: async () => ({ workflowId: 'wf-1', wait: () => new Promise<RunOutcome>(() => {}) }),
      retry: async () => { throw new Error('unused') },
      cancelRun: async () => {},
    }
    const run = (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })

    await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'child', ApprovalPolicy.parse({ default: 'auto' })))
    await log.append({
      taskId: child.childTaskId, stepId: 'w1', runToken: `step:${child.childTaskId}:w1:a1`,
      kind: EVENT_KIND.feedback_requested, payload: { question: 'may I overwrite it?', topic: 'confirm' },
    })

    lines.length = 0
    await run('run', taskId)
    expect(lines.join('\n')).toContain('may I overwrite it?')
    expect(lines.join('\n')).toContain(`orc reply ${child.childTaskId} <text>`)
  }, 15_000)

  it('orc run records the ask and watches — it never starts a workflow itself', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = (...args: string[]) => buildProgram(kernel, async () => forbiddenPort()).parseAsync(args, { from: 'user' })

    await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)

    lines.length = 0
    // forbiddenPort throws on startRun, so this completing at all is the assertion: the command
    // reached its runtime only to hold one, never to drive with it
    const watched = run('run', taskId)
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await watched

    const requested = (await kernel.eventsFor(taskId)).filter(e => e.kind === EVENT_KIND.run_requested)
    expect(requested).toHaveLength(1)
    // `orc run` passed no --cwd, so the kernel records the TASK'S WORKSPACE cwd — the port's own
    // chain never sees the project-level workspace events, so the resolution has to happen here.
    expect(requested[0]!.payload).toEqual({ taskId, cwd: TEST_WORKSPACE.cwd, retry: false })
  }, 15_000)

  it('orc run refuses an undrivable task before recording anything', async () => {
    const { run, lines, kernel } = await makeCli()
    await run('new', 'never approved', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await expect(run('run', taskId)).rejects.toThrow(/approve a plan first/)
    expect((await kernel.eventsFor(taskId)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
  })

  it('approving a split child watches the tree; approving a root still only approves', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = (...args: string[]) => buildProgram(kernel, async () => forbiddenPort()).parseAsync(args, { from: 'user' })

    await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    lines.length = 0
    await run('approve', taskId)
    // a root's approval is not a decision to run it — nothing is asked for, nothing is watched
    expect((await kernel.eventsFor(taskId)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
    expect(lines.join('\n')).not.toContain('watching the run')

    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})))
    lines.length = 0
    // the run that is waiting is the ROOT — its join cannot resolve until the child runs, so the
    // approval watches the root rather than asking for a second run of it
    const watched = run('approve', child.childTaskId)
    await until(() => lines.some(l => l.includes('watching the run at')))
    await stamp(log, child.childTaskId, TASK_STATUS.approved, TASK_STATUS.done)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await watched
    expect(lines.join('\n')).toContain(`watching the run at ${taskId}`)
    expect((await kernel.eventsFor(taskId)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
  }, 15_000)

  it('status names the child awaiting plan approval, with the command that unblocks it', async () => {
    const { run, lines, kernel } = await makeCli()
    await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})))

    lines.length = 0
    await run('status', taskId)
    expect(lines.join('\n')).toContain(`orc approve ${child.childTaskId}`)
  })

  it('a watched run waits for EVERY outstanding child, not only the first', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = (...args: string[]) => buildProgram(kernel, async () => forbiddenPort()).parseAsync(args, { from: 'user' })

    await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)
    const auto = ApprovalPolicy.parse({ default: 'auto' })
    const first = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'A', auto))
    const second = await kernel.proposeSplit(splitArgs(taskId, 'call_2', 'B', auto))

    lines.length = 0
    let settled = false
    const watched = run('run', taskId).then(() => { settled = true })
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await stamp(log, first.childTaskId, TASK_STATUS.approved, TASK_STATUS.done)

    // one finished sibling is not a finished tree — this used to leave the second child to nobody
    await Bun.sleep(300)
    expect(settled).toBe(false)

    await stamp(log, second.childTaskId, TASK_STATUS.approved, TASK_STATUS.done)
    await watched
    expect(lines.join('\n')).toContain(`run finished: ${RUN_OUTCOME.done}`)
  }, 15_000)

  it('the terminal summary after a watched run includes a cost line, not just run finished', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = (...args: string[]) => buildProgram(kernel, async () => forbiddenPort()).parseAsync(args, { from: 'user' })

    await run('new', 'cost summary', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    await run('propose', taskId)
    await run('approve', taskId)

    const runToken = `step:${taskId}:s1:a1`
    await log.append({
      taskId, stepId: 's1', runToken, kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 40, outputTokens: 10, costUSD: 0.0055, estimated: false },
    })

    lines.length = 0
    const watched = run('run', taskId)
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await watched

    const out = lines.join('\n')
    expect(out).toContain(`run finished: ${RUN_OUTCOME.done}`)
    // not just 'tokens in/out' — the terminal summary must show where the money went
    expect(out).toContain('cost: $0.0055')
  }, 15_000)

  // The supervisor's half of a run, faked: nothing in this file holds a real runtime, so the
  // status transitions a run would produce are stamped straight onto the log.
  const stamp = (log: EventLog, taskId: string, from: TaskStatus, to: TaskStatus) =>
    log.append({ taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from, to } })

  // The port a client must never reach for. Under the supervisor model the CLI records the ask and
  // watches; anything that starts a workflow from here is the defect this phase removes, so make
  // it loud rather than letting a silent stub hide it.
  const forbiddenPort = (): ExecutionPort => ({
    startRun: async () => { throw new Error('the CLI must not start runs') },
    retry: async () => { throw new Error('the CLI must not start runs') },
    cancelRun: async () => { throw new Error('the CLI must not cancel workflows') },
  })

  const until = async (ready: () => boolean) => { for (let i = 0; i < 300 && !ready(); i++) await Bun.sleep(20) }
  const watching = (lines: string[]) => until(() => lines.some(l => l.includes('run requested for')))

  it('a watched run resolves when the whole subtree is terminal, not when the root is', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    spyOn(console, 'log').mockImplementation(() => {})

    const parent = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'parent', spec: '' })
    await kernel.proposePlan(parent.id, singleStepDraft({ title: 'p', spec: 'p' }, 'fake/m'))
    await kernel.approvePlan(parent.id)
    // the auto-policy child a split creates: approved, so somebody is still expected to run it
    const child = await kernel.proposeSplit(splitArgs(parent.id, 'call_1', 'child', ApprovalPolicy.parse({ default: 'auto' })))

    let settled = false
    const watching = watchSubtree(kernel, parent.id).then(r => { settled = true; return r })
    await stamp(log, parent.id, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, parent.id, TASK_STATUS.running, TASK_STATUS.done)

    // a terminal root is NOT a finished tree — the child still has nobody's answer
    await Bun.sleep(300)
    expect(settled).toBe(false)

    await stamp(log, child.childTaskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, child.childTaskId, TASK_STATUS.running, TASK_STATUS.done)
    expect(await watching).toEqual({ parked: false, outcome: RUN_OUTCOME.done })
  }, 15_000)

  it('a watched run resolves parked when a gate is open anywhere in the subtree', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    cleanup.push(() => log.close())
    spyOn(console, 'log').mockImplementation(() => {})

    const parent = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'parent', spec: '' })
    await kernel.proposePlan(parent.id, singleStepDraft({ title: 'p', spec: 'p' }, 'fake/m'))
    await kernel.approvePlan(parent.id)
    const child = await kernel.proposeSplit(splitArgs(parent.id, 'call_1', 'child', ApprovalPolicy.parse({ default: 'auto' })))
    // the parent sits in join_splits while the child asks: the parent's own stream stays silent, so
    // a watch that read only the watched task would wait forever on a question already asked
    await log.append({
      taskId: child.childTaskId, stepId: 'w1', runToken: `step:${child.childTaskId}:w1:a1`,
      kind: EVENT_KIND.feedback_requested, payload: { question: 'may I overwrite it?', topic: 'confirm' },
    })

    expect(await watchSubtree(kernel, parent.id))
      .toEqual({ parked: true, taskId: child.childTaskId, question: 'may I overwrite it?' })
  }, 15_000)

  it('memory add/rebuild/ls/search/cat/rm round-trip against an isolated throwaway SurrealDB db', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-cli-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { host, hub } = await buildPlugins(config) // real plugin wiring — no stub casts
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const plugin = { host, hub, config, log }
    const run = (...args: string[]) => overrideExits(buildProgram(kernel, undefined, plugin)).parseAsync(args, { from: 'user' })

    const id = `cli-test-${Math.random().toString(36).slice(2, 10)}`
    await run('memory', 'add', '--id', id, '--title', 'T', '--summary', 'S', '--body', 'B', '--tags', 'x')

    // Primary isolated assertion: this test's own (per-test Postgres) log recorded the append —
    // true independent of SurrealDB, which every other assertion below depends on.
    const written = (await log.all()).find(e => e.kind === EVENT_KIND.memory_written)
    expect(written).toBeDefined()
    expect(notePayloadId(written!.payload)).toBe(id)

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
    // Unflagged notes still take the schema default — unchanged behaviour, pinned so --kind cannot
    // accidentally become required.
    expect(note.kind).toBe('fact')

    // --kind is what makes a human-authored DECISION possible at all. Without it every note either
    // human door produced landed as 'fact', so only an agent mid-step could mint a decision, and a
    // human who disagreed with a recorded one had no way to correct it.
    // Asserted off the LOG, not via `memory cat` — cat records an access, and the access-count
    // assertions further down this test count exactly one.
    const decisionId = `${id}-decision`
    await run('memory', 'add', '--id', decisionId, '--title', 'A real decision', '--kind', 'decision')
    const decisionWrite = (await log.all())
      .filter(e => e.kind === EVENT_KIND.memory_written)
      .find(e => notePayloadId(e.payload) === decisionId)
    expect(decisionWrite).toBeDefined()
    expect(notePayloadKind(decisionWrite!.payload)).toBe('decision')
    // removed immediately: the end of this test asserts `ls` reads '_no notes_', so a note left
    // behind here would fail an assertion that has nothing to do with kinds
    await run('memory', 'rm', decisionId)

    // An unknown kind is a friendly parse-time error naming the valid set, never a silent default
    // to 'fact' — the discipline --tier and `neighbors --kinds` already apply. 'adr' is the exact
    // near-miss this catches: it is a tag, never a kind.
    await expect(run('memory', 'add', '--id', 'k1', '--title', 'K', '--kind', 'adr')).rejects.toThrow(/unknown kind/)

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
        payload: { note: { id: nid, title: nid, links }, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } },
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
    // an explicit budget like every other slow test here: this one drives a real plugin host, a
    // real Surreal db and ~20 CLI invocations, and bun's 5s default puts it one contended
    // SurrealDB away from a timeout that reads as an assertion failure
  }, 60_000)

  // Every one-shot memory command routes through withMemory, so this finally IS the guarantee
  // that a body that throws (a Surreal query mid-flight, a missing note, a failed distill) does
  // not leak the connection for the life of the process — seven commands used to close only
  // after a successful body.
  it('withMemory closes the Surreal connection even when the body throws', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-withmem-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    // keyword-only, same reason as the claims tests: nothing here needs an embedder
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    cleanup.push(() => log.close())

    let leaked: Parameters<Parameters<typeof withMemory>[1]>[0] | undefined
    await expect(withMemory({ log, config }, async memory => {
      leaked = memory
      await memory.store.list() // the connection works while the body runs
      throw new Error('body boom')
    })).rejects.toThrow('body boom')
    // close ran: the same read now fails because the connection is gone. Without the finally,
    // this list() succeeds — the leaked handle stays live, which is exactly the defect.
    expect(leaked).toBeDefined()
    await expect(leaked!.store.list()).rejects.toThrow()
  }, 15_000)

  // The other half of that bracket: the close must not be able to FAIL the command. Every door
  // through here has ALREADY committed its event by the time the finally runs — `orc memory add`,
  // `orc adr new`, the actions layer — so a close that throws (a dropped socket, a projector still
  // draining) would exit non-zero for a write that is in the log, and the operator's retry would
  // then meet a refusal for the very note they were told had failed.
  it('withMemory warns about a failing close instead of failing the command', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-closefail-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    cleanup.push(() => log.close())
    const warnings: string[] = []
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.join(' ')) })

    const answer = await withMemory({ log, config }, async memory => {
      // A healthy Surreal cannot be made to fail its close (measured: a second close resolves), so
      // the failure is injected on the handle withMemory holds — after delegating to the REAL close,
      // which keeps this test from leaking the connection it just opened.
      const real = memory.close
      memory.close = async () => { await real(); throw new Error('socket gone') }
      return 'the body answered'
    })
    expect(answer).toBe('the body answered') // the body's value is returned, not lost to the close
    expect(warnings.join('\n')).toContain('socket gone')
  }, 15_000)

  it('memory claims drains before it reads, and --history recovers a retired claim', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-claims-cli-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    // Keyword-only ON PURPOSE: `topics` is derived from claim EMBEDDINGS, so leaving the default
    // ollama embedder wired would make the empty-inventory assertion below depend on whether a
    // local Ollama happens to be running. The claims command itself never touches an embedder.
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const run = (...args: string[]) =>
      overrideExits(buildProgram(kernel, undefined, { host, hub, config, log })).parseAsync(args, { from: 'user' })

    // `memory add` has no claim flag, so state them the way the store's own payload does: the note
    // carries the LIVE set and the EVENT carries the tombstone. Two writes, so the second retires
    // what the first stated — the only shape from which --history has something to recover.
    const noteId = 'claims-cli-note'
    const liveText = 'the projector drains before every read'
    const retiredText = 'the read model is the source of truth'
    const write = (texts: string[], invalidates: string[] = []) => log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: {
        note: { id: noteId, title: 'claims', claims: texts.map(t => ({ id: claimId(t), text: t })) },
        author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID }, invalidates,
      },
    })
    await write([retiredText])
    await write([liveText], [claimId(retiredText)])

    // REGRESSION: nothing has drained the projector yet, so the claim rows do not exist. The
    // command only finds them if it catches up itself, the way every sibling read command does —
    // and its empty case is a THROW, so the missing drain reads as "this note has no claims".
    lines.length = 0
    await run('memory', 'claims', noteId)
    expect(lines.join('\n')).toContain(liveText)
    expect(lines.join('\n')).not.toContain(retiredText) // retired: gone from the read model

    // --history folds the LOG instead, which is the only surface a retired claim survives on
    lines.length = 0
    await run('memory', 'claims', noteId, '--history')
    expect(lines.join('\n')).toContain(liveText)
    expect(lines.join('\n')).toContain(retiredText)
    expect(lines.find(l => l.includes(retiredText))).toContain('RETIRED')

    // Deleting the note ends its claims' stretches too — the projector drops their rows with it, so
    // a fold that saw only memory_written would keep reporting the live one as live forever.
    await log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted,
      payload: { id: noteId, scope: 'project', author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } },
    })
    lines.length = 0
    await run('memory', 'claims', noteId, '--history')
    expect(lines.find(l => l.includes(liveText))).toContain('RETIRED')

    await expect(run('memory', 'claims', 'no-such-note-at-all')).rejects.toThrow(/no claims on/)

    // No embedder → no claim vectors → no partition. The empty message must name the cause an
    // operator upgrading onto claims actually hits (a corpus whose claims were all legacy-derived),
    // not only the two it used to name.
    await expect(run('memory', 'topics')).rejects.toThrow(/legacy rules\[\] decoder/)
    // an unknown key is the store's own error, surfaced by the CLI rather than swallowed
    await expect(run('memory', 'topics', 'deadbeef1234')).rejects.toThrow(/no topic/)

    // `memory add --claim/--invalidate`: claims used to be authorable ONLY by an agent through
    // memory_write, so correcting one stale statement by hand meant running an agent. The flags
    // must be ADDITIVE like the tool they mirror — a later write states what to add and what to
    // retire, and must not disturb the claims it did not name.
    lines.length = 0
    const cliNote = 'cli-authored-claims'
    await run('memory', 'add', '--id', cliNote, '--title', 'CLI claims', '--claim', 'first from the cli', '--claim', 'second from the cli')
    await run('memory', 'claims', cliNote)
    const first = lines.find(l => l.includes('first from the cli'))
    const secondId = lines.find(l => l.includes('second from the cli'))?.split(/\s+/)[0]
    expect(first).toBeDefined()
    expect(secondId).toMatch(/^[a-f0-9]{12}$/)

    lines.length = 0
    await run('memory', 'add', '--id', cliNote, '--title', 'CLI claims', '--claim', 'third from the cli', '--invalidate', secondId ?? '')
    await run('memory', 'claims', cliNote)
    const live = lines.join('\n')
    expect(live).toContain('third from the cli')
    expect(live).toContain('first from the cli')   // untouched by a write that never named it
    expect(live).not.toContain('second from the cli') // retired by --invalidate
    // and the retired one is still recoverable from the log, which is the only place it survives
    lines.length = 0
    await run('memory', 'claims', cliNote, '--history')
    expect(lines.find(l => l.includes('second from the cli'))).toContain('RETIRED')
  }, 30_000)

  it('memory claims --json emits the raw claim array for both the live and the --history form', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-claims-json-cli-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    // Keyword-only, same reason as the sibling claims test: nothing here needs an embedder, and
    // leaving the default ollama one wired makes the test depend on whether a local Ollama runs.
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const run = (...args: string[]) =>
      overrideExits(buildProgram(kernel, undefined, { host, hub, config, log })).parseAsync(args, { from: 'user' })

    // Two writes, so the second retires what the first stated — the only shape in which the live
    // form and the --history form return DIFFERENT arrays, which is what makes this test able to
    // tell the two --json branches apart.
    const noteId = 'claims-json-cli-note'
    const liveText = 'json output is the raw domain value'
    const retiredText = 'json output was wrapped in an envelope'
    const write = (texts: string[], invalidates: string[] = []) => log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: {
        note: { id: noteId, title: 'claims json', claims: texts.map(t => ({ id: claimId(t), text: t })) },
        author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID }, invalidates,
      },
    })
    await write([retiredText])
    await write([liveText], [claimId(retiredText)])

    // (a) live form: stdout is exactly one parseable JSON value — the raw Claim[], no envelope.
    lines.length = 0
    await run('memory', 'claims', noteId, '--json')
    const live = JSON.parse(lines.join('\n'))
    expect(Array.isArray(live)).toBe(true)
    expect(live.map((c: { text: string }) => c.text)).toEqual([liveText]) // retired one is not live
    expect(live[0].id).toBe(claimId(liveText))
    expect(typeof live[0].validFrom).toBe('string')

    // (b) --history --json folds the LOG: the retired claim survives, carrying its tombstone.
    lines.length = 0
    await run('memory', 'claims', noteId, '--history', '--json')
    const history = JSON.parse(lines.join('\n'))
    expect(history.map((c: { text: string }) => c.text).sort()).toEqual([liveText, retiredText].sort())
    const retired = history.find((c: { text: string }) => c.text === retiredText)
    expect(typeof retired.invalidatedAt).toBe('string') // RETIRED in the human form
    expect(history.find((c: { text: string }) => c.text === liveText).invalidatedAt).toBeNull()

    // (c) the human forms are UNCHANGED: tab-free `id  validFrom  text` rows, not JSON.
    lines.length = 0
    await run('memory', 'claims', noteId)
    expect(lines.join('\n')).toContain(liveText)
    expect(lines.join('\n').trim().startsWith('[')).toBe(false)
    lines.length = 0
    await run('memory', 'claims', noteId, '--history')
    expect(lines.find(l => l.includes(retiredText))).toContain('RETIRED')
    expect(lines.join('\n').trim().startsWith('[')).toBe(false)

    // (d) absence is DATA under --json (the settled `topics --json` rule): [] and exit 0, so a
    // script reads an empty array instead of parsing a thrown diagnostic. The no-flag form keeps
    // the throw that names the note and the command a person can act on.
    lines.length = 0
    await run('memory', 'claims', 'no-such-note-at-all', '--json')
    expect(JSON.parse(lines.join('\n'))).toEqual([])
    lines.length = 0
    await run('memory', 'claims', 'no-such-note-at-all', '--history', '--json')
    expect(JSON.parse(lines.join('\n'))).toEqual([])
    await expect(run('memory', 'claims', 'no-such-note-at-all')).rejects.toThrow(/no claims on/)
    await expect(run('memory', 'claims', 'no-such-note-at-all', '--history')).rejects.toThrow(/no claims in the log/)
  }, 30_000)

  it('memory topics --json emits raw JSON, keeps the human throws, and rejects an unknown key', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-topics-cli-'))
    const projectDbName = `t_${Math.random().toString(36).slice(2, 10)}`
    // Keyword-only ON PURPOSE (same reason as the claims test): `topics` is derived from claim
    // EMBEDDINGS, so leaving the default ollama embedder wired would make the empty-inventory
    // assertions depend on whether a local Ollama happens to be running. With no embedder there
    // are no claim vectors and thus no topics — the deterministic empty inventory this test needs.
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const run = (...args: string[]) =>
      overrideExits(buildProgram(kernel, undefined, { host, hub, config, log })).parseAsync(args, { from: 'user' })

    // (a) --json on the EMPTY inventory is [] and exit 0, not a throw. A script wants absence as
    // data; stdout must be exactly one parseable JSON value.
    lines.length = 0
    await run('memory', 'topics', '--json')
    expect(JSON.parse(lines.join('\n'))).toEqual([])

    // (c) the human (no --json) form is UNCHANGED: the empty listing still throws the three-cause
    // diagnostic, naming the legacy rules[] decoder cause an upgrading operator hits.
    await expect(run('memory', 'topics')).rejects.toThrow(/legacy rules\[\] decoder/)

    // (b) an unknown key still throws WITH --json — the store's own 'no topic' error, surfaced by
    // the CLI rather than swallowed into an empty JSON document.
    await expect(run('memory', 'topics', 'deadbeef1234', '--json')).rejects.toThrow(/no topic/)
    // and without --json too, matching the sibling claims test
    await expect(run('memory', 'topics', 'deadbeef1234')).rejects.toThrow(/no topic/)

    // The per-topic --json path (a real key) would go through store.topicClaims and append exactly
    // one memory_topic_accessed event. That assertion is UNREACHABLE from a CLI-level test: a
    // non-empty topic inventory needs claim embeddings, and openMemory builds the embedder from
    // config.memoryEmbedModel via buildEmbeddingProvider (ollama only) with no injection seam — so
    // a real topicKey cannot be produced here without a live Ollama. That per-topic access-event
    // assertion lives in plugins/memory, which constructs SurrealMemory directly. Asserted here:
    // no topic access event is appended by any of the paths above (empty listing / unknown key).
    const topicAccesses = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_topic_accessed)
    expect(topicAccesses).toHaveLength(0)
  }, 30_000)
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
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, realpathSync(config.dir))
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { host, hub } = await buildPlugins(config)
    // this describe never shut its host down at all — same leak, unconditional
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const stubPort: ExecutionPort = {
      startRun: async () => { throw new Error('unused') },
      retry: async () => { throw new Error('unused') },
      cancelRun: async () => {},
    }
    const run = (...args: string[]) =>
      buildProgram(kernel, async () => stubPort, { host, hub, config, log }).parseAsync(args, { from: 'user' })

    await run('new', 'sweep wiring', '--workspace', TEST_WORKSPACE_ID)
    const taskId = lines[0]!
    const write = (id: string, author: Record<string, unknown>) => log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id, title: id }, author },
    })
    await write('wiring-orphan', { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId })
    await write('wiring-adopted', { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId })
    await write('wiring-adopted', { source: 'cli', workspaceId: TEST_WORKSPACE_ID }) // re-written by a live writer -> adopted

    lines.length = 0
    await run('cancel', taskId)
    const out = lines.join('\n')
    expect(out).toContain('cancelled')
    expect(out).toContain('swept wiring-orphan')
    expect(out).not.toContain('swept wiring-adopted')
    const deleted = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_deleted)
    expect(deleted.map(e => e.payload.id)).toEqual(['wiring-orphan'])
    expect(deletedAuthorTaskId(deleted[0]!.payload)).toBe(taskId)

    // failure path: a sweep failure warns; the cancel itself still exits clean
    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const afterSpy = spyOn(log, 'after').mockImplementation(async () => { throw new Error('surreal down') })
    lines.length = 0
    await run('cancel', taskId) // must not reject
    expect(lines.join('\n')).toContain('cancelled')
    expect(warns.join('\n')).toContain('sweep skipped: surreal down')
    afterSpy.mockRestore(); warnSpy.mockRestore()
  })
})

describe('destructive commands name their target', () => {
  // Both commands act on whatever project the cwd's config resolves to. A script that drifted into
  // the wrong directory once destroyed a live project's history, so the name is a required argument
  // and a mismatch must refuse rather than delete.
  it('purge and delete refuse when the named project is not this one', async () => {
    const { run } = await makeCli()
    for (const cmd of ['purge', 'delete']) {
      // no plugin context wired here: the guard must still refuse, never fall through to the wipe
      await expect(run(cmd, 'some-other-project', '--yes')).rejects.toThrow()
    }
  })

  it('both require --yes, so neither can fire from a bare invocation', async () => {
    const { run } = await makeCli()
    await expect(run('purge', 'orc-sim')).rejects.toThrow()
    await expect(run('delete', 'orc-sim')).rejects.toThrow()
  })
})
