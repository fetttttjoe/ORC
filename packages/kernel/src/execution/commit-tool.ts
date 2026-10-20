import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { COMMIT_STEP_ID, ORC_CHAT_ID, STEP_ROLE, errorMessage, nonEmptyLines, sha256, toolError, type KnowledgeRef, type Origin, type ResolvedTool, NO_INPUT_SCHEMA } from '@orc/contracts'
import type { Kernel } from '../kernel'
import { subtreeUsage } from '../projections'
import { clipMiddle } from './clip'

// Two lines is the operator's history rule; the refusal names it so the agent repairs in one pass.
const CommitInput = z.object({
  message: z.string().min(1).max(5000).refine(
    m => m.split('\n').filter(l => l.trim() !== '').length <= 2,
    'commit message is at most two lines: a conventional-commit subject, plus one body line only when the subject cannot carry the WHY',
  ),
})

export type SuspectAt = (paths: string[]) => Promise<KnowledgeRef[]>

// `degraded`: a null field plus a reason here; omitted from the receipt when everything measured.
const STILL_DRIFTED_DEGRADED = 'stillDrifted unmeasured — knowledge is unavailable'
const stillDriftedFailed = (reason: string): string => `stillDrifted unmeasured — the drift read failed: ${reason}`

const PREVIEW_DESCRIPTION =
  "Compute THIS task's pending commit and return {paths, diff, skippedIgnored}: exactly what git_commit will commit (the scoped_changes floor — sibling tasks' work is excluded, gitignored paths are skipped and listed). Read the diff — your commit message must describe it. A file changed only by exec commands (formatters, codegen) is not in the floor and will be missing; say so in your summary if you know of one."

const COMMIT_DESCRIPTION =
  'Commit the previewed changes with your message. If the working tree no longer matches the diff you last saw (or you never looked), it refuses and returns the current diff — read it and call again. Commits by pathspec, so content someone else staged never rides along. Returns {commit, created, committedPaths, skippedIgnored, stillDrifted, degraded, usage}: created:false means nothing was left to commit (e.g. a child task already committed) and stillDrifted was still read. stillDrifted lists the claims this commit left suspect — a knowledge_check or a heal is owed; carry it into your summary verbatim. It is null when knowledge is unavailable. degraded lists why a measurement could not be made and is present ONLY when something is degraded — carry it into your summary verbatim too. usage is this task subtree\'s total cost so far (tokens in/out, cache read/write, costUSD) — carry it into your summary too.'

// head + tail per stream: enough diff to write an honest message, never an unbounded prompt
const CLIP_CHARS = 12_000
const clip = (s: string): string => clipMiddle(s, CLIP_CHARS)

interface Git { code: number; stdout: string; stderr: string }

// Literal pathspecs and unquoted paths, or recorded names misbehave (non-ASCII, ':(' magic).
async function git(dir: string, args: string[], opts?: { env?: Record<string, string>; literal?: boolean }): Promise<Git> {
  const argv = ['git', ...(opts?.literal === false ? [] : ['--literal-pathspecs']), '-c', 'core.quotePath=false', '-C', dir, ...args]
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', ...(opts?.env && { env: { ...process.env, ...opts.env } }) })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  return { code, stdout, stderr }
}

// `digest` hashes the UNCLIPPED diff, since clip() could mask a mid-diff change.
interface Staged { addable: string[]; paths: string[]; staged: string[]; diff: string; digest: string; skippedIgnored: string[] }

export function commitTool(opts: {
  kernel: Pick<Kernel, 'listTaskChangedPaths' | 'listTaskKnowledgeWrites' | 'state'>
  dir: string
  suspectAt?: SuspectAt
  p: { taskId: string; stepId: string; role: string; runToken: string; origin: Origin }
}): ResolvedTool[] {
  const { kernel, dir, suspectAt, p } = opts
  // both terms: the committer role is kernel-set, so a planner-authored 'commit' step never arms this
  if (p.stepId !== COMMIT_STEP_ID || p.role !== STEP_ROLE.committer) return []

  // The diff digest the agent last SAW; not durable, so a crash-resume re-refuses once.
  let seenDigest: string | null = null

  // Three memberships, since a pathspec matching nothing is an error: addable, paths, skippedIgnored.
  const floorSets = async (): Promise<{ addable: string[]; paths: string[]; skippedIgnored: string[] } | { error: string }> => {
    const [changed, knowledge] = await Promise.all([kernel.listTaskChangedPaths(p.taskId), kernel.listTaskKnowledgeWrites(p.taskId)])
    const floor = [...new Set([...changed.map(r => r.path), ...knowledge.files])]
    if (floor.length === 0) return { addable: [], paths: [], skippedIgnored: [] }
    const ignoreProbe = await git(dir, ['check-ignore', '--', ...floor], { literal: false })
    if (ignoreProbe.code > 1) return { error: `git check-ignore failed: ${ignoreProbe.stderr.trim()}` }
    const ignored = new Set(nonEmptyLines(ignoreProbe.stdout))
    const kept = floor.filter(f => !ignored.has(f))
    const inIndex = new Set(kept.length === 0 ? [] : nonEmptyLines((await git(dir, ['ls-files', '--', ...kept])).stdout))
    const headList = kept.length === 0 ? null : await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...kept])
    const inHead = new Set(headList && headList.code === 0 ? nonEmptyLines(headList.stdout) : []) // unborn HEAD = empty
    return {
      addable: kept.filter(f => inIndex.has(f) || existsSync(path.join(dir, f))),
      paths: kept.filter(f => inIndex.has(f) || inHead.has(f) || existsSync(path.join(dir, f))),
      skippedIgnored: floor.filter(f => ignored.has(f)),
    }
  }

  // realIndex:false uses a throwaway index, so a preview never clobbers a human's curated staging.
  const stagedDiff = async (realIndex: boolean): Promise<Staged | { error: string }> => {
    const sets = await floorSets()
    if ('error' in sets) return sets
    const { addable, paths, skippedIgnored } = sets
    if (paths.length === 0) return { addable, paths, staged: [], diff: '', digest: sha256(''), skippedIgnored }
    let scratch: string | null = null
    try {
      let env: Record<string, string> | undefined
      if (!realIndex) {
        scratch = mkdtempSync(path.join(tmpdir(), 'orc-commit-index-'))
        env = { GIT_INDEX_FILE: path.join(scratch, 'index') }
        const seed = await git(dir, ['read-tree', 'HEAD'], { env })
        if (seed.code !== 0) {
          const empty = await git(dir, ['read-tree', '--empty'], { env }) // unborn HEAD
          if (empty.code !== 0) return { error: `git read-tree failed: ${seed.stderr.trim()}` }
        }
      }
      if (addable.length > 0) {
        const add = await git(dir, ['add', '-A', '--', ...addable], { env })
        if (add.code !== 0) return { error: `git add failed: ${add.stderr.trim() || add.stdout.trim()}` }
      }
      const names = await git(dir, ['diff', '--cached', '--name-only', '--', ...paths], { env })
      if (names.code !== 0) return { error: `git diff failed: ${names.stderr.trim()}` }
      const diff = await git(dir, ['diff', '--cached', '--', ...paths], { env })
      if (diff.code !== 0) return { error: `git diff failed: ${diff.stderr.trim()}` }
      return { addable, paths, staged: nonEmptyLines(names.stdout), diff: clip(diff.stdout), digest: sha256(diff.stdout), skippedIgnored }
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    }
  }


  return [{
    ref: 'kernel/commit_preview', name: 'commit_preview',
    description: PREVIEW_DESCRIPTION,
    inputSchema: NO_INPUT_SCHEMA,
    execute: async () => {
      try {
        const s = await stagedDiff(false)
        if ('error' in s) return { output: { error: s.error }, isError: true }
        seenDigest = s.digest
        // observed live: an agent read the empty preview as license to skip git_commit entirely
        return { output: { paths: s.staged, diff: s.diff || '(no pending changes — nothing left to commit; STILL call git_commit with a message so stillDrifted is read)', skippedIgnored: s.skippedIgnored }, isError: false }
      } catch (err) {
        return toolError(err)
      }
    },
  }, {
    ref: 'kernel/git_commit', name: 'git_commit',
    description: COMMIT_DESCRIPTION,
    inputSchema: {
      type: 'object', required: ['message'],
      properties: { message: { type: 'string', description: 'the commit message, written from the previewed diff' } },
    },
    execute: async input => {
      const parsed = CommitInput.safeParse(input)
      if (!parsed.success) return { output: { error: `invalid git_commit input: ${errorMessage(parsed.error)}` }, isError: true }
      try {
        const fresh = await stagedDiff(false)
        if ('error' in fresh) return { output: { error: fresh.error }, isError: true }
        // the handshake: commit only seen content; a refusal delivers the diff and arms the retry
        if (seenDigest !== fresh.digest) {
          seenDigest = fresh.digest
          return {
            output: {
              error: 'the working tree does not match the diff you last saw — read this one, then call git_commit again with a message that describes it',
              paths: fresh.staged, diff: fresh.diff, skippedIgnored: fresh.skippedIgnored,
            }, isError: true,
          }
        }

        let created = false
        let committedPaths: string[] = []
        if (fresh.staged.length > 0) {
          const real = await stagedDiff(true) // stage the REAL index just before the commit
          if ('error' in real) return { output: { error: real.error }, isError: true }
          // pathspec commit: an entry someone else left in the shared index never rides along
          const commit = await git(dir, ['commit', '-m', parsed.data.message, '--', ...real.paths],
            p.origin.chatId === null ? undefined : { env: { [ORC_CHAT_ID]: p.origin.chatId } })
          if (commit.code !== 0) return { output: { error: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` }, isError: true }
          created = true
          const shown = await git(dir, ['show', '--name-only', '--format=', 'HEAD'])
          committedPaths = shown.code === 0 ? nonEmptyLines(shown.stdout) : real.staged
        }
        const head = await git(dir, ['rev-parse', 'HEAD'])
        if (head.code !== 0) return { output: { error: `cannot resolve HEAD: ${head.stderr.trim()}` }, isError: true }

        const usage = subtreeUsage(await kernel.state(), p.taskId)
        const degraded = suspectAt ? [] : [STILL_DRIFTED_DEGRADED]
        let stillDrifted: KnowledgeRef[] | null = null
        if (suspectAt) {
          try { stillDrifted = await suspectAt(committedPaths) } catch (err) { degraded.push(stillDriftedFailed(errorMessage(err))) }
        }
        return {
          output: {
            commit: head.stdout.trim(), created, committedPaths, skippedIgnored: fresh.skippedIgnored, stillDrifted,
            ...(degraded.length > 0 ? { degraded } : {}), usage,
          }, isError: false,
        }
      } catch (err) {
        return toolError(err)
      }
    },
  }]
}
