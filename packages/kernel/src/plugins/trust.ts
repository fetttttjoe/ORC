import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from '../atomic-file'
import { z } from 'zod'
import type { McpServerConfig } from '@orc/contracts'

// The grant file (.orc/trust.json) is LOCAL consent — never committed (.orc/* is
// gitignored). Config DECLARES servers/extensions; only this file ARMS them (spec D3).
// A grant binds to a FINGERPRINT of what was consented to: change the declaration
// (MCP command/args/env keys) or the content (extension entry bytes) and the old
// grant is invalid — consent must be given again.
const TrustRecord = z.object({ id: z.string().min(1), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
const TrustFile = z.object({
  mcp: z.array(TrustRecord).default([]),
  extensions: z.array(TrustRecord).default([]),
})
export type TrustRecord = z.infer<typeof TrustRecord>
export interface TrustStore { mcp: TrustRecord[]; extensions: TrustRecord[] }

const trustPath = (dir: string): string => path.join(dir, '.orc', 'trust.json')

// declaration fingerprint: command, args, and the NAMES of declared env vars — values are
// neither hashed nor stored, so rotating a secret does not invalidate consent or leak it
export function mcpFingerprint(cfg: McpServerConfig): string {
  const canonical = JSON.stringify([cfg.command, cfg.args ?? [], Object.keys(cfg.env ?? {}).sort()])
  return createHash('sha256').update(canonical).digest('hex')
}

// content fingerprint: the entry file's bytes — any edit requires a new grant
export function extensionFingerprint(entryFile: string): string {
  return createHash('sha256').update(readFileSync(entryFile)).digest('hex')
}

export function loadTrust(dir: string = process.cwd()): TrustStore {
  const file = trustPath(dir)
  if (!existsSync(file)) return { mcp: [], extensions: [] }
  try {
    // pre-fingerprint files (string arrays) fail this parse and thereby fail closed
    return TrustFile.parse(JSON.parse(readFileSync(file, 'utf8')))
  } catch (err) {
    // fail closed, but never silently: a corrupted grant file revokes everything
    console.warn(`ignoring malformed ${file} — all plugins untrusted (${err instanceof Error ? err.message : String(err)})`)
    return { mcp: [], extensions: [] }
  }
}

// consent is local and private: atomic write, owner-only mode
function saveTrust(dir: string, store: TrustStore): void {
  atomicWriteFileSync(trustPath(dir), JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
}

function grant(kind: 'mcp' | 'extensions', record: TrustRecord, dir: string): TrustStore {
  const store = loadTrust(dir)
  store[kind] = [...store[kind].filter(r => r.id !== record.id), record]
  saveTrust(dir, store)
  return store
}

export function grantMcpTrust(serverId: string, cfg: McpServerConfig, dir: string = process.cwd()): TrustStore {
  return grant('mcp', { id: serverId, fingerprint: mcpFingerprint(cfg) }, dir)
}

export function grantExtensionTrust(declared: string, dir: string = process.cwd()): TrustStore {
  const entry = path.resolve(dir, declared)
  return grant('extensions', { id: declared, fingerprint: extensionFingerprint(entry) }, dir)
}

export function isMcpTrusted(store: TrustStore, serverId: string, cfg: McpServerConfig): boolean {
  return store.mcp.some(r => r.id === serverId && r.fingerprint === mcpFingerprint(cfg))
}

export function isExtensionTrusted(store: TrustStore, declared: string, baseDir: string): boolean {
  const entry = path.resolve(baseDir, declared)
  const record = store.extensions.find(r => path.resolve(baseDir, r.id) === entry)
  if (!record) return false
  try {
    return record.fingerprint === extensionFingerprint(entry)
  } catch {
    return false // missing/unreadable entry file — never trust what cannot be re-verified
  }
}
