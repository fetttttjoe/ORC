import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ExecutionPort, RunHandle } from '@orc/contracts'
import { EventLog } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'
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
  const kernel = await openKernel(db.url)
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
    expect(process.exitCode).toBe(0)
    process.exitCode = undefined // restore: a leftover exitCode must not flip the whole `bun test` run
  })

  it('run --cwd forwards the override', async () => {
    const { run, lines, calls } = await makeCli()
    const id = await approvedTask(run, lines)
    await run('run', id, '--cwd', '/tmp/shared-ws')
    expect(calls).toContain(`start:${id}:/tmp/shared-ws`)
  })

  it('run drains events written in the final poll window before printing the outcome', async () => {
    const { run, lines, kernel, db } = await makeCli('blocked')
    const id = await approvedTask(run, lines)
    lines.length = 0

    // Simulate the real race: the workflow's terminal event lands in the DB right after the
    // tail loop's one poll fetch reads its snapshot, then handle.wait() settles — the pre-fix
    // code exits the loop right there and never looks again.
    const real = kernel.eventsSince.bind(kernel)
    const rawLog = await EventLog.open(db.url)
    let calls = 0
    spyOn(kernel, 'eventsSince').mockImplementation(async (taskId: string, afterSeq: number) => {
      calls++
      const snapshot = await real(taskId, afterSeq)
      if (calls === 1) {
        await rawLog.append({
          taskId: id, stepId: 's1', runToken: 'r1', kind: 'step_failed',
          payload: { stepId: 's1', runToken: 'r1', class: 'agent_error', message: 'blocked: boom' },
        })
      }
      return snapshot // call #1 (the loop's poll) returns the pre-append snapshot either way
    })

    try {
      await run('run', id)
      expect(lines.join('\n')).toContain('step_failed')
    } finally {
      await rawLog.close()
      process.exitCode = undefined // restore: a leftover exitCode must not flip the whole `bun test` run
    }
  })

  it('retry and cancel call through', async () => {
    const { run, lines, calls } = await makeCli('blocked')
    const id = await approvedTask(run, lines)
    await run('retry', id)
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined // restore: a leftover exitCode must not flip the whole `bun test` run
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
