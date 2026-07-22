import { existsSync, realpathSync, statSync } from 'node:fs'
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

// The zone write-fence (P2): a step that declares `zone` globs may only WRITE inside them.
// Pure rule over the canonical workspace-relative path — the caller resolves containment first
// (resolveInWorkspace), so escapes are already dead and `rel` is always root-relative.
// Empty zone = unrestricted (declared semantics). Reads are never fenced.
export function assertInZone(workspaceDir: string, abs: string, zone: string[]): void {
  if (zone.length === 0) return
  const rel = path.relative(realpathSync(workspaceDir), abs)
  if (!zone.some(g => new Bun.Glob(g).match(rel)))
    throw new Error(`zone fence: '${rel}' is outside this step's zone [${zone.join(', ')}]`)
}

export interface OutputPath {
  path: string // canonical workspace-relative
  abs: string
}

// The ONE rule set for declared step outputs: containment, regular file, no duplicates.
// The executor's pre-flight (so the model can fix a bad declaration) and the runtime's
// trusted receipt verification both call this — the two can never drift.
// Canonical relative paths are computed against the REAL workspace root, matching what
// resolveInWorkspace resolves under (a symlinked or relative workspaceDir must not
// produce '../'-style receipt paths).
export function validateOutputPaths(workspaceDir: string, paths: string[]): OutputPath[] {
  const root = realpathSync(workspaceDir)
  const seen = new Map<string, OutputPath>()
  for (const p of paths) {
    const abs = resolveInWorkspace(workspaceDir, p)
    const stat = statSync(abs, { throwIfNoEntry: false })
    if (!stat) throw new Error(`declared output does not exist: ${p}`)
    if (!stat.isFile()) throw new Error(`declared output is not a regular file: ${p}`)
    const canonical = path.relative(root, abs)
    if (seen.has(canonical)) throw new Error(`duplicate output path: ${p}`)
    seen.set(canonical, { path: canonical, abs })
  }
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
}
