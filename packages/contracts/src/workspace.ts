import { existsSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

// The fs tools that CHANGE a file — matched values, never scattered literals (mirrors
// MEMORY_TOOL_NAME's shape). Owned here because kernel's audit projection (taskChangedPaths) and
// the executor's tool registration/write fence must agree on exactly this set: a fourth writing
// tool that only one side knew about would silently escape taskChangedPaths. fs_read/fs_list are
// absent by design — reading a file is not a write.
export const FS_WRITE_TOOL_NAME = { write: 'fs_write', edit: 'fs_edit', delete: 'fs_delete' } as const
export const FS_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(FS_WRITE_TOOL_NAME))

// Read-side path normalization (do NOT call realpath/fs/git — a hand-built event array or an
// already-relative path must fold without touching disk): forward slashes, strip a leading './',
// collapse duplicate slashes. Shared by pathInZone below and the kernel's audit projection
// (taskChangedPaths) so the zone fence and the audit can never classify the same path differently.
export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

// Trust boundary (spec §6.3): resolved path — symlinks included — must stay inside the
// workspace. The ONE containment guard: file tools and signal-output verification share it.
export function resolveInWorkspace(workspaceDir: string, p: string): string {
  const root = realpathSync(workspaceDir)
  const resolved = path.resolve(root, p)
  // realpath the deepest existing ancestor so symlinks cannot smuggle the path outside
  let probe = resolved
  while (!existsSync(probe)) probe = path.dirname(probe)
  const real = realpathSync(probe)
  // the hint matters as much as the refusal: agents assume file-relative paths ('../plugins'
  // written from a packages/cli mindset) and must learn the convention from this one message
  if (real !== root && !real.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p} — paths are relative to the workspace root, not to the file being edited`)
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p} — paths are relative to the workspace root, not to the file being edited`)
  return resolved
}

// Pure zone-glob predicate: matches an already workspace-relative path against `zone` globs
// with the SAME engine (Bun.Glob) and matching semantics as assertInZone below — no fs calls
// (no realpathSync/existsSync/stat/Bun.file), so it is safe to run over paths recorded in the
// event log for a task/step that may no longer exist on disk (or never did, in this workspace).
//
// Normalization contract (applied before matching):
//   - a leading './' is stripped
//   - backslashes are converted to forward slashes (Windows-style separators)
//   - duplicate slashes are collapsed to one
//   - the caller is responsible for relativizing: this function accepts RELATIVE paths only.
//     A leading '/' (absolute) or any '..' segment is treated as escaping the workspace and
//     causes this function to return false — it never throws, and it never treats such input
//     as matching. There is no realpath-based containment check here (that stays in
//     assertInZone, which owns write-fence enforcement); this is classification, not a guard.
// Empty or undefined zone means "unrestricted" — matches assertInZone's behaviour for an empty
// zone list (returns immediately without restriction) — so an unfenced path is IN zone (true).
export function pathInZone(relPath: string, zone: string[] | undefined): boolean {
  const p = normalizeRelPath(relPath)
  if (p.startsWith('/')) return false
  if (p.split('/').some(seg => seg === '..')) return false
  if (!zone || zone.length === 0) return true
  return zone.some(g => new Bun.Glob(g).match(p))
}

// The zone write-fence (P2): a step that declares `zone` globs may only WRITE inside them.
// Pure rule over the canonical workspace-relative path — the caller resolves containment first
// (resolveInWorkspace), so escapes are already dead and `rel` is always root-relative.
// Empty zone = unrestricted (declared semantics). Reads are never fenced.
// Delegates the actual glob match to pathInZone; the realpath-based resolution of `rel` from
// `abs` stays here since that part is inherently fs-touching and out of scope for the pure
// predicate.
export function assertInZone(workspaceDir: string, abs: string, zone: string[]): void {
  if (zone.length === 0) return
  const rel = path.relative(realpathSync(workspaceDir), abs)
  if (!pathInZone(rel, zone))
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
