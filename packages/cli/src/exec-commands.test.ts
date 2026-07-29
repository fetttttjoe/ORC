import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { EVENT_KIND, TASK_STATUS, type Analyzer, type ExecutionPort, type OperationSpec, type RunHandle, type RunOutcome, type TaskStatus } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
import { openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { singleStepDraft } from './actions'
import { buildProgram, openKernel } from './main'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { for (const d of dbs) await d.drop() })
afterEach(() => mock.restore())

function stubPort(outcome: 'done' | 'blocked' = 'done') {
  const calls: string[] = []
  const handle: RunHandle = { workflowId: 'run:x:v1', wait: async () => outcome }
  const port: ExecutionPort = {
    startRun: async (id, opts) => { calls.push(`start:${id}:${opts?.cwd ?? ''}`); return handle },
    retry: async id => { calls.push(`retry:${id}`); return handle },
    cancelRun: async id => { calls.push(`cancel:${id}`) },
  }
  return { port, calls }
}

async function makeCli(outcome: 'done' | 'blocked' = 'done') {
  const db = await createTestDb()
  dbs.push(db)
  const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  const { port, calls } = stubPort(outcome)
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  const run = async (...args: string[]) =>
    buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
  return { run, lines, calls, kernel, log, db }
}

async function approvedTask(run: (...a: string[]) => Promise<unknown>, lines: string[]) {
  await run('new', 'exec me')
  const id = lines[0]!
  await run('propose', id)
  await run('approve', id)
  return id
}

// The supervisor's half of a run, faked: no test here holds a real runtime, so the statuses a run
// would stamp are appended straight onto the log.
const stamp = (log: EventLog, taskId: string, from: TaskStatus, to: TaskStatus) =>
  log.append({ taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from, to } })

const until = async (ready: () => boolean) => { for (let i = 0; i < 300 && !ready(); i++) await Bun.sleep(20) }
const watching = (lines: string[]) => until(() => lines.some(l => l.includes('run requested for')))

// Watch a task through to `to`, driving it the way a supervisor would once the ask is recorded.
const drive = async (log: EventLog, lines: string[], id: string, to: TaskStatus) => {
  await watching(lines)
  await stamp(log, id, TASK_STATUS.approved, TASK_STATUS.running)
  await stamp(log, id, TASK_STATUS.running, to)
}

describe('exec commands', () => {
  it('run records the ask and reports the outcome the log settles on', async () => {
    const { run, lines, calls, log, kernel } = await makeCli('done')
    const id = await approvedTask(run, lines)
    lines.length = 0
    const watched = run('run', id)
    await drive(log, lines, id, TASK_STATUS.done)
    await watched
    expect(calls).toEqual([]) // the supervisor starts runs; this command only asked for one
    expect((await kernel.eventsFor(id)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(true)
    expect(lines.join('\n')).toContain('run finished: done')
  }, 15_000)

  it('blocked run exits 1 — real process exit status via subprocess fixture', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const { port } = stubPort()
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
    const id = await approvedTask(run, lines)
    mock.restore()
    await log.close()

    const fixture = path.join(import.meta.dir, 'exec-fixture.ts')
    const child = Bun.spawn(['bun', fixture, db.url, id, 'blocked'], { stdout: 'ignore', stderr: 'inherit' })
    expect(await child.exited).toBe(1)
  }, 20_000)

  it('run --cwd records the override, the one thing only the caller knows', async () => {
    const { run, lines, log, kernel } = await makeCli()
    const id = await approvedTask(run, lines)
    lines.length = 0
    const watched = run('run', id, '--cwd', '/tmp/shared-ws')
    await drive(log, lines, id, TASK_STATUS.done)
    await watched
    const requested = (await kernel.eventsFor(id)).find(e => e.kind === EVENT_KIND.run_requested)
    expect(requested?.payload).toEqual({ taskId: id, cwd: '/tmp/shared-ws', retry: false })
  }, 15_000)

  it('run drains events committed in the final window before printing the outcome', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const { port } = stubPort()
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
    const id = await approvedTask(run, lines)
    lines.length = 0

    // Simulate the real race: a step's last event commits in the same window as the terminal
    // status the watch settles on, possibly after the push subscription has been torn down. The
    // finally-block drain (a direct query, not NOTIFY-dependent) must still surface it.
    const rawLog = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    try {
      const watched = run('run', id)
      await watching(lines)
      await stamp(rawLog, id, TASK_STATUS.approved, TASK_STATUS.running)
      await rawLog.append({
        taskId: id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_failed,
        payload: { stepId: 's1', runToken: 'r1', class: 'agent_error', message: 'blocked: boom' },
      })
      await stamp(rawLog, id, TASK_STATUS.running, TASK_STATUS.done) // draining is under test, not exit semantics
      await watched
      expect(lines.join('\n')).toContain(EVENT_KIND.step_failed)
    } finally {
      await rawLog.close()
    }
  }, 15_000)

  // Regression: a run that parks on ask_human never produces a terminal result, so the tail waited
  // on a promise that could not resolve — at the terminal that is indistinguishable from a hang,
  // and it is what killed the driver of a real grounded run mid-question.
  it('a run parked on a human gate reports the question and stops tailing', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    // the workflow is suspended on the gate: its result NEVER arrives
    const handle: RunHandle = { workflowId: 'run:x:v1', wait: () => new Promise<RunOutcome>(() => {}) }
    const port: ExecutionPort = { startRun: async () => handle, retry: async () => handle, cancelRun: async () => {} }
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
    const id = await approvedTask(run, lines)
    await log.append({
      taskId: id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { question: 'May I analyze the codebase?', topic: `${id}:s1:1` },
    })
    lines.length = 0

    await run('run', id) // must RETURN — before the fix this awaited forever
    const out = lines.join('\n')
    expect(out).toContain('parked')
    expect(out).toContain('May I analyze the codebase?')
    expect(out).toContain(`orc reply ${id}`)
    expect(out).not.toContain('run finished')
    await log.close()
  }, 15_000)

  // `orc reply` used to send the DBOS message and exit, so the answer sat durable while the run
  // stayed parked — its own description claimed it resumed the step. It now watches the run
  // through to its next stopping point instead, without starting anything.
  it('reply watches the run it just unblocked', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    const { port, calls } = stubPort('done')
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
    const id = await approvedTask(run, lines)
    await stamp(log, id, TASK_STATUS.approved, TASK_STATUS.running) // the run this question is parked inside
    await log.append({
      taskId: id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { question: 'proceed?', topic: `${id}:s1:1` },
    })
    calls.length = 0
    lines.length = 0

    const watched = run('reply', id, 'yes')
    await until(() => lines.some(l => l.includes('answered feedback')))
    await stamp(log, id, TASK_STATUS.running, TASK_STATUS.done)
    await watched
    expect(calls).toEqual([]) // the supervisor carries the answer in; this command never drives
    expect(lines.join('\n')).toContain('run finished: done')
    await log.close()
  }, 15_000)

  it('reply without an open question says so and attaches nothing', async () => {
    const { run, lines, calls } = await makeCli()
    const id = await approvedTask(run, lines)
    calls.length = 0
    lines.length = 0
    await run('reply', id, 'yes')
    expect(lines.join('\n')).toContain('no open feedback question')
    expect(calls).toEqual([])
  })

  // finalize_plan hands the work to a CHILD task. Returning when the parent's own steps finish
  // stranded it: the child sat `running` with no executor until someone ran `orc run <childId>` by
  // hand. Observed live on the capability run. The CLI no longer starts the child — the supervisor
  // does — so what has to hold now is that the watch does not call the parent done without it.
  it('waits for a child task the run spawned instead of calling the tree finished', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => storage.close())
    const { port, calls } = stubPort('done')
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
    const parent = await approvedTask(run, lines)
    // the split: a child task of the parent, still running when the parent's steps finish
    const child = (await kernel.createTask({ title: 'split child', spec: '', parentId: parent })).id
    await kernel.proposePlan(child, singleStepDraft({ title: 'child', spec: '' }, 'fake/m', []))
    await kernel.approvePlan(child)
    calls.length = 0
    lines.length = 0

    let settled = false
    const watched = run('run', parent).then(() => { settled = true })
    await drive(log, lines, parent, TASK_STATUS.done)
    await Bun.sleep(300)
    expect(settled).toBe(false) // the parent's own steps are done; the tree is not

    await stamp(log, child, TASK_STATUS.approved, TASK_STATUS.done)
    await watched
    expect(calls).toEqual([])
    expect(lines.join('\n')).toContain('run finished: done')
  }, 20_000)

  it('retry records a retry ask; cancel stamps the subtree, both without a port', async () => {
    const { run, lines, calls, log, kernel } = await makeCli('done')
    const id = await approvedTask(run, lines)
    await stamp(log, id, TASK_STATUS.approved, TASK_STATUS.blocked) // only a blocked task can be retried
    lines.length = 0

    const watched = run('retry', id)
    await watching(lines)
    await stamp(log, id, TASK_STATUS.blocked, TASK_STATUS.running)
    await stamp(log, id, TASK_STATUS.running, TASK_STATUS.done)
    await watched
    const requested = (await kernel.eventsFor(id)).find(e => e.kind === EVENT_KIND.run_requested)
    expect(requested?.payload).toEqual({ taskId: id, cwd: null, retry: true })

    await run('cancel', id)
    expect(calls).toEqual([]) // neither command needs a runtime of its own
  }, 15_000)

  it('retry refuses a task that is not blocked, before recording anything', async () => {
    const { run, lines, kernel } = await makeCli('done')
    const id = await approvedTask(run, lines)
    await expect(run('retry', id)).rejects.toThrow(/only a blocked task can be retried/)
    expect((await kernel.eventsFor(id)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
  })

  it('new --strategy grounded-plan bootstraps via createGroundedTask and auto-starts the run', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const analyze = stepFixture({ id: 'analyze', role: 'scout' })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, analyzers })
    // a non-done outcome is a thrown CommandFailure now, not a write to process.exitCode, so this
    // could assert either; 'done' keeps the test about the grounded bootstrap rather than exits.
    const { port, calls } = stubPort('done')
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })

    const bootstrapping = run('new', 'grounded task', '--spec', 'analyze the repo and split the work', '--strategy', 'grounded-plan', '--model', 'anthropic/claude-sonnet-5')
    await watching(lines)
    const taskId = lines[0]!
    await stamp(log, taskId, TASK_STATUS.approved, TASK_STATUS.running)
    await stamp(log, taskId, TASK_STATUS.running, TASK_STATUS.done)
    await bootstrapping

    const plan = await kernel.getPlan(taskId)
    expect(plan?.strategyRef).toBe('grounded-plan')
    expect(plan?.steps.map(s => s.id)).toEqual(['analyze', 'plan'])
    expect((await kernel.getTask(taskId))?.spec).toBe('analyze the repo and split the work')
    // auto-started (D9): the ask is recorded, and a supervisor — not this command — serves it
    expect((await kernel.eventsFor(taskId)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(true)
    expect(calls).toEqual([])
    expect(lines.join('\n')).toContain('run finished: done')
    await log.close()
  }, 15_000)

  it('new --strategy grounded-plan without --model is a clear error', async () => {
    const { run } = await makeCli()
    await expect(run('new', 'x', '--strategy', 'grounded-plan')).rejects.toThrow(/--model is required/)
  })

  it('status renders per-step state and cost totals from the fold', async () => {
    const { run, lines } = await makeCli()
    const id = await approvedTask(run, lines)
    lines.length = 0
    await run('status', id)
    expect(lines.join('\n')).toContain('approved') // task status
    expect(lines.join('\n')).toContain('s1')       // template step listed
  })

  it('status shows started/completed operations and output receipts', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel, log, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const { port } = stubPort()
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
    const id = await approvedTask(run, lines)

    const opContext = { taskId: id, stepId: 's1', runToken: `step:${id}:s1:a1` }
    const modelSpec: OperationSpec = { operationId: `${opContext.runToken}:model:1`, kind: 'model', name: 'fake/m', before: {} }
    const toolSpec: OperationSpec = { operationId: `${opContext.runToken}:tool:1:c1`, kind: 'tool', name: 'fs_write', before: {} }
    await storage.operations.beginOperation(opContext, modelSpec)
    await storage.operations.completeOperation(opContext, modelSpec, 1, { text: 'hi' })
    await storage.operations.beginOperation(opContext, toolSpec) // stays started — visible pending work
    await log.append({
      taskId: id, stepId: 's1', runToken: opContext.runToken, kind: EVENT_KIND.artifact_produced,
      payload: { path: 'report.md', sha256: 'a'.repeat(64), size: 5 },
    })

    lines.length = 0
    await run('status', id)
    const out = lines.join('\n')
    expect(out).toMatch(/op {2}model {2}fake\/m\s+completed/)
    expect(out).toMatch(/op {2}tool {3}fs_write\s+started/)
    expect(out).toContain('report.md · sha256:aaaaaaaaaaaa… · 5B')
    await log.close()
  })
})
