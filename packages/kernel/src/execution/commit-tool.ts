import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { COMMIT_STEP_ID, ORC_CHAT_ID, STEP_ROLE, errorMessage, nonEmptyLines, sha256, toolError, type KnowledgeRef, type Origin, type ResolvedTool, NO_INPUT_SCHEMA } from '@orc/contracts'
import type { Kernel } from '../kernel'
import { subtreeUsage } from '../projections'
import { clipMiddle } from './clip'

// The commit step's tool pair. commit_preview computes the exact content a commit would contain
// (against a TEMPORARY index — a preview is a look, never a stage) and returns its real diff;
// git_commit refuses whenever the tree no longer matches the last diff the agent saw, handing back
// the fresh one — so the message is proposed from the changes by construction, not by contract
// prose.
// Two non-empty lines is the operator's history rule (subject + at most one body line). Enforced
// here, not just in the committer skill's prose: the refusal names the rule, so the agent repairs
// in one iteration instead of guessing.
//
// The repo's commit-msg hook (scripts/hooks/commit-msg) refuses messages longer than two lines. A
// hook that rewrote long messages instead of refusing them left twenty commits cut at a 62–88
// character wrap boundary — silent truncation, not a committer writing a short body. `git commit`
// here does not pass --no-verify, so the refusal applies to this call and the hook's text is
// surfaced verbatim in the `git commit failed: …` error below.
const CommitInput = z.object({
  message: z.string().min(1).max(5000).refine(
    m => m.split('\n').filter(l => l.trim() !== '').length <= 2,
    'commit message is at most two lines: a conventional-commit subject, plus one body line only when the subject cannot carry the WHY',
  ),
})

export type SuspectAt = (paths: string[]) => Promise<KnowledgeRef[]>

// The `degraded` convention: an absent measurement is `null` in its own field PLUS a reason here,
// and the `degraded` key itself is omitted from the receipt when everything measured.
const STILL_DRIFTED_DEGRADED = 'stillDrifted unmeasured — knowledge is unavailable'
const stillDriftedFailed = (reason: string): string => `stillDrifted unmeasured — the drift read failed: ${reason}`

const PREVIEW_DESCRIPTION =
  "Compute THIS task's pending commit and return {paths, diff, skippedIgnored}: exactly what git_commit will commit (the scoped_changes floor — sibling tasks' work is excluded, gitignored paths are skipped and listed). Read the diff — your commit message must describe it. A file changed only by exec commands (formatters, codegen) is not in the floor and will be missing; say so in your summary if you know of one."

const COMMIT_DESCRIPTION =
  'Commit the previewed changes with your message. If the working tree no longer matches the diff you last saw (or you never looked), it refuses and returns the current diff — read it and call again. Commits by pathspec, so content someone else staged never rides along. Returns {commit, created, committedPaths, skippedIgnored, stillDrifted, degraded, usage}: created:false means nothing was left to commit (e.g. a child task already committed) and stillDrifted was still read. stillDrifted lists the claims this commit left suspect — a knowledge_check or a heal is owed; carry it into your summary verbatim. It is null when knowledge is unavailable. degraded lists why a measurement could not be made and is present ONLY when something is degraded — carry it into your summary verbatim too. usage is this task subtree\'s total cost so far (tokens in/out, cache read/write, costUSD) — carry it into your summary too.'

// per stream, head + tail, like exec-tool's clip: enough diff to write an honest message, never an
// unbounded prompt
const CLIP_CHARS = 12_000
const clip = (s: string): string => clipMiddle(s, CLIP_CHARS)

interface Git { code: number; stdout: string; stderr: string }

// --literal-pathspecs: floor paths and note paths are recorded strings; none may act as ':(...)'
// pathspec magic (check-ignore rejects the flag — measured — so it opts out). core.quotePath=false:
// git otherwise octal-escapes non-ASCII names in porcelain output and every exact-string membership
// set here silently misses them (measured: a deleted 'ü.ts' was not committed). Env inherited (and
// only extended, for the temp index) on purpose — git is operator infra (signing agents, config),
// not model-authored code; the model contributes only argv data.
async function git(dir: string, args: string[], opts?: { env?: Record<string, string>; literal?: boolean }): Promise<Git> {
  const argv = ['git', ...(opts?.literal === false ? [] : ['--literal-pathspecs']), '-c', 'core.quotePath=false', '-C', dir, ...args]
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', ...(opts?.env && { env: { ...process.env, ...opts.env } }) })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ])
  return { code, stdout, stderr }
}

// What one staging pass concluded. `digest` fingerprints the UNCLIPPED diff — clip() could mask a
// mid-diff change — and is what the preview↔commit handshake compares.
interface Staged { addable: string[]; paths: string[]; staged: string[]; diff: string; digest: string; skippedIgnored: string[] }

export function commitTool(opts: {
  kernel: Pick<Kernel, 'listTaskChangedPaths' | 'listTaskKnowledgeWrites' | 'state'>
  dir: string
  suspectAt?: SuspectAt
  p: { taskId: string; stepId: string; role: string; runToken: string; origin: Origin }
}): ResolvedTool[] {
  const { kernel, dir, suspectAt, p } = opts
  // both terms, like scoped_changes: the committer role is kernel-set (withCommitStep, enforced by
  // proposeSplit's reserved-role refusal), so a planner-authored step named 'commit' never arms this
  if (p.stepId !== COMMIT_STEP_ID || p.role !== STEP_ROLE.committer) return []

  // The diff digest the agent last SAW (set by commit_preview and by every refusal, which delivers
  // the same diff). git_commit commits only when the tree still matches it. Not durable: after a
  // crash-resume the journal replays recorded calls without executing, so the first fresh
  // git_commit re-refuses with the current diff — one extra iteration in a rare path, in exchange
  // for never committing content the agent has not seen.
  let seenDigest: string | null = null

  // The floor, resolved into what git can act on. Three memberships, because a pathspec matching
  // NOTHING is an error: `addable` (worktree or index — add's domain; tracked-but-deleted stays so
  // add -A stages the deletion), `paths` (adds HEAD-only — a deletion already staged by a prior
  // pass is gone from disk AND index, and dropping it from the commit pathspec silently uncommits
  // it), and `skippedIgnored` (gitignored-and-untracked — naming them to add makes it exit 1 and
  // would brick the step; check-ignore never reports tracked files, measured, so tracked-ignored
  // changes still commit).
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

  // Stage the floor and describe exactly what a commit would contain. realIndex:false runs against
  // a throwaway index seeded from HEAD, so a preview (or a refusal) can show untracked files and
  // deletions without clobbering a human's curated staging; only git_commit, immediately before
  // the commit that consumes it, touches the real index.
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
        // the handshake: commit only content the agent has seen. The refusal delivers the current
        // diff and arms the gate with it, so the immediate retry commits — no preview-tool detour,
        // no livelock — unless the tree moved again, which re-refuses with the newer diff.
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
          const real = await stagedDiff(true) // now stage the REAL index, right before the commit that consumes it
          if ('error' in real) return { output: { error: real.error }, isError: true }
          // pathspec commit: commits the named paths' content and nothing else, so an unrelated
          // entry someone left in the shared index can never ride along in this task's commit
          // the chat rides into git's own environment, so the hook that sees the commit can name
          // the interaction that made it; a chatless commit passes no key at all rather than ''
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
