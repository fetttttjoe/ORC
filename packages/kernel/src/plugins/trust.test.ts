import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  extensionFingerprint, grantExtensionTrust, grantMcpTrust,
  isExtensionTrusted, isMcpTrusted, loadTrust, mcpFingerprint,
} from './trust'

let dirs: string[] = []
const temp = () => { const d = mkdtempSync(path.join(tmpdir(), 'orc-trust-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

const server = { command: 'bun', args: ['server.ts'], env: { API_KEY: 'secret-value' } }

describe('trust store', () => {
  it('missing file → nothing trusted', () => {
    expect(loadTrust(temp())).toEqual({ mcp: [], extensions: [] })
  })

  it('writes atomically with owner-only mode; grant is idempotent', () => {
    const d = temp()
    grantMcpTrust('files', server, d)
    grantMcpTrust('files', server, d)
    const file = path.join(d, '.orc', 'trust.json')
    expect((statSync(file).mode & 0o777)).toBe(0o600)
    expect(readdirSync(path.dirname(file)).filter(f => f.endsWith('.tmp'))).toEqual([])
    const store = loadTrust(d)
    expect(store.mcp).toHaveLength(1)
    expect(isMcpTrusted(store, 'files', server)).toBe(true)
  })

  it('corrupt file → nothing trusted (no throw)', () => {
    const d = temp()
    grantMcpTrust('x', server, d)
    writeFileSync(path.join(d, '.orc', 'trust.json'), '{nope')
    expect(loadTrust(d)).toEqual({ mcp: [], extensions: [] })
  })

  it('old string-array grant files fail closed', () => {
    const d = temp()
    grantMcpTrust('seed', server, d) // ensures .orc exists
    writeFileSync(path.join(d, '.orc', 'trust.json'), JSON.stringify({ mcp: ['files'], extensions: ['ext/a.ts'] }))
    expect(existsSync(path.join(d, '.orc', 'trust.json'))).toBe(true)
    expect(loadTrust(d)).toEqual({ mcp: [], extensions: [] })
  })

  it('a changed MCP declaration (args or env KEYS) invalidates the grant; a changed env VALUE does not', () => {
    const d = temp()
    const store = grantMcpTrust('files', server, d)
    expect(isMcpTrusted(store, 'files', { ...server, args: ['other.ts'] })).toBe(false)
    expect(isMcpTrusted(store, 'files', { ...server, env: { OTHER_KEY: 'x' } })).toBe(false)
    // value rotation keeps consent, and the value never appears in the fingerprint or file
    expect(isMcpTrusted(store, 'files', { ...server, env: { API_KEY: 'rotated-value' } })).toBe(true)
    expect(JSON.stringify(store)).not.toContain('secret-value')
    expect(mcpFingerprint(server)).toBe(mcpFingerprint({ ...server, env: { API_KEY: 'rotated-value' } }))
  })

  it('a changed extension byte invalidates the grant; missing entry never trusts', () => {
    const d = temp()
    const entry = path.join(d, 'ext.ts')
    writeFileSync(entry, 'export default { id: "x", activate() {} }')
    const store = grantExtensionTrust('ext.ts', d)
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(true)
    expect(store.extensions[0]!.fingerprint).toBe(extensionFingerprint(entry))

    writeFileSync(entry, 'export default { id: "x", activate() { /* changed */ } }')
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(false)
    rmSync(entry)
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(false)
  })
})
