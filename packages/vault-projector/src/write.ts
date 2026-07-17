import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { VaultFiles } from './render'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const isPlanFile = (rel: string): boolean => /\/plan-v\d+\.md$/.test(rel)

// Single writer for the trace subtree (spec D5). Atomic per file, skip-unchanged,
// write-once for plan versions, warn-then-overwrite for hand-edited projection files.
export function writeVaultFiles(vaultDir: string, files: VaultFiles): void {
  const manifestPath = path.join(vaultDir, '.orc-manifest.json')
  let manifest: Record<string, string> = {}
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { manifest = {} }

  const root = path.resolve(vaultDir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.resolve(vaultDir, rel)
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`vault write escapes root: ${rel}`)
    const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    if (onDisk === content) continue                       // unchanged
    if (isPlanFile(rel) && onDisk !== null) continue       // write-once (protects human edits)
    if (!isPlanFile(rel) && onDisk !== null && manifest[rel] !== undefined && sha(onDisk) !== manifest[rel])
      console.warn(`vault: ${rel} was hand-edited; it is projection-only and is being overwritten`)
    mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, abs)                                   // atomic swap
    manifest[rel] = sha(content)
  }
  mkdirSync(vaultDir, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
