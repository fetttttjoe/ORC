import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

// Trust boundary (spec §6.3): resolved path — symlinks included — must stay inside the
// workspace. The ONE containment guard: file tools and signal-output verification share it.
export function resolveInWorkspace(workspaceDir: string, p: string): string {
  const root = realpathSync(workspaceDir)
  const resolved = path.resolve(root, p)
  // realpath the deepest existing ancestor so symlinks cannot smuggle the path outside
  let probe = resolved
  while (!existsSync(probe)) probe = path.dirname(probe)
  const real = realpathSync(probe)
  if (real !== root && !real.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p}`)
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p}`)
  return resolved
}
