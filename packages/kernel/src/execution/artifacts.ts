import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveInWorkspace } from '@orc/contracts'

export interface ArtifactReceipt {
  path: string // canonical workspace-relative
  sha256: string
  size: number
}

// The canonical receipt is derived by trusted code — never supplied by the agent.
// Rejects duplicates, missing files, directories, and any path escaping the workspace
// (resolveInWorkspace covers absolute paths and symlinks).
export function verifyArtifacts(workspaceDir: string, paths: string[]): ArtifactReceipt[] {
  const receipts = new Map<string, ArtifactReceipt>()
  for (const p of paths) {
    const abs = resolveInWorkspace(workspaceDir, p)
    const stat = statSync(abs, { throwIfNoEntry: false })
    if (!stat) throw new Error(`declared output does not exist: ${p}`)
    if (!stat.isFile()) throw new Error(`declared output is not a regular file: ${p}`)
    const canonical = path.relative(workspaceDir, abs)
    if (receipts.has(canonical)) throw new Error(`duplicate output path: ${p}`)
    receipts.set(canonical, {
      path: canonical,
      sha256: createHash('sha256').update(readFileSync(abs)).digest('hex'),
      size: stat.size,
    })
  }
  return [...receipts.values()].sort((a, b) => a.path.localeCompare(b.path))
}
