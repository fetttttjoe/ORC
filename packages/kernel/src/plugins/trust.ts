import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

// The grant file (.orc/trust.json) is LOCAL consent — never committed (docs; .orc/ is
// gitignored here). Config DECLARES servers/extensions; only this file ARMS them (spec D3).
const TrustFile = z.object({
  mcp: z.array(z.string()).default([]),
  extensions: z.array(z.string()).default([]),
})
export interface TrustStore { mcp: string[]; extensions: string[] }

const trustPath = (dir: string): string => path.join(dir, '.orc', 'trust.json')

export function loadTrust(dir: string = process.cwd()): TrustStore {
  const file = trustPath(dir)
  if (!existsSync(file)) return { mcp: [], extensions: [] }
  try {
    return TrustFile.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    // fail closed, but never silently: a corrupted grant file revokes everything
    console.warn(`ignoring malformed ${file} — all plugins untrusted (${err instanceof Error ? err.message : String(err)})`)
    return { mcp: [], extensions: [] }
  }
}

export function grantTrust(kind: 'mcp' | 'extensions', value: string, dir: string = process.cwd()): TrustStore {
  const store = loadTrust(dir)
  if (!store[kind].includes(value)) store[kind].push(value)
  mkdirSync(path.dirname(trustPath(dir)), { recursive: true })
  writeFileSync(trustPath(dir), JSON.stringify(store, null, 2) + '\n')
  return store
}

export function isTrustedPath(declared: string, trustedList: string[], baseDir: string): boolean {
  const abs = path.resolve(baseDir, declared)
  return trustedList.some(t => path.resolve(baseDir, t) === abs)
}
