import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeVaultFiles } from './write'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const vault = () => { const d = mkdtempSync(path.join(tmpdir(), 'orc-vault-')); dirs.push(d); return d }

describe('writeVaultFiles', () => {
  it('writes files, is idempotent, and never leaves .tmp files', () => {
    const d = vault()
    writeVaultFiles(d, { 'tasks/t1/log.md': 'a' })
    expect(readFileSync(path.join(d, 'tasks/t1/log.md'), 'utf8')).toBe('a')
    expect(existsSync(path.join(d, 'tasks/t1/log.md.tmp'))).toBe(false)
    // idempotent: re-write identical content changes nothing (mtime check via content compare only)
    writeVaultFiles(d, { 'tasks/t1/log.md': 'a' })
    expect(readFileSync(path.join(d, 'tasks/t1/log.md'), 'utf8')).toBe('a')
  })

  it('never rewrites an existing plan version (write-once protects edits)', () => {
    const d = vault()
    writeVaultFiles(d, { 'tasks/t1/plan-v1.md': 'original' })
    writeVaultFiles(d, { 'tasks/t1/plan-v1.md': 'regenerated' })
    expect(readFileSync(path.join(d, 'tasks/t1/plan-v1.md'), 'utf8')).toBe('original')
  })

  it('overwrites a hand-edited projection-only file (disposable)', () => {
    const d = vault()
    writeVaultFiles(d, { 'tasks/t1/log.md': 'v1' })
    writeFileSync(path.join(d, 'tasks/t1/log.md'), 'HAND EDIT')
    writeVaultFiles(d, { 'tasks/t1/log.md': 'v2' })
    expect(readFileSync(path.join(d, 'tasks/t1/log.md'), 'utf8')).toBe('v2')
  })
})
