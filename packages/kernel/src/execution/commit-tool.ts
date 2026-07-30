import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { COMMIT_STEP_ID, STEP_ROLE, errorMessage, toolError, type ResolvedTool } from '@orc/contracts'
import type { Kernel } from '../kernel'
import type { CitingNotes } from './scoped-changes-tool'
import { clipMiddle } from './clip'

// The commit step's tool pair. commit_preview computes the exact content a commit would contain
// (against a TEMPORARY index — a preview is a look, never a stage) and returns its real diff;
// git_commit refuses whenever the tree no longer matches the last diff the agent saw, handing back
// the fresh one — so the message is proposed from the changes by construction, not by contract
// prose. After committing it restamps the notes this task wrote whose declared paths are fully
// committed at the new HEAD — the truthful replacement for drift.ts restampableNotes' corpus-wide
// guess. Not stampable = tracked changes pending, OR untracked content, OR a declared path with no
// content at HEAD at all; every git failure also falls toward NOT stamping, the opposite of
// drift's read-side rule, because a false current-stamp poisons the freshness gate while a skipped
// stamp costs one re-heal.
const CommitInput = z.object({ message: z.string().min(1).max(5000) })

// The write half of the restamp, injected by the composition root (memory's store.write with the
// step author) so this file never imports the memory plugin. Undefined = memory degraded.
export type RestampNote = (note: { id: string; scope: string }, idempotencyKey: string) => Promise<void>

const PREVIEW_DESCRIPTION =
  "Compute THIS task's pending commit and return {paths, diff, skippedIgnored}: exactly what git_commit will commit (the scoped_changes floor — sibling tasks' work is excluded, gitignored paths are skipped and listed). Read the diff — your commit message must describe it. A file changed only by exec commands (formatters, codegen) is not in the floor and will be missing; say so in your summary if you know of one."

const COMMIT_DESCRIPTION =
  'Commit the previewed changes with your message, then restamp the notes this task wrote whose declared paths are fully committed. If the working tree no longer matches the diff you last saw (or you never looked), it refuses and returns the current diff — read it and call again. Commits by pathspec, so content someone else staged never rides along. Returns {commit, created, committedPaths, restamped, skippedDirty, restampFailed, skippedIgnored, stillDrifted}: created:false means nothing was left to commit (e.g. a child task already committed) and the restamp still ran. A note under skippedDirty cites paths not provably committed (pending edits, untracked content, or nothing at HEAD) and stays drifted on purpose. stillDrifted lists notes citing committed paths that no step of this task verified — carry it into your summary verbatim.'

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

const lines = (s: string): string[] => s.split('\n').map(l => l.trim()).filter(l => l !== '')

// linear trim like drift.ts (a regex here is CodeQL-flagged polynomial on agent-authored input)
const trimSlashes = (p: string): string => {
  let end = p.length
  while (end > 0 && p[end - 1] === '/') end -= 1
  return p.slice(0, end)
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

// What one staging pass concluded. `digest` fingerprints the UNCLIPPED diff — clip() could mask a
// mid-diff change — and is what the preview↔commit handshake compares.
interface Staged { addable: string[]; paths: string[]; staged: string[]; diff: string; digest: string; skippedIgnored: string[] }

export function commitTool(opts: {
  kernel: Pick<Kernel, 'listTaskChangedPaths' | 'listTaskNoteWrites'>
  dir: string
  restamp?: RestampNote
  // The citing-notes join (scoped-changes-tool's CitingNotes, injected in runtime.ts like restamp):
  // powers the receipt's stillDrifted honesty line — notes citing committed paths that no step of
  // this task verified, which would otherwise sit stale-stamped and silent until the next drift scan.
  citing?: CitingNotes
  p: { taskId: string; stepId: string; role: string; runToken: string }
}): ResolvedTool[] {
  const { kernel, dir, restamp, citing, p } = opts
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
    const floor = [...new Set((await kernel.listTaskChangedPaths(p.taskId)).map(r => r.path))]
    if (floor.length === 0) return { addable: [], paths: [], skippedIgnored: [] }
    const ignoreProbe = await git(dir, ['check-ignore', '--', ...floor], { literal: false })
    if (ignoreProbe.code > 1) return { error: `git check-ignore failed: ${ignoreProbe.stderr.trim()}` }
    const ignored = new Set(lines(ignoreProbe.stdout))
    const kept = floor.filter(f => !ignored.has(f))
    const inIndex = new Set(kept.length === 0 ? [] : lines((await git(dir, ['ls-files', '--', ...kept])).stdout))
    const headList = kept.length === 0 ? null : await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...kept])
    const inHead = new Set(headList && headList.code === 0 ? lines(headList.stdout) : []) // unborn HEAD = empty
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
      return { addable, paths, staged: lines(names.stdout), diff: clip(diff.stdout), digest: sha256(diff.stdout), skippedIgnored }
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true })
    }
  }

  // A touched note may be stamped only when every declared path is provably committed: no pending
  // tracked change, no untracked content, and actual content at HEAD (a typo'd or never-committed
  // path must read dirty forever, not clean forever). Returns the dirty evidence per skipped note.
  const notStampable = async (declared: readonly string[]): Promise<string[] | null> => {
    const paths = declared.map(trimSlashes).filter(p => p !== '')
    if (paths.length === 0) return [...declared] // nothing checkable — never stamp
    const pending = await git(dir, ['diff', '--name-only', 'HEAD', '--', ...paths])
    if (pending.code !== 0) return null // git cannot answer → unknown → not stamped
    const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard', '--', ...paths])
    if (untracked.code !== 0) return null
    const atHead = await git(dir, ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...paths])
    if (atHead.code !== 0) return null
    const entries = lines(atHead.stdout)
    const uncovered = paths.filter(p => !entries.some(e => e === p || e.startsWith(`${p}/`)))
    const dirty = [...new Set([...lines(pending.stdout), ...lines(untracked.stdout), ...uncovered])]
    return dirty
  }

  const restampTouched = async (): Promise<{
    restamped: { id: string; scope: string }[]
    skippedDirty: { id: string; scope: string; dirtyPaths: string[] }[]
    restampFailed: { id: string; scope: string; error: string }[]
  }> => {
    const restamped: { id: string; scope: string }[] = []
    const skippedDirty: { id: string; scope: string; dirtyPaths: string[] }[] = []
    const restampFailed: { id: string; scope: string; error: string }[] = []
    for (const n of await kernel.listTaskNoteWrites(p.taskId)) {
      const dirty = await notStampable(n.paths)
      if (dirty === null) continue
      if (dirty.length > 0) { skippedDirty.push({ id: n.id, scope: n.scope, dirtyPaths: dirty }); continue }
      if (!restamp) continue
      try {
        await restamp({ id: n.id, scope: n.scope }, `${p.runToken}:restamp:${n.scope}:${n.id}`)
        restamped.push({ id: n.id, scope: n.scope })
      } catch (err) {
        // the commit already exists; a read-model hiccup on one note must not report it as failed
        restampFailed.push({ id: n.id, scope: n.scope, error: errorMessage(err) })
      }
    }
    return { restamped, skippedDirty, restampFailed }
  }

  return [{
    ref: 'kernel/commit_preview', name: 'commit_preview',
    description: PREVIEW_DESCRIPTION,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => {
      try {
        const s = await stagedDiff(false)
        if ('error' in s) return { output: { error: s.error }, isError: true }
        seenDigest = s.digest
        // observed live: an agent read the empty preview as license to skip git_commit entirely,
        // silently skipping the restamp pass that the created:false path exists to run
        return { output: { paths: s.staged, diff: s.diff || '(no pending changes — nothing left to commit; STILL call git_commit with a message so the note restamp runs)', skippedIgnored: s.skippedIgnored }, isError: false }
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
          const commit = await git(dir, ['commit', '-m', parsed.data.message, '--', ...real.paths])
          if (commit.code !== 0) return { output: { error: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` }, isError: true }
          created = true
          const shown = await git(dir, ['show', '--name-only', '--format=', 'HEAD'])
          committedPaths = shown.code === 0 ? lines(shown.stdout) : real.staged
        }
        const head = await git(dir, ['rev-parse', 'HEAD'])
        if (head.code !== 0) return { output: { error: `cannot resolve HEAD: ${head.stderr.trim()}` }, isError: true }

        const notes = await restampTouched()
        // Leftovers = citing notes minus every task-written set (restamped ∪ skippedDirty ∪
        // restampFailed — those are already reported under their own keys). null when the join is
        // absent: a missing measurement must never read as a clean zero.
        const own = new Set([...notes.restamped, ...notes.skippedDirty, ...notes.restampFailed].map(n => `${n.scope}:${n.id}`))
        const cited = citing ? await citing(committedPaths) : null
        const stillDrifted = cited ? cited.filter(n => !own.has(`${n.scope}:${n.id}`)).map(n => ({ id: n.id, scope: n.scope })) : null
        return {
          output: {
            commit: head.stdout.trim(), created, committedPaths, skippedIgnored: fresh.skippedIgnored, ...notes, stillDrifted,
            ...(restamp ? {} : { restampUnavailable: 'memory is degraded — no note was restamped; run `orc memory restamp` once memory is back' }),
          }, isError: false,
        }
      } catch (err) {
        return toolError(err)
      }
    },
  }]
}
