import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { COMMIT_STEP_ID, STEP_ROLE, errorMessage, noteKey, toolError, type ResolvedTool } from '@orc/contracts'
import type { Kernel } from '../kernel'
import { subtreeUsage } from '../projections'
import type { CitingNotes } from './scoped-changes-tool'
import { clipMiddle } from './clip'

// The commit step's tool pair. commit_preview computes the exact content a commit would contain
// (against a TEMPORARY index — a preview is a look, never a stage) and returns its real diff;
// git_commit refuses whenever the tree no longer matches the last diff the agent saw, handing back
// the fresh one — so the message is proposed from the changes by construction, not by contract
// prose. After committing it advances the stamps this task EARNED at the new HEAD — the truthful
// replacement for drift.ts restampableNotes' corpus-wide guess. Earned, not written: a note the
// task healed (rewrote prose that already existed) gets its source stamp restamped, a note a step
// declared verified gets its verification stamp advanced — but only while no commit has touched its
// cited paths since that audit — and a note the task merely authored gets neither: it is named in
// stillDrifted instead. Not stampable = tracked changes pending, OR untracked content, OR a declared
// path with no content at HEAD at all; every git failure also falls toward NOT stamping, the
// opposite of drift's read-side rule, because a false current-stamp poisons the freshness gate while
// a skipped stamp costs one re-heal.
const CommitInput = z.object({ message: z.string().min(1).max(5000) })

// The write half of a stamp pass, injected by the composition root so this file never imports the
// memory plugin: `restamp` is memory's store.write with the step author, `reverify` its store.verify.
// One type because the seam is identical — a note ref plus an idempotency key, because both run
// inside an at-least-once operation. Undefined = memory degraded.
export type StampNote = (note: { id: string; scope: string }, idempotencyKey: string) => Promise<void>

// The `degraded` convention: an absent measurement is `null` in its own field PLUS a reason here,
// and the `degraded` key itself is omitted from the receipt when everything measured — never a
// one-off bespoke key per absence (this file used to mint one just for the missing restamp) and
// never prose folded into another field (scoped-changes-tool's `floor` did that). Motivating
// failure: a consumer grepping for "degraded" must never miss an absence spelled a different way.
const RESTAMP_DEGRADED = 'restamp unavailable — memory is degraded; run `orc memory restamp` once memory is back'
// Its own reason, not folded into the restamp's: the repairs differ. A missed restamp is fixed by
// re-running the restamp; a missed reverify needs an auditor to declare the note verified again.
const REVERIFY_DEGRADED = 'reverify unavailable — memory is degraded; notes this task verified keep their pre-commit stamp'
const STILL_DRIFTED_DEGRADED = 'stillDrifted unmeasured — citing-notes join unavailable (memory degraded)'

const PREVIEW_DESCRIPTION =
  "Compute THIS task's pending commit and return {paths, diff, skippedIgnored}: exactly what git_commit will commit (the scoped_changes floor — sibling tasks' work is excluded, gitignored paths are skipped and listed). Read the diff — your commit message must describe it. A file changed only by exec commands (formatters, codegen) is not in the floor and will be missing; say so in your summary if you know of one."

const COMMIT_DESCRIPTION =
  'Commit the previewed changes with your message, then advance the note stamps this task earned: notes it HEALED (rewrote prose that already existed) are restamped, notes a step DECLARED verified are reverified at the new commit — both only when their declared paths are fully committed, and a verification only while no commit has touched those paths since the audit. A note the task merely wrote for the first time earns no stamp; it appears in stillDrifted. If the working tree no longer matches the diff you last saw (or you never looked), it refuses and returns the current diff — read it and call again. Commits by pathspec, so content someone else staged never rides along. Returns {commit, created, committedPaths, restamped, skippedDirty, restampFailed, reverified, reverifyFailed, reverifyStale, skippedIgnored, stillDrifted, degraded, usage}: created:false means nothing was left to commit (e.g. a child task already committed) and the stamp pass still ran. A note under skippedDirty cites paths not provably committed (pending edits, untracked content, or nothing at HEAD) and stays drifted on purpose. A note under reverifyStale was verified against a tree that has since moved — a commit touched its cited paths after the audit (or the audited revision is unreachable) — so its verification was NOT advanced and an auditor must read it again. stillDrifted lists notes citing committed paths that no step of this task verified — carry it into your summary verbatim. degraded lists why a measurement could not be made (memory unavailable for a stamp write or the citing join) and is present ONLY when something is degraded — carry it into your summary verbatim too. usage is this task subtree\'s total cost so far (tokens in/out, cache read/write, costUSD) — carry it into your summary too.'

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

// What git can be ASKED about a note's declared paths: a note may cite 'src/' or 'src'. An empty
// entry is not a pathspec (git rejects one, and an argv slot that vanished would silently widen the
// question to the whole tree), so every path gate — the dirty check and the reverify range diff —
// resolves its pathspecs through here rather than each trimming its own way.
const checkable = (declared: readonly string[]): string[] => declared.map(trimSlashes).filter(p => p !== '')

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

// What one staging pass concluded. `digest` fingerprints the UNCLIPPED diff — clip() could mask a
// mid-diff change — and is what the preview↔commit handshake compares.
interface Staged { addable: string[]; paths: string[]; staged: string[]; diff: string; digest: string; skippedIgnored: string[] }

export function commitTool(opts: {
  kernel: Pick<Kernel, 'listTaskChangedPaths' | 'listTaskNoteWrites' | 'listTaskVerifiedNotes' | 'state'>
  dir: string
  restamp?: StampNote
  // The verification half: advances the verified stamp of the notes a step of this task DECLARED
  // verified (memory_verify) to the new HEAD. Within ONE task this completes a provisional stamp
  // truthfully — the auditor checked the worktree, the stamp named the old HEAD, and the commit is
  // what makes the two the same tree.
  // GATED, because across a subtree the dirty check says less than it looks like: it proves a note's
  // paths are COMMITTED, never that they are UNCHANGED SINCE THE AUDIT. The failure that motivates
  // the gate, observed: child A's auditor verifies note X citing a.ts; sibling B then changes a.ts
  // while X's own content stays put (so taskVerifiedNotes' carry rule correctly keeps the stamp);
  // the parent's commit reverified X at the new HEAD and excluded it from stillDrifted — X read
  // fresh against code nobody re-read. So the stamp advances only when NO commit between the stamp's
  // own revision and the revision this step's commit was built on — the tree the audit's worktree
  // became — touched the note's declared paths; anything else lands in reverifyStale (movedSinceAudit
  // below).
  // What the gate still cannot see: a WORKTREE edit made after the audit and swept into any later
  // commit of this task — git keeps no history for it, so it rides the stamp, exactly as the
  // provisional-stamp design already accepted. Closing that needs the audit to record a content
  // digest of the cited paths rather than a revision.
  reverify?: StampNote
  // The citing-notes join (scoped-changes-tool's CitingNotes, injected in runtime.ts like restamp):
  // powers the receipt's stillDrifted honesty line — notes citing committed paths that no step of
  // this task verified, which would otherwise sit stale-stamped and silent until the next drift scan.
  citing?: CitingNotes
  p: { taskId: string; stepId: string; role: string; runToken: string }
}): ResolvedTool[] {
  const { kernel, dir, restamp, reverify, citing, p } = opts
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
    const paths = checkable(declared)
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

  // What this task DECLARED about each note it touched, and the stamp each declaration earns.
  // Authorship is not one of them: writing a note says who typed it, never that it is true.
  // `verified` carries the stamp's own revision rather than a flag, so the strict gate below cannot
  // be reached without the tree the auditor actually read.
  interface Declared { id: string; scope: string; paths: string[]; healed: boolean; verified: { stampRevision: string } | null }

  // Has anything COMMITTED moved the note's cited paths since the auditor read them? `audited` is
  // the revision this step's commit was built on — the tree the audit's worktree became — so the
  // range covers exactly the commits the auditor never saw.
  // Every failure answers YES: a git that cannot resolve the stamp's revision (rebased away, shallow
  // clone) or cannot name the audited tree has not cleared the note, and a verification stamp is a
  // POSITIVE claim — an unanswerable question must never mint one.
  const movedSinceAudit = async (audited: string | null, stampRevision: string, paths: readonly string[]): Promise<boolean> => {
    if (audited === null) return true
    const moved = await git(dir, ['diff', '--name-only', `${stampRevision}..${audited}`, '--', ...checkable(paths)])
    return moved.code !== 0 || lines(moved.stdout).length > 0
  }

  const stampDeclared = async (audited: string | null): Promise<{
    restamped: { id: string; scope: string }[]
    skippedDirty: { id: string; scope: string; dirtyPaths: string[] }[]
    restampFailed: { id: string; scope: string; error: string }[]
    reverified: { id: string; scope: string }[]
    reverifyFailed: { id: string; scope: string; error: string }[]
    reverifyStale: { id: string; scope: string }[]
  }> => {
    const restamped: { id: string; scope: string }[] = []
    const skippedDirty: { id: string; scope: string; dirtyPaths: string[] }[] = []
    const restampFailed: { id: string; scope: string; error: string }[] = []
    const reverified: { id: string; scope: string }[] = []
    const reverifyFailed: { id: string; scope: string; error: string }[] = []
    const reverifyStale: { id: string; scope: string }[] = []

    // Merged by note, so a note this task both healed and verified is dirty-checked ONCE (four git
    // calls per note) and reported once per stamp it actually earned, never twice under skippedDirty.
    const declared = new Map<string, Declared>()
    for (const n of await kernel.listTaskNoteWrites(p.taskId)) {
      // THE RULE: only a heal — a write to a note that already existed — earns a restamp. A note
      // this task CREATED gets nothing: the write proved nothing about its truth, and stamping it
      // anyway is what let every ambient step note read verified-fresh without a reader. Such a
      // note is not silently dropped: it falls into stillDrifted below, which is the honest answer.
      if (!n.preexisting) continue
      declared.set(noteKey(n.scope, n.id), { id: n.id, scope: n.scope, paths: n.paths, healed: true, verified: null })
    }
    for (const n of await kernel.listTaskVerifiedNotes(p.taskId)) {
      const key = noteKey(n.scope, n.id)
      const seen = declared.get(key)
      const verified = { stampRevision: n.stampRevision }
      if (seen) seen.verified = verified
      else declared.set(key, { id: n.id, scope: n.scope, paths: n.paths, healed: false, verified })
    }

    for (const n of declared.values()) {
      const dirty = await notStampable(n.paths)
      if (dirty === null) continue
      // A verified note citing dirty paths must NOT be reverified either: the auditor checked a
      // worktree the commit did not capture, so a stamp at the new HEAD would name a tree nobody read.
      if (dirty.length > 0) { skippedDirty.push({ id: n.id, scope: n.scope, dirtyPaths: dirty }); continue }
      const ref = { id: n.id, scope: n.scope }
      if (n.healed && restamp) {
        try {
          await restamp(ref, `${p.runToken}:restamp:${n.scope}:${n.id}`)
          restamped.push(ref)
        } catch (err) {
          // the commit already exists; a read-model hiccup on one note must not report it as failed
          restampFailed.push({ ...ref, error: errorMessage(err) })
        }
      }
      if (n.verified && reverify) {
        // The strict gate, AFTER the dirty gate on purpose: a dirty note is already reported under
        // skippedDirty, and one note under two keys reads as two different problems.
        if (await movedSinceAudit(audited, n.verified.stampRevision, n.paths)) { reverifyStale.push(ref); continue }
        try {
          await reverify(ref, `${p.runToken}:reverify:${n.scope}:${n.id}`)
          reverified.push(ref)
        } catch (err) {
          reverifyFailed.push({ ...ref, error: errorMessage(err) })
        }
      }
    }
    return { restamped, skippedDirty, restampFailed, reverified, reverifyFailed, reverifyStale }
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
        // silently skipping the stamp pass (restamp AND reverify) that the created:false path exists to run
        return { output: { paths: s.staged, diff: s.diff || '(no pending changes — nothing left to commit; STILL call git_commit with a message so the note stamps run)', skippedIgnored: s.skippedIgnored }, isError: false }
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

        // The tree the auditor READ, named BEFORE this step moves HEAD. A verification stamp is
        // PROVISIONAL by construction (contracts' VerifiedStamp): the auditor checked the WORKTREE
        // while the stamp could only name HEAD, and this commit is what turns that worktree into a
        // tree. So the commits an auditor never saw are exactly the ones between their stamp and
        // this point — which is what the strict gate diffs against.
        // MEASURED, not assumed: ending the range at the POST-commit HEAD counts this task's own
        // commit as movement, so every note verified about the change being committed lands in
        // reverifyStale and `reverified` becomes unreachable — three pinned cases flipped. That gate
        // would have deleted the feature instead of tightening it.
        // Unborn HEAD (code !== 0) → null → nothing is reverified: no stamp can exist in a repo with
        // no commit (store.verify refuses without a readable HEAD), and unknown never stamps.
        const before = await git(dir, ['rev-parse', 'HEAD'])
        const audited = before.code === 0 ? before.stdout.trim() : null

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

        const notes = await stampDeclared(audited)
        // This task subtree's total spend so far, carried alongside the stamp results — additive,
        // never folded into `degraded`: a usage read failing is not one of that key's documented
        // absence cases (a stamp write or the citing join being unavailable), and coercing a failed
        // read to ZERO_USAGE would read as "this commit cost nothing", which is a lie a `null` would
        // not tell. So this is left UNGUARDED, same as every other kernel read in this function
        // (listTaskNoteWrites, listTaskVerifiedNotes above): if kernel.state() throws, the whole
        // tool call fails honestly via the try/catch below rather than reporting a false zero.
        const usage = subtreeUsage(await kernel.state(), p.taskId)
        // Leftovers = citing notes minus every note this task DECLARED something about (restamped ∪
        // skippedDirty ∪ restampFailed ∪ reverified ∪ reverifyFailed ∪ reverifyStale — each already
        // reported under its own key). The two *Failed sets belong here: the declaration happened,
        // only the stamp write did not, and naming the note twice would read as two different
        // problems. reverifyStale belongs for the same reason skippedDirty does: a reader of the
        // receipt already sees the note there, and knows something sharper than "still drifted" —
        // that a named audit went stale under a later commit. A note this
        // task merely WROTE is NOT here — that is the point of the honesty line. null when the join
        // is absent: a missing measurement must never read as a clean zero.
        const own = new Set([...notes.restamped, ...notes.skippedDirty, ...notes.restampFailed,
          ...notes.reverified, ...notes.reverifyFailed, ...notes.reverifyStale].map(n => noteKey(n.scope, n.id)))
        const cited = citing ? await citing(committedPaths) : null
        const stillDrifted = cited ? cited.filter(n => !own.has(noteKey(n.scope, n.id))).map(n => ({ id: n.id, scope: n.scope })) : null
        const degraded: string[] = [
          ...(restamp ? [] : [RESTAMP_DEGRADED]),
          ...(reverify ? [] : [REVERIFY_DEGRADED]),
          ...(citing ? [] : [STILL_DRIFTED_DEGRADED]),
        ]
        return {
          output: {
            commit: head.stdout.trim(), created, committedPaths, skippedIgnored: fresh.skippedIgnored, ...notes, stillDrifted,
            ...(degraded.length > 0 ? { degraded } : {}), usage,
          }, isError: false,
        }
      } catch (err) {
        return toolError(err)
      }
    },
  }]
}
