import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { verifyArtifacts } from './artifacts'

const ws = () => mkdtempSync(path.join(tmpdir(), 'orc-art-'))

describe('verifyArtifacts', () => {
  it('derives canonical sorted receipts with sha256 and byte size', () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'b.txt'), 'hello')
    mkdirSync(path.join(dir, 'sub'))
    writeFileSync(path.join(dir, 'sub', 'a.txt'), 'xy')
    const receipts = verifyArtifacts(dir, ['b.txt', 'sub/a.txt'])
    expect(receipts).toEqual([
      { path: 'b.txt', sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', size: 5 },
      { path: 'sub/a.txt', sha256: receipts[1]!.sha256, size: 2 },
    ])
    expect(receipts.map(r => r.path)).toEqual([...receipts.map(r => r.path)].sort())
  })

  it('rejects missing files, directories, duplicates, and escapes', () => {
    const dir = ws()
    writeFileSync(path.join(dir, 'ok.txt'), 'x')
    mkdirSync(path.join(dir, 'adir'))
    expect(() => verifyArtifacts(dir, ['nope.txt'])).toThrow(/does not exist/)
    expect(() => verifyArtifacts(dir, ['adir'])).toThrow(/not a regular file/)
    expect(() => verifyArtifacts(dir, ['ok.txt', './ok.txt'])).toThrow(/duplicate/)
    expect(() => verifyArtifacts(dir, ['../escape.txt'])).toThrow(/escapes workspace/)
    expect(() => verifyArtifacts(dir, ['/etc/passwd'])).toThrow(/escapes workspace/)
  })

  it('rejects a symlink escaping the workspace', () => {
    const dir = ws()
    const outside = mkdtempSync(path.join(tmpdir(), 'orc-art-out-'))
    writeFileSync(path.join(outside, 'secret.txt'), 's')
    symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'))
    expect(() => verifyArtifacts(dir, ['link.txt'])).toThrow(/escapes workspace/)
  })
})
