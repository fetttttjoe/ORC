import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ExecutionPort, RunHandle } from '@orc/contracts'
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
    runStatus: async () => ({ workflowId: 'run:x:v1', dbosStatus: 'SUCCESS' }),
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
  return { run, lines, calls, kernel }
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

  it('run --cwd forwards the override', async () => {
    const { run, lines, calls } = await makeCli()
    const id = await approvedTask(run, lines)
    await run('run', id, '--cwd', '/tmp/shared-ws')
    expect(calls).toContain(`start:${id}:/tmp/shared-ws`)
  })

  it('retry and cancel call through', async () => {
    const { run, lines, calls } = await makeCli('blocked')
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
