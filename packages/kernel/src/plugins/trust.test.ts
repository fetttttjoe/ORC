import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { grantTrust, isTrustedPath, loadTrust } from './trust'

let dirs: string[] = []
const temp = () => { const d = mkdtempSync(path.join(tmpdir(), 'orc-trust-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

describe('trust store', () => {
  it('missing file → nothing trusted', () => {
    expect(loadTrust(temp())).toEqual({ mcp: [], extensions: [] })
  })

  it('grant is idempotent and persists', () => {
    const d = temp()
    grantTrust('mcp', 'files', d)
    grantTrust('mcp', 'files', d)
    grantTrust('extensions', './ext/a.ts', d)
    expect(loadTrust(d)).toEqual({ mcp: ['files'], extensions: ['./ext/a.ts'] })
    expect(JSON.parse(readFileSync(path.join(d, '.orc', 'trust.json'), 'utf8')).mcp).toEqual(['files'])
  })

  it('corrupt file → nothing trusted (no throw)', () => {
    const d = temp()
    grantTrust('mcp', 'x', d)
    require('node:fs').writeFileSync(path.join(d, '.orc', 'trust.json'), '{nope')
    expect(loadTrust(d)).toEqual({ mcp: [], extensions: [] })
  })

  it('isTrustedPath matches by resolved path', () => {
    const base = '/proj'
    expect(isTrustedPath('./ext/a.ts', ['ext/a.ts'], base)).toBe(true)
    expect(isTrustedPath('ext/a.ts', ['./other.ts'], base)).toBe(false)
    expect(isTrustedPath('/abs/x.ts', ['/abs/x.ts'], base)).toBe(true)
  })
})
