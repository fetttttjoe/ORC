// The ONE place orc shells to git for checkout facts: branch, cleanliness, worktree lifecycle, the
// default (trunk) branch, whether a commit has landed on trunk (and the merge that lands it), and
// the revision the runtime is running against. (Not the only place the
// kernel spawns git at all — execution/tree-fingerprint.ts and execution/commit-tool.ts still do
// their own spawns for tree-fingerprinting and committing — but the only one for these checkout
// facts, so `orc ws` (a worktree per request) and boot-time workspace adoption share a single seam
// instead of each shelling out on its own.) Every function returns null / false rather than
// throwing — "not a git repo" is an ordinary answer for `orc` run in a plain directory, not an
// error. Most probes here are synchronous on purpose: loadConfig is sync and is the first thing
// every entry point runs, so an async probe on that path would make the whole config loader async
// for one call. `gitRevision` is the one exception — it was written async for the memory plugin's
// `sourceRevision` thunk, whose callers already `await` it, and making it sync now would change
// nothing observable, so it stays as measured rather than "fixed" to match the rest of the file.

// The ONE spawn; every probe in this file is a view of it. Raw (exit code plus BOTH streams)
// because the views genuinely disagree about what carries the answer: `git()` reads stdout,
// `gitResult()` reads stderr, `isAncestor` reads the exit code alone (1 is git's "no", anything
// else is "cannot tell"), and `mergeBranch` needs stdout — a merge conflict prints "CONFLICT …
// Automatic merge failed" to STDOUT and leaves stderr EMPTY (measured), so a stderr-only refusal
// would be blank exactly when the operator has a half-merged tree to deal with. `code: null` is
// git itself missing — no exit code was ever produced.
function spawnGit(dir: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const decoder = new TextDecoder()
  try {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode, stdout: decoder.decode(r.stdout).trim(), stderr: decoder.decode(r.stderr).trim() }
  } catch (err) {
    return { code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

function git(dir: string, ...args: string[]): string | null {
  const r = spawnGit(dir, args)
  return r.code === 0 ? r.stdout : null
}

// `--git-dir` and `--git-common-dir` in one spawn: EQUAL for a main checkout (even run from a
// subdirectory), a submodule, and a bare repo; DIFFERENT only for a linked worktree, where
// `--git-dir` points under the main checkout's `.git/worktrees/<name>` and `--git-common-dir` at
// the shared `.git`. That equality/inequality is the exact signal project-root.ts's
// resolveProjectRoot needs. Both lines may be printed relative to `dir` (git resolves them from
// the queried directory, not from any repo root) — the caller resolves them. Null outside git.
export function gitDirs(dir: string): { gitDir: string; commonDir: string } | null {
  const out = git(dir, 'rev-parse', '--git-dir', '--git-common-dir')
  if (out === null) return null
  const [gitDir, commonDir] = out.split('\n')
  if (gitDir === undefined || commonDir === undefined) return null
  return { gitDir, commonDir }
}

// The root of the checkout `dir` sits in — for a linked worktree the WORKTREE's own root, not the
// main checkout, which is what "which directory is this repo" means to the caller standing in one.
// (`gitDirs` above is the probe for the other question: main checkout or linked worktree.) Git
// resolves symlinks in this answer, so it can differ textually from the path handed in. Null
// outside git, per this file's rule.
export function gitToplevel(dir: string): string | null {
  return git(dir, 'rev-parse', '--show-toplevel')
}

type GitResult = { ok: true } | { ok: false; error: string }

function gitResult(dir: string, ...args: string[]): GitResult {
  const r = spawnGit(dir, args)
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr }
}

export function currentBranch(dir: string): string | null {
  const out = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
  return out === null || out === 'HEAD' ? null : out // 'HEAD' is git's spelling of detached
}

// git's own `status --porcelain` block: one line per modified, staged or untracked path, '' when
// the tree is clean, null when `dir` is not a checkout (never was, or has since been removed).
// Exported rather than kept behind `isClean` because every refusal that blocks on a dirty tree has
// to name WHAT would be lost — a boolean cannot — and because "gone" and "clean" are different
// answers to a caller deciding whether it may still act on that directory.
export function dirtyPaths(dir: string): string | null {
  return git(dir, 'status', '--porcelain')
}

// `status --porcelain` is empty exactly when nothing is modified, staged or untracked — the
// precondition for `worktree remove`, which would otherwise discard uncommitted work.
export function isClean(dir: string): boolean | null {
  const out = dirtyPaths(dir)
  return out === null ? null : out === ''
}

export function worktreeAdd(projectRoot: string, dest: string, branch: string, base: string): GitResult {
  return gitResult(projectRoot, 'worktree', 'add', '-b', branch, dest, base)
}

// Never `--force`: the refusal names the dirty paths so the operator sees WHAT would be lost.
// The check is ours, not git's — git's refusal message does not list the files.
export function worktreeRemove(projectRoot: string, dest: string): GitResult {
  const status = dirtyPaths(dest)
  if (status === null) return { ok: false, error: `${dest} is not a git worktree` }
  if (status !== '') return { ok: false, error: `worktree has uncommitted changes:\n${status}` }
  return gitResult(projectRoot, 'worktree', 'remove', dest)
}

// The other half of undoing a `worktree add`: removing the tree leaves the branch it created
// behind, pointing at the base commit, and a retry of the same request then dies on "branch already
// exists". Force (`-D`), not `-d`: the branch is being rolled back precisely because the record that
// would give it meaning was never written, so "not merged anywhere" is the expected state, not a
// reason to keep it. Git refuses while the branch is checked out in a worktree, so a caller
// compensating a half-done create removes the worktree FIRST — that refusal is pinned in git.test.ts.
export function branchDelete(projectRoot: string, branch: string): GitResult {
  return gitResult(projectRoot, 'branch', '-D', branch)
}

// `git symbolic-ref --short refs/remotes/origin/HEAD` prints e.g. `origin/main`; strip everything
// up to and including the first `/` to get the trunk name generically (works for any remote name,
// not just `origin`). Null when unset (a repo with no remote, or one nobody ran `git remote set-
// head` on) or outside git. The trunk name is captured once, at workspace adoption (spec: "Trunk"),
// so this probe is the ONE source of the default — a hard-coded `'main'` fallback belongs in the
// caller that has no captured value yet, not here.
export function defaultBranch(dir: string): string | null {
  const out = git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  if (out === null) return null
  const slash = out.indexOf('/')
  return slash === -1 ? out : out.slice(slash + 1)
}

// The commit a ref names, or null when the ref is unknown (git exits 128) or `dir` is not a repo.
// `--verify` is what makes the null truthful: a plain `rev-parse <name>` also exits non-zero here,
// but --verify is the form that guarantees the answer is ONE revision, so a caller can record what
// comes back as "the commit" without checking it again.
export function revParse(dir: string, ref: string): string | null {
  return git(dir, 'rev-parse', '--verify', ref)
}

// Is `tip` contained in `trunk` — i.e. has that work already landed? THREE answers, not two:
// `merge-base --is-ancestor` exits 0 for yes, 1 for no, and 128 when it cannot tell (an unknown
// ref, or no repository at all — measured). Conflating 128 with "no" would make `orc ws finalize`
// refuse a typo'd or deleted branch with "not merged yet", sending the operator to merge something
// that does not exist; null makes the caller say which question went unanswered.
export function isAncestor(dir: string, tip: string, trunk: string): boolean | null {
  const r = spawnGit(dir, ['merge-base', '--is-ancestor', tip, trunk])
  if (r.code === 0) return true
  return r.code === 1 ? false : null
}

// WHY a merge was refused, as a value the caller can branch on. `orc ws merge` has to tell ONE of
// these apart from the rest — `alreadyContained` is the state where git has nothing left to do but
// orc may still have a fact to record, so it sends the operator to `orc ws finalize` while every
// other refusal is simply reported. Matching on the message text instead would break silently the
// first time a sentence here is improved.
export const MERGE_REFUSAL = {
  notRepo: 'not-repo',
  wrongBranch: 'wrong-branch',
  mergeInProgress: 'merge-in-progress',
  dirty: 'dirty',
  conflict: 'conflict',
  alreadyContained: 'already-contained',
  headUnreadable: 'head-unreadable',
} as const
export type MergeRefusal = (typeof MERGE_REFUSAL)[keyof typeof MERGE_REFUSAL]
export type MergeOutcome = { ok: true; mergeCommit: string } | { ok: false; reason: MergeRefusal; error: string }

// Land a workspace's branch on trunk, in the checkout at `projectRoot`, and name the commit that
// did it. `--no-ff` even when a fast-forward is possible: the landing has to be ONE addressable
// commit for `workspace_merged` to point at (and for the commit reactor to restamp at) — a
// fast-forward would leave nothing to name but the branch tip, which is not a fact about trunk.
//
// Every refusal happens BEFORE git is asked to change anything, and names what it would have cost:
// the dirty-trunk check lists the paths (git's own refusal does not), because those are the
// operator's uncommitted files and a merge would carry them into the merge commit.
export function mergeBranch(projectRoot: string, branch: string, trunk: string): MergeOutcome {
  const dirty = dirtyPaths(projectRoot)
  if (dirty === null) return { ok: false, reason: MERGE_REFUSAL.notRepo, error: `${projectRoot} is not a git checkout` }
  const on = currentBranch(projectRoot)
  if (on !== trunk)
    return { ok: false, reason: MERGE_REFUSAL.wrongBranch, error: `${projectRoot} is on ${on ?? 'a detached HEAD'}, not ${trunk} — check ${trunk} out there before merging ${branch}` }
  if (dirty !== '') {
    // A tree left mid-merge is dirty too, and its way out is the OPPOSITE one: not "commit your
    // work" but "finish or abandon the merge that is already running". `MERGE_HEAD` exists exactly
    // between a conflicted merge and its resolution, and asking git for it works in a linked
    // worktree too, where `.git` is a file and there is no `.git/MERGE_HEAD` path to stat.
    if (revParse(projectRoot, 'MERGE_HEAD') !== null)
      return { ok: false, reason: MERGE_REFUSAL.mergeInProgress, error: `a merge is already in progress in ${projectRoot}:\n${dirty}\nfinish it (resolve the conflicts and commit) or undo it with: git -C ${projectRoot} merge --abort` }
    return { ok: false, reason: MERGE_REFUSAL.dirty, error: `${trunk} has uncommitted changes:\n${dirty}` }
  }
  const before = revParse(projectRoot, 'HEAD')
  const merged = spawnGit(projectRoot, ['merge', '--no-ff', '--no-edit', branch])
  if (merged.code !== 0) {
    const report = [merged.stdout, merged.stderr].filter(s => s !== '').join('\n')
    // Deliberately NOT `merge --abort`: a conflict is a decision, and throwing the operator's
    // half-resolved tree away to keep this function tidy would destroy work. Say where they are
    // and name both ways out.
    return { ok: false, reason: MERGE_REFUSAL.conflict, error: `merging ${branch} into ${trunk} failed:\n${report}\nthe tree is left mid-merge — resolve and commit, or undo with: git -C ${projectRoot} merge --abort` }
  }
  const after = revParse(projectRoot, 'HEAD')
  if (after === null) return { ok: false, reason: MERGE_REFUSAL.headUnreadable, error: `${branch} merged into ${trunk}, but HEAD could not be read in ${projectRoot}` }
  // Measured: merging an already-contained branch prints "Already up to date", exits 0 and commits
  // NOTHING. HEAD then still names the earlier merge, and returning it would record that commit a
  // second time as if this call had landed something. The caller decides what to do about it — for
  // `orc ws merge` this is the one refusal with a different door (`orc ws finalize`), because git
  // having nothing to do does not mean orc has nothing to record.
  if (after === before) return { ok: false, reason: MERGE_REFUSAL.alreadyContained, error: `${branch} is already contained in ${trunk} — git merged nothing, so there is no merge commit to record` }
  return { ok: true, mergeCommit: after }
}

// the actual revision of the code the runtime is looking at — null outside Git
export async function gitRevision(dir: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', '-C', dir, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? out.trim() : null
  } catch {
    return null
  }
}
