import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { Analyzer, ExecutionPort, OperationSpec, RunHandle } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
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
  const { kernel, storage } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  const { port, calls } = stubPort(outcome)
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  const run = async (...args: string[]) =>
    buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
  return { run, lines, calls, kernel, db }
}

async function approvedTask(run: (...a: string[]) => Promise<unknown>, lines: string[]) {
  await run('new', 'exec me')
  const id = lines[0]!
  await run('propose', id)
  await run('approve', id)
  return id
}

describe('exec commands', () => {
  it('run starts via the port and reports the outcome', async () => {
    const { run, lines, calls } = await makeCli('done')
    const id = await approvedTask(run, lines)
    await run('run', id)
    expect(calls).toContain(`start:${id}:`)
    expect(lines.join('\n')).toContain('done')
  })

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

  it('run --cwd forwards the override', async () => {
    const { run, lines, calls } = await makeCli()
    const id = await approvedTask(run, lines)
    await run('run', id, '--cwd', '/tmp/shared-ws')
    expect(calls).toContain(`start:${id}:/tmp/shared-ws`)
  })

  it('run drains events committed in the final window before printing the outcome', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const { kernel } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
    const id = await approvedTask(run, lines)
    lines.length = 0

    // Simulate the real race: the workflow's terminal event commits exactly as handle.wait()
    // resolves — possibly before the push subscription's NOTIFY round-trip is delivered. The
    // finally-block drain (a direct query, not NOTIFY-dependent) must still surface it, whether
    // or not the live subscription got there first.
    const rawLog = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const handle: RunHandle = {
      workflowId: 'run:x:v1',
      wait: async () => {
        await rawLog.append({
          taskId: id, stepId: 's1', runToken: 'r1', kind: 'step_failed',
          payload: { stepId: 's1', runToken: 'r1', class: 'agent_error', message: 'blocked: boom' },
        })
        return 'done' // draining is under test, not exit semantics — those live in the fixture test
      },
    }
    const port: ExecutionPort = { startRun: async () => handle, retry: async () => handle, cancelRun: async () => {} }

    try {
      await run('run', id)
      expect(lines.join('\n')).toContain('step_failed')
    } finally {
      await rawLog.close()
    }
  })

  it('retry and cancel call through', async () => {
    const { run, lines, calls } = await makeCli('done')
    const id = await approvedTask(run, lines)
    await run('retry', id)
    await run('cancel', id)
    expect(calls).toContain(`retry:${id}`)
    expect(calls).toContain(`cancel:${id}`)
  })

  it('new --strategy grounded-plan bootstraps via createGroundedTask and auto-starts the run', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const analyze = stepFixture({ id: 'analyze', role: 'scout' })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const { kernel } = await openKernel(db.url, { projectId: TEST_PROJECT_ID, analyzers })
    // 'done' (not 'blocked') deliberately — a 'blocked' outcome sets process.exitCode in this
    // same test process (see the subprocess fixture above for why that path is tested there).
    const { port, calls } = stubPort('done')
    const lines: string[] = []
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
    const run = async (...args: string[]) => buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })

    await run('new', 'grounded task', '--spec', 'analyze the repo and split the work', '--strategy', 'grounded-plan', '--model', 'anthropic/claude-sonnet-5')
    const taskId = lines[0]!
    const plan = await kernel.getPlan(taskId)
    expect(plan?.strategyRef).toBe('grounded-plan')
    expect(plan?.steps.map(s => s.id)).toEqual(['analyze', 'plan'])
    expect((await kernel.getTask(taskId))?.spec).toBe('analyze the repo and split the work')
    expect((await kernel.getTask(taskId))?.status).toBe('approved') // auto-approved (D9)
    expect(calls).toContain(`start:${taskId}:${process.cwd()}`) // grounded analysis starts at the project root
    expect(lines.join('\n')).toContain('run finished: done')
  })

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
      taskId: id, stepId: 's1', runToken: opContext.runToken, kind: 'artifact_produced',
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
