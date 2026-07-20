import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

  it('a changed MCP declaration (args or env KEYS) invalidates the grant; a rotated literal env VALUE does not', () => {
    const d = temp()
    const store = grantMcpTrust('files', server, d)
    expect(isMcpTrusted(store, 'files', { ...server, args: ['other.ts'] })).toBe(false)
    expect(isMcpTrusted(store, 'files', { ...server, env: { OTHER_KEY: 'x' } })).toBe(false)
    // literal rotation keeps consent, and the value never appears in the fingerprint or file
    expect(isMcpTrusted(store, 'files', { ...server, env: { API_KEY: 'rotated-value' } })).toBe(true)
    expect(JSON.stringify(store)).not.toContain('secret-value')
    expect(mcpFingerprint(server)).toBe(mcpFingerprint({ ...server, env: { API_KEY: 'rotated-value' } }))
  })

  // .orc/config.json is committed by design (.gitignore un-ignores it), so the declaration is a
  // PR-reachable artifact and the fingerprint is the only thing between an edit and re-consent.
  // Repointing an indirection is a privilege change, not a rotation: same command, same args,
  // same env key — a different secret handed to a third-party process.
  it('repointing a $VAR indirection at another secret invalidates the grant', () => {
    const d = temp()
    const declared = { command: 'bun', args: ['server.ts'], env: { API_KEY: '$WEATHER_TOKEN' } }
    const store = grantMcpTrust('weather', declared, d)
    expect(isMcpTrusted(store, 'weather', declared)).toBe(true)
    expect(isMcpTrusted(store, 'weather', { ...declared, env: { API_KEY: '$ANTHROPIC_API_KEY' } })).toBe(false)
    // the indirection is a reference, not secret material — safe to cover, and covered
    expect(mcpFingerprint(declared)).not.toBe(mcpFingerprint({ ...declared, env: { API_KEY: '$OTHER' } }))
  })

  it('old entry-only extension fingerprints fail closed', () => {
    const d = temp()
    const entry = path.join(d, 'ext.ts')
    writeFileSync(entry, 'export default { id: "x", activate() {} }')
    grantExtensionTrust('ext.ts', d)
    const oldFingerprint = createHash('sha256').update(readFileSync(entry)).digest('hex')
    writeFileSync(path.join(d, '.orc', 'trust.json'), JSON.stringify({
      mcp: [], extensions: [{ id: 'ext.ts', fingerprint: oldFingerprint }],
    }))

    expect(isExtensionTrusted(loadTrust(d), 'ext.ts', d)).toBe(false)
  })

  it('a changed project lockfile invalidates the extension grant', () => {
    const d = temp()
    writeFileSync(path.join(d, 'ext.ts'), 'export default { id: "x", activate() {} }')
    writeFileSync(path.join(d, 'bun.lock'), 'lock-v1')
    const store = grantExtensionTrust('ext.ts', d)
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(true)

    writeFileSync(path.join(d, 'bun.lock'), 'lock-v2')
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(false)
  })

  it('a changed local extension dependency invalidates the grant', () => {
    const d = temp()
    writeFileSync(path.join(d, 'dep.ts'), `export const value = 'v1'\n`)
    writeFileSync(path.join(d, 'ext.ts'), `import { value } from './dep'\nexport default value\n`)
    const store = grantExtensionTrust('ext.ts', d)
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(true)

    writeFileSync(path.join(d, 'dep.ts'), `export const value = 'v2'\n`)
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(false)
  })

  it('a changed extension byte invalidates the grant; missing entry never trusts', () => {
    const d = temp()
    const entry = path.join(d, 'ext.ts')
    writeFileSync(entry, 'export default { id: "x", activate() {} }')
    const store = grantExtensionTrust('ext.ts', d)
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(true)
    expect(store.extensions[0]!.fingerprint).toBe(extensionFingerprint(entry, d))

    writeFileSync(entry, 'export default { id: "x", activate() { /* changed */ } }')
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(false)
    rmSync(entry)
    expect(isExtensionTrusted(store, 'ext.ts', d)).toBe(false)
  })
})
