import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from '@orc/kernel'

// Single writer for vault/memory/** ONLY (spec D5). Atomic per file; skip-unchanged.
function resolveInMemory(vaultDir: string, rel: string): string {
  const root = path.resolve(vaultDir, 'memory')
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`memory write escapes root: ${rel}`)
  return abs
}
export function writeMemoryFile(vaultDir: string, rel: string, content: string): void {
  const abs = resolveInMemory(vaultDir, rel)
  if (existsSync(abs) && readFileSync(abs, 'utf8') === content) return
  atomicWriteFileSync(abs, content)
}
export function deleteMemoryFile(vaultDir: string, rel: string): void {
  const abs = resolveInMemory(vaultDir, rel)
  rmSync(abs, { force: true })
}
