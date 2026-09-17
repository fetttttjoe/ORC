import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertInZone, pathInZone, resolveInWorkspace } from './workspace'

// every temp dir this file creates, removed once at the end
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmp = (prefix: string): string => { const d = mkdtempSync(path.join(tmpdir(), prefix)); dirs.push(d); return d }
const ws = () => tmp('orc-ws-')

describe('pathInZone (pure zone predicate)', () => {
  it('matches a path inside a single glob', () => {
    expect(pathInZone('src/index.ts', ['src/**'])).toBe(true)
  })

  it('does not match a path outside every glob', () => {
    expect(pathInZone('docs/readme.md', ['src/**'])).toBe(false)
  })

  it('matches a nested path via packages/kernel/**', () => {
    expect(pathInZone('packages/kernel/src/execution/foo-tool.ts', ['packages/kernel/**'])).toBe(true)
  })

  it('treats a "./"-prefixed path the same as its bare form', () => {
    expect(pathInZone('./packages/kernel/src/index.ts', ['packages/kernel/**'])).toBe(true)
    expect(pathInZone('packages/kernel/src/index.ts', ['packages/kernel/**'])).toBe(true)
  })

  it('empty or undefined zone is unrestricted, matching assertInZone semantics', () => {
    expect(pathInZone('anything/at/all.ts', [])).toBe(true)
    expect(pathInZone('anything/at/all.ts', undefined)).toBe(true)
  })

  it('rejects a path with a ".." segment (returns false, does not throw)', () => {
    expect(pathInZone('../outside.txt', ['**'])).toBe(false)
    expect(pathInZone('src/../../outside.txt', ['**'])).toBe(false)
  })

  it('classifies a path that does not exist on disk — no fs access required', () => {
    expect(pathInZone('packages/nope/does/not/exist-9182.ts', ['packages/nope/**'])).toBe(true)
    expect(pathInZone('packages/nope/does/not/exist-9182.ts', ['packages/other/**'])).toBe(false)
  })

  it('collapses duplicate slashes and normalizes backslashes', () => {
    expect(pathInZone('packages//kernel///src/index.ts', ['packages/kernel/**'])).toBe(true)
    expect(pathInZone('packages\\kernel\\src\\index.ts', ['packages/kernel/**'])).toBe(true)
  })
})

describe('assertInZone (write-fence)', () => {
  it('empty zone is unrestricted; matching globs pass; outside throws a named fence', () => {
    const dir = ws()
    const abs = resolveInWorkspace(dir, 'src/index.ts')
    expect(() => assertInZone(dir, abs, [])).not.toThrow()
    expect(() => assertInZone(dir, abs, ['src/**'])).not.toThrow()
    expect(() => assertInZone(dir, abs, ['docs/**'])).toThrow(/zone fence: 'src\/index\.ts' is outside/)
    expect(() => assertInZone(dir, abs, ['docs/**', 'src/**'])).not.toThrow() // any glob admits
  })
})

describe('resolveInWorkspace (trust boundary)', () => {
  it('rejects .. traversal and absolute escapes; resolves relative paths', () => {
    const dir = ws()
    // the error names the path convention: an agent that assumed file-relative paths (../plugins
    // from inside packages/cli, observed live as #31863) must learn the rule from the refusal
    expect(() => resolveInWorkspace(dir, '../outside.txt')).toThrow(/relative to the workspace root/)
    expect(() => resolveInWorkspace(dir, '/etc/passwd')).toThrow(/escapes workspace/)
    expect(resolveInWorkspace(dir, 'sub/file.txt')).toBe(path.join(dir, 'sub', 'file.txt'))
  })

  it('rejects a symlink pointing outside the workspace', () => {
    const dir = ws()
    const outside = tmp('orc-outside-')
    writeFileSync(path.join(outside, 'secret.txt'), 'top-secret')
    symlinkSync(outside, path.join(dir, 'sneaky'))
    expect(() => resolveInWorkspace(dir, 'sneaky/secret.txt')).toThrow(/escapes workspace/)
  })

  it('rejects a deep nonexistent path under a symlinked dir (ancestor-walk loop)', () => {
    const dir = ws()
    const outside = tmp('orc-outside-')
    symlinkSync(outside, path.join(dir, 'sneaky'))
    // nothing below `sneaky` exists — the guard must climb past a/ and b/ to find the symlink
    expect(() => resolveInWorkspace(dir, 'sneaky/a/b/new.txt')).toThrow(/escapes workspace/)
  })
})
