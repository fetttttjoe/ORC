import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalPolicy, AUTHOR_SOURCE, CHECKS_STEP_ID, Confidence, Door, EVENT_KIND, NO_CHAT, MEMORY_ACCESS, MemoryAccessedPayload, MemoryDeletedPayload, MemoryWrittenPayload, NOTE_TIER, OperationKind, ROLE_SKILL, RunOutcome, TASK_STATUS, WORKSPACE_KIND, claimId, type ExecutionPort, type MemoryAuthor, type OperationSpec, type TaskNode, type TaskStatus, LINK_KIND } from '@orc/contracts'
import { claimFixture, must } from '@orc/contracts/fixtures'
import { loadConfig, requireProject, type EventLog, type ProjectConfig } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID, testOrcConfig } from '@orc/kernel/test-helpers'
import { singleStepDraft } from './plan-template'
import { buildProgram, openKernel, runInit } from './main'
import { buildOrcActions } from './actions'
import { withMemory } from './memory-open'
import { CommandFailure } from './exit'
import { cli, dropSurrealDb, testSurrealDbName } from './test-helpers'
import { watchSubtree } from './watch'
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
      id: 'orphan-1', parentId: null, workspaceId: 'workspace-the-fold-never-saw', type: 'generic',
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
      { analyzed: true, scope: ['packages'], gaps: ['no tests read'], confidence: Confidence.medium, notesWritten: 3 },
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

  it('memory add/rebuild/ls/search/cat/rm round-trip against an isolated throwaway SurrealDB db', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-cli-'))
    const projectDbName = testSurrealDbName()
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config) // real plugin wiring — no stub casts
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const { run } = cli(kernel, undefined, { host, hub, config, log })

    const id = `cli-test-${Math.random().toString(36).slice(2, 10)}`
    await run('memory', 'add', '--id', id, '--title', 'T', '--summary', 'S', '--body', 'B', '--tags', 'x')

    // Primary isolated assertion: this test's own (per-test Postgres) log recorded the append —
    // true independent of SurrealDB, which every other assertion below depends on.
    const written = (await log.all()).find(e => e.kind === EVENT_KIND.memory_written)
    expect(written).toBeDefined()
    const writtenEvent = must(written, 'memory written event')
    expect(notePayloadId(writtenEvent.payload)).toBe(id)

    // Isolated db — safe to clear-and-replay from this test's own event log only.
    await run('memory', 'rebuild')

    expect((await run('memory', 'ls')).join('\n')).toContain(id)

    const note = JSON.parse((await run('memory', 'cat', id)).join('\n'))
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
    const decisionWriteEvent = must(decisionWrite, 'decision write event')
    expect(notePayloadKind(decisionWriteEvent.payload)).toBe('decision')
    // removed immediately: the end of this test asserts `ls` reads '_no notes_', so a note left
    // behind here would fail an assertion that has nothing to do with kinds
    await run('memory', 'rm', decisionId)

    // An unknown kind is a friendly parse-time error naming the valid set, never a silent default
    // to 'fact' — the discipline --tier and `neighbors --kinds` already apply. 'adr' is the exact
    // near-miss this catches: it is a tag, never a kind.
    await expect(run('memory', 'add', '--id', 'k1', '--title', 'K', '--kind', 'adr')).rejects.toThrow(/unknown kind/)

    expect((await run('memory', 'search', 'x')).join('\n')).toContain(id) // matches the 'x' tag

    // `cat` is a read: it records one access, and `ls` surfaces the count so a human can see
    // which knowledge is actually load-bearing. A miss records nothing — the note wasn't read.
    const accesses = () => log.all().then(es => es.filter(e => e.kind === EVENT_KIND.memory_accessed))
    expect(await accesses()).toHaveLength(1)
    expect((await run('memory', 'ls')).join('\n')).toContain('hits 1')

    await expect(run('memory', 'cat', 'no-such-note-here')).rejects.toThrow()
    expect(await accesses()).toHaveLength(1)

    await run('memory', 'rm', id) // rm's action already runs catchUp() itself
    await expect(run('memory', 'cat', id)).rejects.toThrow(`no note '${id}'`)
    expect(await accesses()).toHaveLength(1) // a deleted note is a miss, not a read

    // Empty results print a sentinel, the way `tasks` does. Zero bytes reads as "no such note"
    // when the honest answer is "the read model returned nothing" — the agent-facing tools
    // already say exactly that, so the human must not get less.
    expect((await run('memory', 'ls')).join('\n').trim()).toBe('_no notes_')
    expect((await run('memory', 'search', 'definitely-not-present-anywhere')).join('\n').trim()).toBe('_no notes_')

    // --- neighbors traversal (M4b) -------------------------------------------------------------
    // memory add has no --links flag, so seed a linked graph the way the cancel-sweep test seeds
    // notes: append memory_written directly, then rebuild the read model from this test's own log.
    // Chain: seed --depends_on--> hop1 --relates_to--> hop2, plus seed --refines--> other.
    const seedNote = (nid: string, links: Array<{ id: string; kind: string }> = []) =>
      log.append({
        ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
        payload: { note: { id: nid, title: nid, links }, author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI } },
      })
    await seedNote('nb-seed', [{ id: 'nb-hop1', kind: LINK_KIND.depends_on }, { id: 'nb-other', kind: LINK_KIND.refines }])
    await seedNote('nb-hop1', [{ id: 'nb-hop2', kind: LINK_KIND.relates_to }])
    await seedNote('nb-hop2')
    await seedNote('nb-other')
    await seedNote('nb-isolated') // no links either way
    await run('memory', 'rebuild')

    const accessCount = () => log.all().then(es => es.filter(e => e.kind === EVENT_KIND.memory_accessed).length)

    // 1. bare neighbors prints the linked neighbor with its via/depth/score/title row.
    const beforeHit = await accessCount()
    const nbLines = await run('memory', 'neighbors', 'nb-seed')
    const nbOut = nbLines.join('\n')
    expect(nbOut).toContain('nb-hop1')
    expect(nbOut).toContain('nb-other')
    // row shape: id\t<dir> via\tdepth\tscore(2dp)\ttitle  (dir: → seed→n, ← n→seed)
    const hop1Row = must(nbLines.find(l => l.startsWith('nb-hop1\t')), 'hop1 row in neighbors output')
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
    const lastAccessEvent = must(accessed.at(-1), 'last memory accessed event')
    const lastAccess = MemoryAccessedPayload.parse(lastAccessEvent.payload)
    expect(lastAccess.mode).toBe(MEMORY_ACCESS.neighbors)
    expect(lastAccess.id).toBe('nb-seed')

    // 2. --kinds depends_on narrows: nb-other (refines) is excluded, nb-hop1 (depends_on) stays.
    const kindsOut = (await run('memory', 'neighbors', 'nb-seed', '--kinds', 'depends_on')).join('\n')
    expect(kindsOut).toContain('nb-hop1')
    expect(kindsOut).not.toContain('nb-other')

    // an unknown kind is a friendly error, not a silent empty result (matches --strategy).
    await expect(run('memory', 'neighbors', 'nb-seed', '--kinds', 'not-a-kind')).rejects.toThrow(/unknown --kinds/)

    // 3. --depth 1 bounds traversal: the 2-hop nb-hop2 is absent at depth 1, present by default (2).
    expect((await run('memory', 'neighbors', 'nb-seed', '--depth', '1')).join('\n')).not.toContain('nb-hop2')
    expect((await run('memory', 'neighbors', 'nb-seed', '--depth', '2')).join('\n')).toContain('nb-hop2')

    // depth < 1 is rejected at parse time (store default is 2, rank needs a positive hop count).
    await expect(run('memory', 'neighbors', 'nb-seed', '--depth', '0')).rejects.toThrow(/positive integer/)

    // 4. --scope selects: the seeded notes live in the default 'project' scope; an explicit
    // --scope project still finds them.
    expect((await run('memory', 'neighbors', 'nb-seed', '--scope', 'project')).join('\n')).toContain('nb-hop1')

    // 6. empty case: an isolated seed prints the sentinel and records NO new access.
    const beforeMiss = await accessCount()
    expect((await run('memory', 'neighbors', 'nb-isolated')).join('\n').trim()).toBe('_no neighbors_')
    expect(await accessCount()).toBe(beforeMiss) // a miss records nothing

    // quick capture: same plugin wiring, zero ceremony, slugged-title id
    expect((await run('note', 'Quick Capture Works!', '--summary', 'from the test')).join('\n')).toContain("noted 'quick-capture-works'")
    expect((await run('memory', 'cat', 'quick-capture-works')).join('\n')).toContain('from the test')
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
    const projectDbName = testSurrealDbName()
    // keyword-only, same reason as the claims tests: nothing here needs an embedder
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
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
    const leakedMemory = must(leaked, 'leaked memory store')
    await expect(leakedMemory.store.list()).rejects.toThrow()
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
    const projectDbName = testSurrealDbName()
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
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
    const projectDbName = testSurrealDbName()
    // Keyword-only ON PURPOSE: `topics` is derived from claim EMBEDDINGS, so leaving the default
    // ollama embedder wired would make the empty-inventory assertion below depend on whether a
    // local Ollama happens to be running. The claims command itself never touches an embedder.
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const { run } = cli(kernel, undefined, { host, hub, config, log })

    // `memory add` has no claim flag, so state them the way the store's own payload does: the note
    // carries the LIVE set and the EVENT carries the tombstone. Two writes, so the second retires
    // what the first stated — the only shape from which --history has something to recover.
    const noteId = 'claims-cli-note'
    const liveText = 'the projector drains before every read'
    const retiredText = 'the read model is the source of truth'
    const write = (texts: string[], invalidates: string[] = []) => log.append({
      ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: {
        note: { id: noteId, title: 'claims', claims: texts.map(t => claimFixture(t)) },
        author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI }, invalidates,
      },
    })
    await write([retiredText])
    await write([liveText], [claimId(retiredText)])

    // REGRESSION: nothing has drained the projector yet, so the claim rows do not exist. The
    // command only finds them if it catches up itself, the way every sibling read command does —
    // and its empty case is a THROW, so the missing drain reads as "this note has no claims".
    const drained = await run('memory', 'claims', noteId)
    expect(drained.join('\n')).toContain(liveText)
    expect(drained.join('\n')).not.toContain(retiredText) // retired: gone from the read model

    // --history folds the LOG instead, which is the only surface a retired claim survives on
    const history1 = await run('memory', 'claims', noteId, '--history')
    expect(history1.join('\n')).toContain(liveText)
    expect(history1.join('\n')).toContain(retiredText)
    expect(history1.find(l => l.includes(retiredText))).toContain('RETIRED')

    // Deleting the note ends its claims' stretches too — the projector drops their rows with it, so
    // a fold that saw only memory_written would keep reporting the live one as live forever.
    await log.append({
      ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted,
      payload: { id: noteId, scope: 'project', author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI } },
    })
    const history2 = await run('memory', 'claims', noteId, '--history')
    expect(history2.find(l => l.includes(liveText))).toContain('RETIRED')

    await expect(run('memory', 'claims', 'no-such-note-at-all')).rejects.toThrow(/no claims on/)

    // No embedder → no claim vectors → no partition. The empty message must name the cause an
    // operator upgrading onto claims actually hits (a corpus whose claims were all legacy-derived),
    // not only the two it used to name.
    await expect(run('memory', 'topics')).rejects.toThrow(/legacy rules\[\] decoder/)
    // an unknown key is the store's own error, surfaced by the CLI rather than swallowed
    await expect(run('memory', 'topics', 'deadbeef1234')).rejects.toThrow(/no topic/)

    // `memory add --claim/--invalidate`: the flags are ADDITIVE like the tool they mirror — a later
    // write states what to add and retire, and must not disturb the claims it did not name.
    const cliNote = 'cli-authored-claims'
    await run('memory', 'add', '--id', cliNote, '--title', 'CLI claims', '--claim', 'first from the cli', '--claim', 'second from the cli')
    const claims1 = await run('memory', 'claims', cliNote)
    const first = claims1.find(l => l.includes('first from the cli'))
    const secondId = claims1.find(l => l.includes('second from the cli'))?.split(/\s+/)[0]
    expect(first).toBeDefined()
    expect(secondId).toMatch(/^[a-f0-9]{12}$/)

    await run('memory', 'add', '--id', cliNote, '--title', 'CLI claims', '--claim', 'third from the cli', '--invalidate', secondId ?? '')
    const live = (await run('memory', 'claims', cliNote)).join('\n')
    expect(live).toContain('third from the cli')
    expect(live).toContain('first from the cli')   // untouched by a write that never named it
    expect(live).not.toContain('second from the cli') // retired by --invalidate
    // and the retired one is still recoverable from the log, which is the only place it survives
    const history3 = await run('memory', 'claims', cliNote, '--history')
    expect(history3.find(l => l.includes('second from the cli'))).toContain('RETIRED')
  }, 30_000)

  it('memory claims --json emits the raw claim array for both the live and the --history form', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-claims-json-cli-'))
    const projectDbName = testSurrealDbName()
    // Keyword-only, same reason as the sibling claims test: nothing here needs an embedder, and
    // leaving the default ollama one wired makes the test depend on whether a local Ollama runs.
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const { run } = cli(kernel, undefined, { host, hub, config, log })

    // Two writes, so the second retires what the first stated — the only shape in which the live
    // form and the --history form return DIFFERENT arrays, which is what makes this test able to
    // tell the two --json branches apart.
    const noteId = 'claims-json-cli-note'
    const liveText = 'json output is the raw domain value'
    const retiredText = 'json output was wrapped in an envelope'
    const write = (texts: string[], invalidates: string[] = []) => log.append({
      ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: {
        note: { id: noteId, title: 'claims json', claims: texts.map(t => claimFixture(t)) },
        author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI }, invalidates,
      },
    })
    await write([retiredText])
    await write([liveText], [claimId(retiredText)])

    // (a) live form: stdout is exactly one parseable JSON value — the raw Claim[], no envelope.
    const live = JSON.parse((await run('memory', 'claims', noteId, '--json')).join('\n'))
    expect(Array.isArray(live)).toBe(true)
    expect(live.map((c: { text: string }) => c.text)).toEqual([liveText]) // retired one is not live
    expect(live[0].id).toBe(claimId(liveText))
    expect(typeof live[0].validFrom).toBe('string')

    // (b) --history --json folds the LOG: the retired claim survives, carrying its tombstone.
    const history = JSON.parse((await run('memory', 'claims', noteId, '--history', '--json')).join('\n'))
    expect(history.map((c: { text: string }) => c.text).sort()).toEqual([liveText, retiredText].sort())
    const retired = history.find((c: { text: string }) => c.text === retiredText)
    expect(typeof retired.invalidatedAt).toBe('string') // RETIRED in the human form
    expect(history.find((c: { text: string }) => c.text === liveText).invalidatedAt).toBeNull()

    // (c) the human forms are UNCHANGED: tab-free `id  validFrom  text` rows, not JSON.
    const humanLive = await run('memory', 'claims', noteId)
    expect(humanLive.join('\n')).toContain(liveText)
    expect(humanLive.join('\n').trim().startsWith('[')).toBe(false)
    const humanHistory = await run('memory', 'claims', noteId, '--history')
    expect(humanHistory.find(l => l.includes(retiredText))).toContain('RETIRED')
    expect(humanHistory.join('\n').trim().startsWith('[')).toBe(false)

    // (d) absence is DATA under --json (the settled `topics --json` rule): [] and exit 0, so a
    // script reads an empty array instead of parsing a thrown diagnostic. The no-flag form keeps
    // the throw that names the note and the command a person can act on.
    expect(JSON.parse((await run('memory', 'claims', 'no-such-note-at-all', '--json')).join('\n'))).toEqual([])
    expect(JSON.parse((await run('memory', 'claims', 'no-such-note-at-all', '--history', '--json')).join('\n'))).toEqual([])
    await expect(run('memory', 'claims', 'no-such-note-at-all')).rejects.toThrow(/no claims on/)
    await expect(run('memory', 'claims', 'no-such-note-at-all', '--history')).rejects.toThrow(/no claims in the log/)
  }, 30_000)

  it('memory topics --json emits raw JSON, keeps the human throws, and rejects an unknown key', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-memory-topics-cli-'))
    const projectDbName = testSurrealDbName()
    // Keyword-only ON PURPOSE (same reason as the claims test): `topics` is derived from claim
    // EMBEDDINGS, so leaving the default ollama embedder wired would make the empty-inventory
    // assertions depend on whether a local Ollama happens to be running. With no embedder there
    // are no claim vectors and thus no topics — the deterministic empty inventory this test needs.
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test', memoryEmbedModel: '' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const { run } = cli(kernel, undefined, { host, hub, config, log })

    // (a) --json on the EMPTY inventory is [] and exit 0, not a throw. A script wants absence as
    // data; stdout must be exactly one parseable JSON value.
    expect(JSON.parse((await run('memory', 'topics', '--json')).join('\n'))).toEqual([])

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
    const projectDbName = testSurrealDbName()
    const config = requireProject({ ...loadConfig(dir), projectDbName, projectId: TEST_PROJECT_ID, projectName: 'test' })
    surrealConfigs.push(config)
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, config: testOrcConfig() })
    // the workspace must sit at THIS config's dir: every CLI memory write resolves its author's
    // workspace by matching the process's directory, and refuses when nothing claims it
    await seedTestWorkspace(log, CLI, realpathSync(config.dir))
    const { host, hub } = await buildPlugins(config)
    // this describe never shut its host down at all — same leak, unconditional
    cleanup.push(() => log.close(), () => hub.close(), () => host.shutdown())
    const stubPort: ExecutionPort = {
      startRun: async () => { throw new Error('unused') },
      retry: async () => { throw new Error('unused') },
      cancelRun: async () => {},
    }
    const { run } = cli(kernel, async () => stubPort, { host, hub, config, log })

    const taskId = must((await run('new', 'sweep wiring', '--workspace', TEST_WORKSPACE_ID))[0], 'task id')
    const write = (id: string, author: MemoryAuthor) => log.append({
      ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id, title: id }, author },
    })
    await write('wiring-orphan', { source: AUTHOR_SOURCE.agent, workspaceId: TEST_WORKSPACE_ID, taskId, origin: SUPERVISOR })
    await write('wiring-adopted', { source: AUTHOR_SOURCE.agent, workspaceId: TEST_WORKSPACE_ID, taskId, origin: SUPERVISOR })
    await write('wiring-adopted', { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: CLI }) // re-written by a live writer -> adopted

    const out = (await run('cancel', taskId)).join('\n')
    expect(out).toContain('cancelled')
    expect(out).toContain('swept wiring-orphan')
    expect(out).not.toContain('swept wiring-adopted')
    const deleted = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_deleted)
    expect(deleted.map(e => e.payload.id)).toEqual(['wiring-orphan'])
    const deletedEvent = must(deleted[0], 'first deleted event')
    expect(deletedAuthorTaskId(deletedEvent.payload)).toBe(taskId)

    // failure path: a sweep failure warns; the cancel itself still exits clean
    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const afterSpy = spyOn(log, 'after').mockImplementation(async () => { throw new Error('surreal down') })
    expect((await run('cancel', taskId)).join('\n')).toContain('cancelled') // must not reject
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
