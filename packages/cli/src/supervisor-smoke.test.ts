import { describe, expect, it } from 'bun:test'
// Live end-to-end through the real CLI, one real model call. Run explicitly:
//   ORC_SUPERVISOR_SMOKE=1 bun run test:supervisor
// Needs `bun run db:up` + a migrated database, and working anthropic auth — either path the
// provider accepts (ORC_ANTHROPIC_AUTH=oauth, or ANTHROPIC_API_KEY). Bun loads the repo's .env,
// and every process below inherits it, so setting it there is enough. The opt-in flag is the whole
// gate on purpose: which credentials count is the provider's rule, and a copy of it here would
// drift the moment that rule changes.
//
// What it pins is the property unit tests cannot reach, because it only exists across processes:
// `orc run` records an ask and exits, and the run is executed — and survives — somewhere else.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND } from '@orc/contracts'

const LIVE = process.env.ORC_SUPERVISOR_SMOKE === '1'

const CLI = path.join(import.meta.dir, 'bin.ts')
const MODEL = 'anthropic/claude-haiku-4-5'
const OUTPUT = 'notes.md'
const SPEC = `Write a file called ${OUTPUT} in the working directory with three bullet points on what durable execution means. Under 120 words. Declare ${OUTPUT} as an output.`

// The CLI as a user runs it: a separate process that exits. Driving it in-process would defeat the
// point — auto-spawn, and a run outliving its caller, are only observable across a process boundary.
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
