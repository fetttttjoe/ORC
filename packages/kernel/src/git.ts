// the ONE seam for checkout facts; probes return null or false rather than throwing

import { errorMessage } from '@orc/contracts'

// raw (code plus both streams): a merge conflict prints to STDOUT and leaves stderr empty
function spawnGit(dir: string, args: string[]): { code: number | null; stdout: string; stderr: string } {
  const decoder = new TextDecoder()
  try {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode, stdout: decoder.decode(r.stdout).trim(), stderr: decoder.decode(r.stderr).trim() }
  } catch (err) {
    return { code: null, stdout: '', stderr: errorMessage(err) }
  }
}

function git(dir: string, ...args: string[]): string | null {
  const r = spawnGit(dir, args)
  return r.code === 0 ? r.stdout : null
}

// both lines may be relative to `dir`; the caller resolves them; null outside git
export function gitDirs(dir: string): { gitDir: string; commonDir: string } | null {
  const out = git(dir, 'rev-parse', '--git-dir', '--git-common-dir')
  if (out === null) return null
  const [gitDir, commonDir] = out.split('\n')
  if (gitDir === undefined || commonDir === undefined) return null
  return { gitDir, commonDir }
}

// the checkout's own root, a linked worktree's included; git resolves symlinks in the answer
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

// exported, not behind isClean: refusals must name WHAT would be lost; null means gone
export function dirtyPaths(dir: string): string | null {
  return git(dir, 'status', '--porcelain')
}

// empty exactly when nothing is modified, staged or untracked: `worktree remove` needs it
export function isClean(dir: string): boolean | null {
  const out = dirtyPaths(dir)
  return out === null ? null : out === ''
}

export function worktreeAdd(projectRoot: string, dest: string, branch: string, base: string): GitResult {
  return gitResult(projectRoot, 'worktree', 'add', '-b', branch, dest, base)
}

// never --force: git's refusal lists no files, so the dirty-path check here names what is lost
export function worktreeRemove(projectRoot: string, dest: string): GitResult {
  const status = dirtyPaths(dest)
  if (status === null) return { ok: false, error: `${dest} is not a git worktree` }
  if (status !== '') return { ok: false, error: `worktree has uncommitted changes:\n${status}` }
  return gitResult(projectRoot, 'worktree', 'remove', dest)
}

// force -D: a rolled-back branch is unmerged by definition; remove the worktree FIRST
export function branchDelete(projectRoot: string, branch: string): GitResult {
  return gitResult(projectRoot, 'branch', '-D', branch)
}

// strips through the first `/` so any remote name works; null when unset or outside git
export function defaultBranch(dir: string): string | null {
  const out = git(dir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
  if (out === null) return null
  const slash = out.indexOf('/')
  return slash === -1 ? out : out.slice(slash + 1)
}

// --verify guarantees ONE revision, so the caller can record the answer as 'the commit'
export function revParse(dir: string, ref: string): string | null {
  return git(dir, 'rev-parse', '--verify', ref)
}

// three answers: exit 128 means cannot tell, and reading it as 'no' blames a typo'd branch
export function isAncestor(dir: string, tip: string, trunk: string): boolean | null {
  const r = spawnGit(dir, ['merge-base', '--is-ancestor', tip, trunk])
  if (r.code === 0) return true
  return r.code === 1 ? false : null
}

// a value, not message text: `alreadyContained` sends `orc ws merge` to `orc ws finalize`
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

// --no-ff: the landing must be ONE addressable commit for workspace_merged to name
export function mergeBranch(projectRoot: string, branch: string, trunk: string): MergeOutcome {
  const dirty = dirtyPaths(projectRoot)
  if (dirty === null) return { ok: false, reason: MERGE_REFUSAL.notRepo, error: `${projectRoot} is not a git checkout` }
  const on = currentBranch(projectRoot)
  if (on !== trunk)
    return { ok: false, reason: MERGE_REFUSAL.wrongBranch, error: `${projectRoot} is on ${on ?? 'a detached HEAD'}, not ${trunk} — check ${trunk} out there before merging ${branch}` }
  if (dirty !== '') {
    // MERGE_HEAD marks a mid-merge tree, whose way out is finishing the merge, not committing
    if (revParse(projectRoot, 'MERGE_HEAD') !== null)
      return { ok: false, reason: MERGE_REFUSAL.mergeInProgress, error: `a merge is already in progress in ${projectRoot}:\n${dirty}\nfinish it (resolve the conflicts and commit) or undo it with: git -C ${projectRoot} merge --abort` }
    return { ok: false, reason: MERGE_REFUSAL.dirty, error: `${trunk} has uncommitted changes:\n${dirty}` }
  }
  const before = revParse(projectRoot, 'HEAD')
  const merged = spawnGit(projectRoot, ['merge', '--no-ff', '--no-edit', branch])
  if (merged.code !== 0) {
    const report = [merged.stdout, merged.stderr].filter(s => s !== '').join('\n')
    // deliberately NOT `merge --abort`: it would destroy the operator's half-resolved tree
    return { ok: false, reason: MERGE_REFUSAL.conflict, error: `merging ${branch} into ${trunk} failed:\n${report}\nthe tree is left mid-merge — resolve and commit, or undo with: git -C ${projectRoot} merge --abort` }
  }
  const after = revParse(projectRoot, 'HEAD')
  if (after === null) return { ok: false, reason: MERGE_REFUSAL.headUnreadable, error: `${branch} merged into ${trunk}, but HEAD could not be read in ${projectRoot}` }
  // an already-contained merge exits 0 and commits nothing; HEAD would name the earlier merge
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
