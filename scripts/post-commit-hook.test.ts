import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Bun.spawn against a throwaway repo: asserts exit code and output, never live infra */
const HOOK = path.join(import.meta.dir, 'hooks', 'post-commit')
const FAST_BOUND_MS = 300

async function git(dir: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with ${code}`)
}

async function makeRepoWithOneCommit(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'orc-post-commit-hook-'))
  await git(dir, ['init', '--quiet'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'user.name', 'Test'])
  await Bun.write(path.join(dir, 'a.txt'), 'hello\n')
  await git(dir, ['add', 'a.txt'])
  await git(dir, ['commit', '--quiet', '-m', 'chore(test): seed commit'])
  return dir
}

interface Run {
  code: number
  stdout: string
  stderr: string
  ms: number
}

async function runHook(dir: string): Promise<Run> {
  const start = performance.now()
  const proc = Bun.spawn(['sh', HOOK], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  const ms = performance.now() - start
  return { code, stdout, stderr, ms }
}

describe('the post-commit hook degrades silently with no .orc project', () => {
  it('exits 0 with empty stdout and stderr', async () => {
    const dir = await makeRepoWithOneCommit()
    try {
      const run = await runHook(dir)
      expect(run.code).toBe(0)
      expect(run.stdout).toBe('')
      expect(run.stderr).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // a synchronous append would still pass the assertions above, only slowly; this bound catches it
  it('returns fast — the append is detached off the commit critical path', async () => {
    const dir = await makeRepoWithOneCommit()
    try {
      const run = await runHook(dir)
      expect(run.ms).toBeLessThan(FAST_BOUND_MS)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
