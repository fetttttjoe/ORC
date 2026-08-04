import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The post-commit hook, pinned the same way scripts/commit-msg-hook.test.ts pins commit-msg:
 * Bun.spawn against a throwaway repo, assert on exit code / stdout / stderr — never against live
 * infra no other hook test here stands up.
 *
 * Two things this hook must NEVER do, both mechanically pinned:
 *   1. Print anything, or exit non-zero, when there is no `.orc` project to record into (the
 *      degrade-silently path — `.orc` absent is exactly what a throwaway `git init`-only repo is).
 *   2. Sit on the commit's critical path: the append (bun startup + a Postgres round-trip) is
 *      DETACHED, so the hook script itself must return fast regardless of whether the append
 *      would succeed or fail. A future change that makes the append synchronous should fail this
 *      test, not just quietly tax every commit in the repo.
 */
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

  // Pins the detach: the DB append (bun startup + a Postgres round-trip) must never sit on the
  // commit's critical path. A hook that made it synchronous would still pass the assertions above
  // eventually — but slowly — so this bound is the thing that would actually catch that regression.
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
