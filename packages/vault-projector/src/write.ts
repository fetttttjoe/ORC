import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { sha256 } from '@orc/contracts'
import { z } from 'zod'
import { atomicWriteFileSync } from '@orc/kernel'
import type { VaultFiles } from './render'

// the on-disk shape this file's own writes always produce (rel path → content sha256)
const Manifest = z.record(z.string(), z.string())

const isPlanFile = (rel: string): boolean => /\/plan-v\d+\.md$/.test(rel)

// Atomic per file; plan versions are write-once; hand-edited files warn, then are overwritten
export function writeVaultFiles(vaultDir: string, files: VaultFiles): void {
  const manifestPath = path.join(vaultDir, '.orc-manifest.json')
  // A missing or malformed manifest reads as empty: every file is untracked and written silently
  let manifest: Record<string, string> = {}
  try { manifest = Manifest.parse(JSON.parse(readFileSync(manifestPath, 'utf8'))) } catch { manifest = {} }

  const root = path.resolve(vaultDir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.resolve(vaultDir, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`vault write escapes root: ${rel}`)
    const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    if (onDisk === content) continue                       // unchanged
    if (isPlanFile(rel) && onDisk !== null) continue       // write-once (protects human edits)
    if (!isPlanFile(rel) && onDisk !== null && manifest[rel] !== undefined && sha256(onDisk) !== manifest[rel])
      console.warn(`vault: ${rel} was hand-edited; it is projection-only and is being overwritten`)
    atomicWriteFileSync(abs, content)
    manifest[rel] = sha256(content)
  }
  atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
