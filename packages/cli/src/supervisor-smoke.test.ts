import { describe, expect, it } from 'bun:test'
// live end-to-end, one real model call: ORC_SUPERVISOR_SMOKE=1 bun run test:supervisor
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND } from '@orc/contracts'

const LIVE = process.env.ORC_SUPERVISOR_SMOKE === '1'

const CLI = path.join(import.meta.dir, 'bin.ts')
const MODEL = 'anthropic/claude-haiku-4-5'
const OUTPUT = 'notes.md'
const SPEC = `Write a file called ${OUTPUT} in the working directory with three bullet points on what durable execution means. Under 120 words. Declare ${OUTPUT} as an output.`

// a separate process that exits: auto-spawn and a run outliving its caller need the boundary
async function orc(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = Bun.spawn(['bun', CLI, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
  ])
  return { stdout, stderr, code }
}

describe.skipIf(!LIVE)('supervisor smoke', () => {
  it('a run outlives the command that asked for it', async () => {
    // an isolated project so the smoke test can never touch a real one, and `delete` can erase it
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-supervisor-'))
    const project = `smoke-${path.basename(dir)}`
    try {
      expect((await orc(dir, 'init', '--name', project)).code).toBe(0)
      const created = await orc(dir, 'new', 'supervisor smoke', '--spec', SPEC)
      const taskId = created.stdout.trim()
      expect(taskId).toMatch(/^[0-9a-f-]{36}$/)
      expect((await orc(dir, 'propose', taskId, '--model', MODEL)).code).toBe(0)
      expect((await orc(dir, 'approve', taskId)).code).toBe(0)

      // nothing is driving this project yet: the run below has to bring a supervisor into being
      expect((await orc(dir, 'serve', 'status')).stdout).toContain('no live supervisor')

      const run = await orc(dir, 'run', taskId, '--cwd', dir)
      expect([run.stdout.includes('run finished: done'), run.code]).toEqual([true, 0])

      // it asked; it never started a workflow of its own
      expect((await orc(dir, 'log', taskId)).stdout).toContain(EVENT_KIND.run_requested)
      // the step's declared output really landed, in the workspace the caller named
      expect(readFileSync(path.join(dir, OUTPUT), 'utf8').length).toBeGreaterThan(0)
      // THE property: that command has exited, and the runtime that ran it is still standing
      expect((await orc(dir, 'serve', 'status')).stdout).toMatch(/supervisor-\d+ {2}pid \d+/)
    } finally {
      await orc(dir, 'serve', 'stop')
      await orc(dir, 'delete', project, '--yes') // the events live in the shared database, not in dir
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
