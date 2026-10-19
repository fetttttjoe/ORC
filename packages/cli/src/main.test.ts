import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalPolicy, CHECKS_STEP_ID, Confidence, Door, EVENT_KIND, NO_CHAT, OperationKind, ROLE_SKILL, RunOutcome, TASK_STATUS, TaskType, WORKSPACE_KIND, type ExecutionPort, type OperationSpec, type TaskNode, type TaskStatus } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { loadConfig, requireProject, type EventLog } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, testConfig, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID, testOrcConfig } from '@orc/kernel/test-helpers'
import { singleStepDraft } from './plan-template'
import { buildProgram, openKernel, runInit } from './main'
import { buildOrcActions } from './actions'
import { CommandFailure } from './exit'
import { cli } from './test-helpers'
import { watchSubtree } from './watch'
import { archivedRefusal } from './workspace-ops'

const dbs: Array<{ drop: () => Promise<void> }> = []
// Process-scoped resources (a real plugin host, an MCP hub, an event-log pool) registered the
// moment they are created and drained LIFO. A bare `await host.shutdown()` as the last statement
// of an it() is SKIPPED when an assertion above it throws, which leaks the host into every later
// test file in the process — that is what turned one failed assertion on this branch into a
// 22-failure mystery, and it is why the db.drop() below got skipped too.
const cleanup: Array<() => Promise<void> | void> = []
// Teardown drops one Postgres DB per makeCli/openKernel (14+ here).
// Each pg drop runs its handle's registered closers first (createTestDb.onClose) and then DROPs on
// its own admin connection; serial drops blew bun's default 5s hook budget under a contended pg
// (same fix as kernel.test.ts) — the dbs are distinct, so drop them concurrently.
afterAll(async () => {
  for (const c of cleanup.reverse()) await c()
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

// these tests drive the CLI door; SUPERVISOR is the half they fake (what a RUN appends)
const CLI = NO_CHAT(Door.cli)
const SUPERVISOR = NO_CHAT(Door.supervisor)

async function makeCli() {
  const db = await createTestDb()
  dbs.push(db)
  const { kernel, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
  db.onClose(() => storage.close())
  // buildProgram(kernel) has no project context, so `new` cannot resolve a cwd workspace here —
  // the tests below pass --workspace explicitly, and this is the record they name.
  await seedTestWorkspace(storage.events, CLI)
  const { run, lines } = cli(kernel)
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

  it('with the database unreachable, every project-context guard throws the unreachable error itself', async () => {
    const error = new Error('connection refused')
    for (const args of [['purge', 'demo', '--yes'], ['projects'], ['delete', 'demo', '--yes'], ['brief'], ['adr', 'ls'], ['ws', 'ls'], ['tasks']]) {
      const program = buildProgram(null, undefined, undefined, { config: testConfig('postgresql://unused'), error })
      await expect(program.parseAsync(['node', 'orc', ...args])).rejects.toBe(error)
    }
  })

  it('buildProgram exposes pre-bootstrap init and db commands', async () => {
    const { kernel } = await makeCli()
    expect(buildProgram(kernel).commands.map(c => c.name())).toEqual(expect.arrayContaining(['init', 'db']))
  })

  it('replay reconstructs operation state at a sequence and appends nothing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run } = cli(kernel)

    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'audit me' }, CLI)
    // an operation belongs to the RUN that opened it, so its origin is that run's chat
    const opContext = { taskId: t.id, stepId: 's1', runToken: `step:${t.id}:s1:a1`, origin: { chatId: `run:${t.id}:v1`, door: Door.supervisor } }
    const spec: OperationSpec = { operationId: `${opContext.runToken}:model:1`, kind: OperationKind.model, name: 'fake/m', before: { q: 1 } }
    await storage.operations.beginOperation(opContext, spec)
    const startSeq = must((await log.byTask(t.id)).at(-1), 'last event').seq
    await storage.operations.completeOperation(opContext, spec, 1, { text: 'answer' })
    const countBefore = (await log.all()).length

    const atStart = await run('replay', t.id, '--at', String(startSeq))
    expect(JSON.parse(atStart.join('\n')).operations[spec.operationId].status).toBe('started')

    const atEnd = await run('replay', t.id)
    expect(JSON.parse(atEnd.join('\n')).operations[spec.operationId].status).toBe('completed')

    await expect(run('replay', t.id, '--at', 'x')).rejects.toThrow(/non-negative integer/)
    await expect(run('replay', t.id, '--at', '-1')).rejects.toThrow(/non-negative integer/)
    expect((await log.all()).length).toBe(countBefore) // replay never mutates history
  })

  it('replay --at below the task range explains that sequences are global', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'audit me', spec: '' }, CLI)
    const events = await kernel.eventsFor(t.id)
    const first = must(events[0], 'first event').seq
    const errors: string[] = []
    spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')) })
    const { run } = cli(kernel)
    // The command reports the problem and FAILS — as a thrown outcome, not by writing
    // process.exitCode. Running this test can no longer change the exit status of the test process,
    // which is what used to make a 0-failure suite exit 1 in CI depending on file order.
    await expect(run('replay', t.id, '--at', String(first - 1))).rejects.toBeInstanceOf(CommandFailure)
    expect(errors.join('\n')).toContain('sequences are GLOBAL')
    const lastEventSeq = must(events.at(-1), 'last event').seq
    expect(errors.join('\n')).toContain(`${first}..${lastEventSeq}`)
    expect(process.exitCode ?? 0).toBe(0) // the global stays untouched — that is the point
  })

  it('log --json prints the full stored envelope', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run } = cli(kernel)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'json log' }, CLI)
    const records = JSON.parse((await run('log', t.id, '--json')).join('\n'))
    expect(records[0]).toMatchObject({ kind: EVENT_KIND.task_created, projectId: TEST_PROJECT_ID, idempotencyKey: null })
    expect(records[0].seq).toBeGreaterThan(0)
  })

  it('log and replay reject unknown task ids', async () => {
    const { run } = await makeCli()
    await expect(run('log', 'missing-task')).rejects.toThrow("no task 'missing-task'")
    await expect(run('replay', 'missing-task')).rejects.toThrow("no task 'missing-task'")
  })

  // Proof of the hermetic isolation openKernel's required config buys: THIS repo's own
  // .orc/config.json sets finishChecks (['bun run typecheck']), and a kernel that fell back to
  // loadConfig() would silently inherit it — the same assertion fails on that code (config
  // omitted → cwd fallback), because a checks step then IS appended.
  it('propose leaves off the checks step for a kernel opened with testOrcConfig()', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel)
    await run('new', 'no checks step', '--workspace', TEST_WORKSPACE_ID)
    const taskId = must(lines[0], 'task id from new command')
    await run('propose', taskId)
    const plan = must(await kernel.getPlan(taskId), 'plan')
    expect(plan.steps.some(s => s.id === CHECKS_STEP_ID)).toBe(false)
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

    const kinds = (await run('log', taskId)).map(l => l.split(/\s+/).at(-1))
    expect(kinds).toEqual([
      EVENT_KIND.task_created, EVENT_KIND.plan_proposed, EVENT_KIND.task_status_changed,
      EVENT_KIND.plan_approved, EVENT_KIND.task_status_changed,
    ])
  })

  it('new --workspace binds the task to the named workspace', async () => {
    const { run, kernel } = await makeCli()
    const w = await kernel.createWorkspace({ title: 'W', cwd: '/w', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
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
    const w = await kernel.createWorkspace({ title: 'Done', cwd: '/done', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
    await kernel.setWorkspaceArchived(w.id, true, CLI)
    await expect(run('new', 'T', '--workspace', w.id)).rejects.toThrow(archivedRefusal(w.id))
    expect((await kernel.listTasks()).some(t => t.workspaceId === w.id)).toBe(false)
    // restored, the same command works — the refusal is about standing, not about the id
    await kernel.setWorkspaceArchived(w.id, false, CLI)
    const [id] = await run('new', 'T', '--workspace', w.id)
    expect((await kernel.getTask(id ?? ''))?.workspaceId).toBe(w.id)
  })

  // A child of a task in workspace B belongs to B, wherever the operator happened to type the
  // command. Binding it to the cwd instead would let ONE subtree straddle two working directories —
  // the thing proposeSplit's inheritance exists to prevent.
  it('new --parent inherits the parent\'s workspace instead of the directory the command was typed in', async () => {
    const { run, kernel } = await makeCli()
    const other = await kernel.createWorkspace({ title: 'Other', cwd: '/other', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
    const parentId = must((await run('new', 'P', '--workspace', other.id))[0], 'parent task id')
    const childId = must((await run('new', 'C', '--parent', parentId))[0], 'child task id')
    expect((await kernel.getTask(childId))?.workspaceId).toBe(other.id)
    // …and an explicit --workspace still overrides the parent, for a deliberate re-home
    const childId2 = must((await run('new', 'C2', '--parent', parentId, '--workspace', TEST_WORKSPACE_ID))[0], 'child task id')
    expect((await kernel.getTask(childId2))?.workspaceId).toBe(TEST_WORKSPACE_ID)
  })

  it('new rejects an unrecognized --strategy value instead of silently falling through', async () => {
    const { run } = await makeCli()
    await expect(run('new', 'x', '--strategy', 'grounded', '--workspace', TEST_WORKSPACE_ID)).rejects.toThrow(/unknown --strategy 'grounded'/)
  })

  it('propose --skill places the named skills in the template step', async () => {
    const { run } = await makeCli()
    const taskId = must((await run('new', 'documented task', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId, '--model', 'ollama/llama3', '--skill', 'documentation')
    const plan = JSON.parse((await run('plan', taskId, '--json')).join('\n'))
    expect(plan.steps[0].skillRefs).toEqual(['documentation'])
  })

  it('plan prints the plan as JSON', async () => {
    const { run } = await makeCli()
    const taskId = must((await run('new', 'x', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId, '--model', 'ollama/llama3')
    const plan = JSON.parse((await run('plan', taskId, '--json')).join('\n'))
    expect(plan.steps[0].modelRef).toBe('ollama/llama3')
    expect(plan.strategyRef).toBe('template:single')

    // default render is the human review, not JSON
    expect((await run('plan', taskId)).join('\n')).toContain('cost estimate:')
  })

  it('plan and approve reject non-integer versions during argument parsing', async () => {
    const { run } = await makeCli()
    await expect(run('plan', 'missing', '--version', 'nope')).rejects.toThrow(/integer/)
    await expect(run('approve', 'missing', '--version', '1.5')).rejects.toThrow(/integer/)
    await expect(run('replay', 'missing', '--at', '1e2')).rejects.toThrow(/integer/)
    // graph --port used a bare parseInt, so '--port 0' bound port 0 and '--port nope' fed NaN to
    // the server; both must die at parse time like every other numeric option in this file
    await expect(run('graph', '--port', '0')).rejects.toThrow(/positive integer/)
    await expect(run('graph', '--port', 'nope')).rejects.toThrow(/integer/)
  })

  it('tasks makes an empty project explicit', async () => {
    const { run } = await makeCli()
    expect(await run('tasks')).toEqual(['_no tasks_'])
  })

  it('tasks lists id, status and title, indented under its workspace heading', async () => {
    const { run } = await makeCli()
    await run('new', 'listed task', '--workspace', TEST_WORKSPACE_ID)
    const out = await run('tasks')
    expect(out[0]).toContain(TEST_WORKSPACE.title) // the group heading comes first
    expect(out[1]).toContain('draft')
    expect(out[1]).toContain('listed task')
  })

  // groups.map(...) alone would drop a workspace with zero tasks — this pins that a bare heading
  // still prints, since "nothing is running here" is itself information an operator needs.
  it('tasks prints tasks grouped under their workspace, and an empty workspace still gets a heading', async () => {
    const { run, kernel } = await makeCli()
    const empty = await kernel.createWorkspace({ title: 'Empty', cwd: '/empty', branch: 'e', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
    const w = await kernel.createWorkspace({ title: 'Feature X', cwd: '/w', branch: 'b', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: false, onTrunk: false }, CLI)
    await kernel.createTask({ title: 'inside', workspaceId: w.id }, CLI)
    const out = (await run('tasks')).join('\n')
    expect(out.indexOf('Feature X')).toBeLessThan(out.indexOf('inside'))
    expect(out).toContain(`# ${empty.title}  (${empty.branch})  ${empty.cwd}`)
  })

  // A task naming a workspace the fold never saw is a log defect (the grouping is only as
  // trustworthy as its handling of the case it cannot group) — it must surface loudly, not vanish
  // from a view keyed by workspace.
  it('tasks prints an orphaned task under a loud heading, never hidden', async () => {
    const { run, storage } = await makeCli()
    const orphan: TaskNode = {
      id: 'orphan-1', parentId: null, workspaceId: 'workspace-the-fold-never-saw', type: TaskType.generic,
      title: 'ghost task', spec: '', status: TASK_STATUS.draft, zone: [], budgetUSD: null,
      depth: 0, createdAt: '2026-09-14T00:00:00.000Z',
    }
    await storage.events.append({
      ...CLI, taskId: orphan.id, stepId: null, runToken: null,
      kind: EVENT_KIND.task_created, payload: { task: orphan },
    })
    const out = (await run('tasks')).join('\n')
    // an -1 (heading absent) would sort "before" any real index, so pin the heading's presence too
    expect(out).toContain('# ORPHANED — workspace missing from the log')
    expect(out.indexOf('# ORPHANED — workspace missing from the log')).toBeLessThan(out.indexOf('ghost task'))
  })

  it('propose --file loads a plan draft from disk', async () => {
    const { run } = await makeCli()
    const [taskId] = await run('new', 'file task', '--workspace', TEST_WORKSPACE_ID)

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
    const plan = JSON.parse((await run('plan', taskId, '--json')).join('\n'))
    expect(plan.steps[0].modelRef).toBe('file/model')
    expect(plan.steps[0].maxIterations).toBe(3)
  })

  it('propose --file rejects malformed JSON', async () => {
    const { run } = await makeCli()
    const taskId = must((await run('new', 'bad file task', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')

    const badPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-draft-')), 'bad.json')
    writeFileSync(badPath, '{not json')

    await expect(run('propose', taskId, '--file', badPath)).rejects.toThrow()
  })

  it('edit round-trip bumps the plan version and logs plan_edited', async () => {
    const { run } = await makeCli()
    const taskId = must((await run('new', 'edit task', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)

    const edited = await run('edit', taskId, '--model', 'ollama/other')
    expect(edited[0]).toContain('plan v2 edited')

    const plan = JSON.parse((await run('plan', taskId, '--json')).join('\n'))
    expect(plan.version).toBe(2)
    expect(plan.steps[0].modelRef).toBe('ollama/other')

    const kinds = (await run('log', taskId)).map(l => l.split(/\s+/).at(-1))
    expect(kinds).toContain(EVENT_KIND.plan_edited)
  })

  it('plan-note appends plan_annotated; reply resolves the open feedback topic and notifies its runToken', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const sent: Array<{ id: string; message: string; topic: string }> = []
    const { kernel, log } = await openKernel(db.url, {
      projectId: TEST_PROJECT_ID,
      config: testOrcConfig(),
      send: async (id, message, topic) => { sent.push({ id, message, topic }) },
    })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    // `reply` calls needPort() before replyFeedback (DBOS.send needs DBOS launched in-process), and
    // then ATTACHES to the run it just unblocked — answering without driving is what left runs
    // parked. The real send path is still the injected `send` above; startRun here only stands in
    // for the driver so the reply can complete.
    const stubPort: ExecutionPort = {
      startRun: async () => ({ workflowId: 'run:x:v1', wait: async () => RunOutcome.done }),
      retry: async () => { throw new Error('unused in this test') },
      cancelRun: async () => {},
    }
    const { run, lines } = cli(kernel, async () => stubPort)

    const taskId = must((await run('new', 'grounded task', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)

    // simulate a running plan step raising a feedback gate — normally appended by the DBOS
    // port's `feedback` branch; this test adds only the human-facing reply/annotate surface
    const runToken = `step:${taskId}:plan:a1`
    await log.append({ ...SUPERVISOR, taskId: taskId, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'db choice?', topic: 'auth-1' } })

    const noted = await run('plan-note', taskId, 'db', 'use bcrypt', '--ref', 'api')
    expect(noted[0]).toContain("noted on 'db'")
    expect((await log.byTask(taskId)).some(e => e.kind === EVENT_KIND.plan_annotated)).toBe(true)

    // A rejecting call never returns, so run()'s delta capture cannot report what it printed before
    // throwing — reading the shared buffer directly is the only way to see it. Nothing in this
    // harness holds a runtime, so the watch that follows reports the tree as it stands — stopped
    // short of done — and exits non-zero for it.
    const from = lines.length
    await expect(run('reply', taskId, 'approve')).rejects.toBeInstanceOf(CommandFailure)
    expect(lines.slice(from).join('\n')).toContain('auth-1')
    expect(sent).toEqual([{ id: runToken, message: 'approve', topic: 'feedback:auth-1' }])

    const again = await run('reply', taskId, 'again')
    expect(again[0]).toContain('no open feedback')
  })

  it('reply requires a live execution port (needPort gate, same as run/retry/cancel)', async () => {
    const { run } = await makeCli() // no portFactory
    await expect(run('reply', 'whatever', 'approve')).rejects.toThrow(/execution commands are unavailable/)
  })

  it('status surfaces the open feedback question so the human sees what to reply to', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run } = cli(kernel)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded' }, CLI)
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ ...SUPERVISOR, taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes or approve?', topic: 'plan-1' } })

    expect((await run('status', t.id)).join('\n')).toContain('changes or approve?')
  })

  it('status shows the analysis coverage once the analyze step has reported it', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run } = cli(kernel)
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded' }, CLI)
    await kernel.reportCoverage(
      { taskId: t.id, stepId: 'analyze', runToken: `step:${t.id}:analyze:a1` },
      { analyzed: true, scope: ['packages'], gaps: ['no tests read'], confidence: Confidence.medium, claimsWritten: 3 },
      SUPERVISOR,
    )
    const out = (await run('status', t.id)).join('\n')
    expect(out).toContain('analysis')
    expect(out).toContain('no tests read') // the gap surfaces so the human sees what was NOT covered
  })

  it('status prints a per-step usage/cost line for a step with recorded agent_call usage', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run } = cli(kernel)

    const taskId = must((await run('new', 'usage task', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId) // singleStepDraft's one step, id 's1'

    const runToken = `step:${taskId}:s1:a1`
    await log.append({
      ...SUPERVISOR, taskId: taskId, stepId: 's1', runToken, kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 111, outputTokens: 22, costUSD: 0.0123, estimated: false },
    })

    const status = await run('status', taskId)
    const stepLineIdx = status.findIndex(l => l.includes('s1') && l.includes('pending'))
    expect(stepLineIdx).toBeGreaterThanOrEqual(0)
    // the usage line lives directly under the step's own row — a per-step render, not a reuse of
    // the trailing task-total line further down
    expect(status[stepLineIdx + 1]).toContain('tokens in/out: 111/22')
    expect(status[stepLineIdx + 1]).toContain('cost: $0.0123')
  })

  it('plan-revise annotates each scoped note with the text, then resumes the open feedback', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const sent: Array<{ id: string; message: string; topic: string }> = []
    const { kernel, log } = await openKernel(db.url, {
      projectId: TEST_PROJECT_ID,
      config: testOrcConfig(),
      send: async (id, message, topic) => { sent.push({ id, message, topic }) },
    })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const stubPort: ExecutionPort = {
      startRun: async () => { throw new Error('unused in this test') },
      retry: async () => { throw new Error('unused in this test') },
      cancelRun: async () => {},
    }
    const { run } = cli(kernel, async () => stubPort)

    const taskId = must((await run('new', 'grounded task', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    const runToken = `step:${taskId}:plan:a1`
    await log.append({ ...SUPERVISOR, taskId: taskId, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes?', topic: 'auth-1' } })

    await run('plan-revise', taskId, 'use argon2', '--scope', 'db', 'api')
    const annotated = (await log.byTask(taskId)).filter(e => e.kind === EVENT_KIND.plan_annotated)
    expect(annotated.map(e => e.payload.targetNote).sort()).toEqual(['api', 'db'])
    expect(annotated.every(e => e.payload.text === 'use argon2')).toBe(true)
    // one send resumes the plan agent with the revise text — it reads the queued annotations on wake
    expect(sent).toEqual([{ id: runToken, message: 'use argon2', topic: 'feedback:auth-1' }])
  })

  it('cancel stamps a live task cancelled and prints that it did', async () => {
    const { run, kernel } = await makeCli()
    const taskId = must((await run('new', 'stop me', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    expect(await run('cancel', taskId)).toEqual(['cancelled'])
    expect((await kernel.getTask(taskId))?.status).toBe(TASK_STATUS.cancelled)
  })

  // A DBOS-cancelled workflow's getResult() rejects. Every stub port in this file has
  // `wait: async () => outcome`, so no test ever exercised the rejecting path — and `orc run`
  // only handled the resolve branch, printing a raw driver error and exit 1 for an advertised
  // action ("ctrl-c stops the run") while `orc status` correctly showed 'cancelled'.
  it('run reports a cancelled run as cancelled, not as a crash', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel, async () => forbiddenPort())

    const taskId = must((await run('new', 'cancel me', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    await run('approve', taskId)

    // cancelled is reported as the outcome it is, and the command exits non-zero for it — the
    // status `orc cancel` from another terminal leaves behind, read off the log rather than off a
    // rejected getResult(), because the watcher no longer holds the workflow handle
    const from = lines.length
    let failure: unknown = null
    const watched = run('run', taskId).catch((e: unknown) => { failure = e; return [] })
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.cancelled)
    await watched
    expect(failure).toBeInstanceOf(CommandFailure)
    expect(lines.slice(from).join('\n')).toContain(`run finished: ${RunOutcome.cancelled}`)
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
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel, async () => forbiddenPort())

    const taskId = must((await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    await run('approve', taskId)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})), SUPERVISOR)

    const watched = run('run', taskId)
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    const out = (await watched).join('\n')
    // a gated child is a stopping point, not a hang: the watch ends and names what unblocks it
    expect(out).toContain('gated child')
    expect(out).toContain(`orc approve ${child.childTaskId}`)
  }, 15_000)

  it('a split gated mid-run is named while the watch is still attached', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel, async () => forbiddenPort())

    const taskId = must((await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    await run('approve', taskId)

    const watched = run('run', taskId)
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})), SUPERVISOR)
    // split_proposed arrives over LISTEN/NOTIFY, so the advisory lands a tick or two later
    await until(() => lines.join('\n').includes('orc approve'))
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    const out = await watched

    expect(out.join('\n')).toContain(`orc approve ${child.childTaskId}`)
  }, 15_000)

  it('a question parked on a child parks the parent tail, naming the CHILD to reply to', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    // the parent is inside join_splits' recv while the child works: its own stream stays silent
    const port: ExecutionPort = {
      startRun: async () => ({ workflowId: 'wf-1', wait: () => new Promise<RunOutcome>(() => {}) }),
      retry: async () => { throw new Error('unused') },
      cancelRun: async () => {},
    }
    const { run } = cli(kernel, async () => port)

    const taskId = must((await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    await run('approve', taskId)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'child', ApprovalPolicy.parse({ default: 'auto' })), SUPERVISOR)
    await log.append({
      ...SUPERVISOR, taskId: child.childTaskId, stepId: 'w1', runToken: `step:${child.childTaskId}:w1:a1`,
      kind: EVENT_KIND.feedback_requested, payload: { question: 'may I overwrite it?', topic: 'confirm' },
    })

    const out = (await run('run', taskId)).join('\n')
    expect(out).toContain('may I overwrite it?')
    expect(out).toContain(`orc reply ${child.childTaskId} <text>`)
  }, 15_000)

  it('orc run records the ask and watches — it never starts a workflow itself', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel, async () => forbiddenPort())

    const taskId = must((await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    await run('approve', taskId)

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
    const requestEvent = must(requested[0], 'first run request event')
    expect(requestEvent.payload).toEqual({ taskId, cwd: TEST_WORKSPACE.cwd, retry: false })
  }, 15_000)

  it('orc run refuses an undrivable task before recording anything', async () => {
    const { run, kernel } = await makeCli()
    const taskId = must((await run('new', 'never approved', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await expect(run('run', taskId)).rejects.toThrow(/approve a plan first/)
    expect((await kernel.eventsFor(taskId)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
  })

  it('approving a split child watches the tree; approving a root still only approves', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel, async () => forbiddenPort())

    const taskId = must((await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    // a root's approval is not a decision to run it — nothing is asked for, nothing is watched
    const approved = (await run('approve', taskId)).join('\n')
    expect((await kernel.eventsFor(taskId)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
    expect(approved).not.toContain('watching the run')

    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})), SUPERVISOR)
    // the run that is waiting is the ROOT — its join cannot resolve until the child runs, so the
    // approval watches the root rather than asking for a second run of it
    const watched = run('approve', child.childTaskId)
    await until(() => lines.some(l => l.includes('watching the run at')))
    await stamp(log, child.childTaskId, TASK_STATUS.approved, TASK_STATUS.done)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    const out = (await watched).join('\n')
    expect(out).toContain(`watching the run at ${taskId}`)
    expect((await kernel.eventsFor(taskId)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
  }, 15_000)

  it('status names the child awaiting plan approval, with the command that unblocks it', async () => {
    const { run, kernel } = await makeCli()
    const taskId = must((await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    const child = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'gated child', ApprovalPolicy.parse({})), SUPERVISOR)

    expect((await run('status', taskId)).join('\n')).toContain(`orc approve ${child.childTaskId}`)
  })

  it('a watched run waits for EVERY outstanding child, not only the first', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel, async () => forbiddenPort())

    const taskId = must((await run('new', 'parent', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    await run('approve', taskId)
    const auto = ApprovalPolicy.parse({ default: 'auto' })
    const first = await kernel.proposeSplit(splitArgs(taskId, 'call_1', 'A', auto), SUPERVISOR)
    const second = await kernel.proposeSplit(splitArgs(taskId, 'call_2', 'B', auto), SUPERVISOR)

    let settled = false
    const watched = run('run', taskId).then(out => { settled = true; return out })
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await stamp(log, first.childTaskId, TASK_STATUS.approved, TASK_STATUS.done)

    // one finished sibling is not a finished tree — this used to leave the second child to nobody
    await Bun.sleep(300)
    expect(settled).toBe(false)

    await stamp(log, second.childTaskId, TASK_STATUS.approved, TASK_STATUS.done)
    const out = await watched
    expect(out.join('\n')).toContain(`run finished: ${RunOutcome.done}`)
  }, 15_000)

  it('the terminal summary after a watched run includes a cost line, not just run finished', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    const { run, lines } = cli(kernel, async () => forbiddenPort())

    const taskId = must((await run('new', 'cost summary', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    await run('propose', taskId)
    await run('approve', taskId)

    const runToken = `step:${taskId}:s1:a1`
    await log.append({
      ...SUPERVISOR, taskId: taskId, stepId: 's1', runToken, kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 40, outputTokens: 10, costUSD: 0.0055, estimated: false },
    })

    const watched = run('run', taskId)
    await watching(lines)
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)

    const out = (await watched).join('\n')
    expect(out).toContain(`run finished: ${RunOutcome.done}`)
    // not just 'tokens in/out' — the terminal summary must show where the money went
    expect(out).toContain('cost: $0.0055')
  }, 15_000)

  // The supervisor's half of a run, faked: nothing in this file holds a real runtime, so the
  // status transitions a run would produce are stamped straight onto the log.
  const stamp = (log: EventLog, taskId: string, from: TaskStatus, to: TaskStatus) =>
    log.append({ ...SUPERVISOR, taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from, to } })

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
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    spyOn(console, 'log').mockImplementation(() => {})

    const parent = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'parent', spec: '' }, CLI)
    await kernel.proposePlan(parent.id, singleStepDraft({ title: 'p', spec: 'p' }, 'fake/m'), CLI)
    await kernel.approvePlan(parent.id, undefined, undefined, CLI)
    // the auto-policy child a split creates: approved, so somebody is still expected to run it
    const child = await kernel.proposeSplit(splitArgs(parent.id, 'call_1', 'child', ApprovalPolicy.parse({ default: 'auto' })), SUPERVISOR)

    let settled = false
    const watching = watchSubtree(kernel, parent.id).then(r => { settled = true; return r })
    await stamp(log, parent.id, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, parent.id, TASK_STATUS.running, TASK_STATUS.done)

    // a terminal root is NOT a finished tree — the child still has nobody's answer
    await Bun.sleep(300)
    expect(settled).toBe(false)

    await stamp(log, child.childTaskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, child.childTaskId, TASK_STATUS.running, TASK_STATUS.done)
    expect(await watching).toEqual({ parked: false, outcome: RunOutcome.done })
  }, 15_000)

  it('a watched run resolves parked when a gate is open anywhere in the subtree', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    cleanup.push(() => log.close())
    spyOn(console, 'log').mockImplementation(() => {})

    const parent = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'parent', spec: '' }, CLI)
    await kernel.proposePlan(parent.id, singleStepDraft({ title: 'p', spec: 'p' }, 'fake/m'), CLI)
    await kernel.approvePlan(parent.id, undefined, undefined, CLI)
    const child = await kernel.proposeSplit(splitArgs(parent.id, 'call_1', 'child', ApprovalPolicy.parse({ default: 'auto' })), SUPERVISOR)
    // the parent sits in join_splits while the child asks: the parent's own stream stays silent, so
    // a watch that read only the watched task would wait forever on a question already asked
    await log.append({
      ...SUPERVISOR, taskId: child.childTaskId, stepId: 'w1', runToken: `step:${child.childTaskId}:w1:a1`,
      kind: EVENT_KIND.feedback_requested, payload: { question: 'may I overwrite it?', topic: 'confirm' },
    })

    expect(await watchSubtree(kernel, parent.id))
      .toEqual({ parked: true, taskId: child.childTaskId, question: 'may I overwrite it?' })
  }, 15_000)
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

// A door parses, names its Origin and presents — nothing else. main.ts held a SECOND copy of new,
// reply and run (its own kernel calls), which is how `orc new --budget` and the web door drifted.
describe('the CLI door appends exactly what the shared action appends', () => {
  const shape = async (log: EventLog, taskId: string) =>
    (await log.byTask(taskId)).map(e => ({ kind: e.kind, chatId: e.chatId, door: e.door }))

  async function doorFixture() {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig(), send: async () => {} })
    db.onClose(() => storage.close())
    await seedTestWorkspace(log, CLI)
    const stubPort: ExecutionPort = {
      startRun: async () => ({ workflowId: 'run:x:v1', wait: async () => RunOutcome.done }),
      retry: async () => { throw new Error('unused in this test') },
      cancelRun: async () => {},
    }
    const { run, lines } = cli(kernel, async () => stubPort)
    const actions = buildOrcActions({ kernel, ensureRuntime: async () => {} })
    return { run, lines, kernel, log, actions }
  }

  const settle = async (ready: () => boolean) => { for (let i = 0; i < 300 && !ready(); i++) await Bun.sleep(20) }

  it('orc new is actions.newTask under NO_CHAT(Door.cli)', async () => {
    const { run, kernel, actions, log } = await doorFixture()
    const door = must((await run('new', 'door task', '--workspace', TEST_WORKSPACE_ID, '--budget', '5'))[0], 'task id')
    const { taskId } = await actions.newTask({ title: 'action task', workspaceId: TEST_WORKSPACE_ID, budgetUSD: 5 }, CLI)
    expect(await shape(log, door)).toEqual([{ kind: EVENT_KIND.task_created, chatId: null, door: Door.cli }])
    expect(await shape(log, door)).toEqual(await shape(log, taskId))
    // --budget is the door's whole reason for having held its own createTask: it must survive.
    expect((await kernel.getTask(door))?.budgetUSD).toBe(5)
    expect((await kernel.getTask(taskId))?.budgetUSD).toBe(5)
  })

  it('orc reply is actions.reply under NO_CHAT(Door.cli)', async () => {
    const { run, kernel, actions, log } = await doorFixture()
    const ask = async (title: string) => {
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title }, CLI)
      await log.append({ ...CLI, taskId: t.id, stepId: 'plan', runToken: `step:${t.id}:plan:a1`, kind: EVENT_KIND.feedback_requested, payload: { question: 'q?', topic: 'auth-1' } })
      return t.id
    }
    const door = await ask('door reply')
    const viaAction = await ask('action reply')
    await expect(run('reply', door, 'approve')).rejects.toBeInstanceOf(CommandFailure) // nothing drives it: the watch reports a tree short of done
    await actions.reply(viaAction, 'approve', undefined, CLI)
    expect(await shape(log, door)).toEqual(await shape(log, viaAction))
    expect((await shape(log, door)).at(-1)).toEqual({ kind: EVENT_KIND.feedback_provided, chatId: null, door: Door.cli })
  })

  it('orc run is actions.run under NO_CHAT(Door.cli)', async () => {
    const { run, lines, kernel, actions, log } = await doorFixture()
    const approved = async (title: string) => {
      const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title }, CLI)
      await kernel.proposePlan(t.id, singleStepDraft({ title, spec: '' }, 'fake/m', []), CLI)
      await kernel.approvePlan(t.id, undefined, undefined, CLI)
      return t.id
    }
    const door = await approved('door run')
    const viaAction = await approved('action run')
    const watched = run('run', door)
    // The door records the ask and WATCHES; the supervisor's half is faked, or the watch waits
    // forever on an approved task and its live subscription blocks teardown's DROP DATABASE.
    await settle(() => lines.some(l => l.includes('run requested for')))
    const doorShape = await shape(log, door)
    for (const [from, to] of [[TASK_STATUS.approved, TASK_STATUS.running], [TASK_STATUS.running, TASK_STATUS.done]])
      await log.append({ ...SUPERVISOR, taskId: door, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: door, from, to } })
    await watched
    const { since } = await actions.run(viaAction, null, CLI)
    expect(typeof since).toBe('number') // the CLI watches from it — swallowing it made the door re-tail the whole log
    expect(doorShape).toEqual(await shape(log, viaAction))
    expect(doorShape.at(-1)).toEqual({ kind: EVENT_KIND.run_requested, chatId: null, door: Door.cli })
  }, 20_000)
})
