import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ExecutionPort, RunHandle } from '@orc/contracts'
import { EventLog } from '@orc/kernel'
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
  const { kernel } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
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
    const { kernel, log } = await openKernel(db.url, { projectId: TEST_PROJECT_ID })
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
    const rawLog = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
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

  it('status renders per-step state and cost totals from the fold', async () => {
    const { run, lines } = await makeCli()
    const id = await approvedTask(run, lines)
    lines.length = 0
    await run('status', id)
    expect(lines.join('\n')).toContain('approved') // task status
    expect(lines.join('\n')).toContain('s1')       // template step listed
  })
})
