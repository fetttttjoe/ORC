import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export const FS_READ_TOOL_NAME = 'fs_read'
export const FS_LIST_TOOL_NAME = 'fs_list'

// fs tools that change a file; taskChangedPaths and the executor's fence share this set
export const FS_WRITE_TOOL_NAME = { write: 'fs_write', edit: 'fs_edit', delete: 'fs_delete' } as const
export const FS_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(FS_WRITE_TOOL_NAME))

// no fs access, so hand-built event paths fold; shared with kernel's taskChangedPaths
export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

// the one containment guard, symlinks included, shared by file tools and output verification
export function resolveInWorkspace(workspaceDir: string, p: string): string {
  const root = realpathSync(workspaceDir)
  const resolved = path.resolve(root, p)
  // realpath the deepest existing ancestor so symlinks cannot smuggle the path outside
  let probe = resolved
  while (!existsSync(probe)) probe = path.dirname(probe)
  const real = realpathSync(probe)
  // the hint is load-bearing: agents write file-relative paths and learn the convention here
  if (real !== root && !real.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p} — paths are relative to the workspace root, not to the file being edited`)
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p} — paths are relative to the workspace root, not to the file being edited`)
  return resolved
}

// relative paths only: absolute or '..' returns false; no fs access, classification not a guard
export function pathInZone(relPath: string, zone: string[] | undefined): boolean {
  const p = normalizeRelPath(relPath)
  if (p.startsWith('/')) return false
  if (p.split('/').some(seg => seg === '..')) return false
  if (!zone || zone.length === 0) return true
  return zone.some(g => new Bun.Glob(g).match(p))
}

// A directory entry is a dead fence: 'src' matches the path 'src' itself, never a file under it.
export function directoryZoneEntries(zone: string[], isDirectory: (relPath: string) => boolean): string[] {
  return zone.filter(entry => isDirectory(normalizeRelPath(entry)))
}

// matched as a path segment: docs/.gitignore stays writable, the .git directory does not
const isRepoMetadata = (rel: string): boolean =>
  rel.split(path.sep).includes('.git')

export function assertInZone(workspaceDir: string, abs: string, zone: string[]): void {
  const rel = path.relative(realpathSync(workspaceDir), abs)
  if (isRepoMetadata(rel))
    throw new Error(`'${rel}' is inside .git — the repository's own metadata is never writable, in any zone`)
  if (zone.length === 0) return
  if (!pathInZone(rel, zone))
    throw new Error(`zone fence: '${rel}' is outside this step's zone [${zone.join(', ')}]`)
}

export interface OutputPath {
  path: string // canonical workspace-relative
  abs: string
}

// paths resolve against the real root, so a symlinked workspaceDir yields no '../' receipts
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
