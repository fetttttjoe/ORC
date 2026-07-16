import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND } from '@orc/contracts'
import { buildProgram, openKernel } from './main'

function makeCli() {
  const kernel = openKernel(mkdtempSync(path.join(tmpdir(), 'orc-')))
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '))
  })
  // fresh Command instance per invocation; commander does not re-parse cleanly
  const run = async (...args: string[]) => {
    await buildProgram(kernel).parseAsync(args, { from: 'user' })
    return lines
  }
  return { run, lines }
}

afterEach(() => {
  mock.restore()
})

describe('orc CLI', () => {
  it('new → propose → approve → log round-trip', async () => {
    const { run, lines } = makeCli()
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

  it('plan prints the plan as JSON', async () => {
    const { run, lines } = makeCli()
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
    const { run, lines } = makeCli()
    await run('new', 'listed task')
    lines.length = 0
    await run('tasks')
    expect(lines[0]).toContain('draft')
    expect(lines[0]).toContain('listed task')
  })
})
