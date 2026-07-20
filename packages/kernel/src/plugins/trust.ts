import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
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

// Declaration fingerprint: command, args, and the declared env.
//
// An env value is covered ONLY when it is a `$NAME` indirection. Those name WHICH secret the
// server receives, so they are part of the declaration a human consented to — and they are
// references, not secret material, so hashing them leaks nothing. A `$WEATHER_TOKEN` ->
// `$ANTHROPIC_API_KEY` edit in the committed .orc/config.json would otherwise leave command,
// args, and env key names byte-identical, keep the grant valid, and hand a third-party process
// a secret it was never trusted with.
//
// Literal values ARE secret material (resolveEnv passes them through verbatim), so they are
// folded to a constant: inlining or rotating one neither writes a verifier for it into
// trust.json nor invalidates consent.
const envDeclaration = (env: Record<string, string> = {}): string[][] =>
  Object.keys(env).sort().map(k => [k, env[k]!.startsWith('$') ? env[k]! : ''])

export function mcpFingerprint(cfg: McpServerConfig): string {
  const canonical = JSON.stringify([cfg.command, cfg.args ?? [], envDeclaration(cfg.env)])
  return createHash('sha256').update(canonical).digest('hex')
}

const SCRIPT_LOADERS = {
  '.cjs': 'js', '.js': 'js', '.mjs': 'js',
  '.cts': 'ts', '.ts': 'ts', '.mts': 'ts',
  '.jsx': 'jsx', '.tsx': 'tsx',
} as const

// content fingerprint: entry + executable local imports + project lockfile
export function extensionFingerprint(entryFile: string, baseDir: string): string {
  const files = new Map<string, Buffer>()
  const pending = [realpathSync(entryFile)]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.has(file)) continue
    const bytes = readFileSync(file)
    files.set(file, bytes)
    const loader = SCRIPT_LOADERS[path.extname(file) as keyof typeof SCRIPT_LOADERS]
    if (!loader) continue
    for (const imported of new Bun.Transpiler({ loader }).scanImports(bytes.toString('utf8'))) {
      if (!imported.path.startsWith('.') && !path.isAbsolute(imported.path)) continue
      pending.push(realpathSync(Bun.resolveSync(imported.path, path.dirname(file))))
    }
  }
  const lockfile = path.join(baseDir, 'bun.lock')
  if (existsSync(lockfile)) files.set(realpathSync(lockfile), readFileSync(lockfile))

  const hash = createHash('sha256').update('orc-extension-v2\0')
  for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const label = path.relative(baseDir, file)
    hash.update(`${label.length}:${label}:${bytes.length}:`).update(bytes)
  }
  return hash.digest('hex')
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
  return grant('extensions', { id: declared, fingerprint: extensionFingerprint(entry, dir) }, dir)
}

export function isMcpTrusted(store: TrustStore, serverId: string, cfg: McpServerConfig): boolean {
  return store.mcp.some(r => r.id === serverId && r.fingerprint === mcpFingerprint(cfg))
}

export function isExtensionTrusted(store: TrustStore, declared: string, baseDir: string): boolean {
  const entry = path.resolve(baseDir, declared)
  const record = store.extensions.find(r => path.resolve(baseDir, r.id) === entry)
  if (!record) return false
  try {
    return record.fingerprint === extensionFingerprint(entry, baseDir)
  } catch {
    return false // missing/unreadable entry file — never trust what cannot be re-verified
  }
}
