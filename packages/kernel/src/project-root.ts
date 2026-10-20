import path from 'node:path'

// git-dir differs from git-common-dir only in a linked worktree: re-root only then
export function resolveProjectRoot(dir: string, dirs: { gitDir: string; commonDir: string } | null): string {
  if (dirs === null) return dir
  const gitDir = path.resolve(dir, dirs.gitDir)
  const commonDir = path.resolve(dir, dirs.commonDir)
  if (gitDir === commonDir) return dir
  return path.dirname(commonDir)
}
