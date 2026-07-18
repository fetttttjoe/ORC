import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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
  mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, abs)
}
export function deleteMemoryFile(vaultDir: string, rel: string): void {
  const abs = resolveInMemory(vaultDir, rel)
  rmSync(abs, { force: true })
}
