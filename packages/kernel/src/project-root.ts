import path from 'node:path'

// Where a checkout's PROJECT lives. Identity (.orc/identity.json) is gitignored and exists only in
// the main checkout, so a `git worktree add` produced a directory holding the tracked settings and
// no identity — `requireProject` then demanded `orc init`, which would have minted a NEW project
// and new databases for the same repository (observed in a Paseo worktree, 2026-09-14).
//
// Re-rooting EVERY directory inside a repository at its main checkout is too broad a rule, though:
// an orc project initialized in a SUBDIRECTORY of a repo (identity at
// `<repo>/apps/x/.orc/identity.json`) lost its identity under that rule, and `orc init` would have
// minted a duplicate at the repo root (measured, 2026-09-14). Git distinguishes the two cases
// exactly via `--git-dir` vs `--git-common-dir`: they are EQUAL for a main checkout (from any
// subdirectory), a submodule, and a bare repo — none of which should be re-rooted — and DIFFER only
// for a linked worktree, where `--git-dir` names the worktree's own `.git/worktrees/<name>` while
// `--git-common-dir` names the shared `.git`. That inequality, not "is there a git dir at all", is
// the precise signal. Pure over git's output so the case table is testable without a repository;
// the caller (git.ts's gitDirs) supplies the probe.
export function resolveProjectRoot(dir: string, dirs: { gitDir: string; commonDir: string } | null): string {
  if (dirs === null) return dir
  const gitDir = path.resolve(dir, dirs.gitDir)
  const commonDir = path.resolve(dir, dirs.commonDir)
  if (gitDir === commonDir) return dir
  return path.dirname(commonDir)
}
