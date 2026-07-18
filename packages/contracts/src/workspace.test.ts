import { describe, expect, it } from 'bun:test'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveInWorkspace } from './workspace'

const ws = () => mkdtempSync(path.join(tmpdir(), 'orc-ws-'))

describe('resolveInWorkspace (trust boundary)', () => {
  it('rejects .. traversal and absolute escapes; resolves relative paths', () => {
    const dir = ws()
    expect(() => resolveInWorkspace(dir, '../outside.txt')).toThrow(/escapes workspace/)
    expect(() => resolveInWorkspace(dir, '/etc/passwd')).toThrow(/escapes workspace/)
    expect(resolveInWorkspace(dir, 'sub/file.txt')).toBe(path.join(dir, 'sub', 'file.txt'))
  })

  it('rejects a symlink pointing outside the workspace', () => {
    const dir = ws()
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-outside-'))
    writeFileSync(path.join(outside, 'secret.txt'), 'top-secret')
    symlinkSync(outside, path.join(dir, 'sneaky'))
    expect(() => resolveInWorkspace(dir, 'sneaky/secret.txt')).toThrow(/escapes workspace/)
  })

  it('rejects a deep nonexistent path under a symlinked dir (ancestor-walk loop)', () => {
    const dir = ws()
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-outside-'))
    symlinkSync(outside, path.join(dir, 'sneaky'))
    // nothing below `sneaky` exists — the guard must climb past a/ and b/ to find the symlink
    expect(() => resolveInWorkspace(dir, 'sneaky/a/b/new.txt')).toThrow(/escapes workspace/)
  })
})
