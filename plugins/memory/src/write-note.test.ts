import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeMemoryFile, deleteMemoryFile } from './write-note'

describe('memory writer', () => {
  it('writes atomically under vault/memory and refuses escapes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    writeMemoryFile(dir, 'auth.md', 'hi')
    expect(readFileSync(path.join(dir, 'memory', 'auth.md'), 'utf8')).toBe('hi')
    deleteMemoryFile(dir, 'auth.md')
    expect(existsSync(path.join(dir, 'memory', 'auth.md'))).toBe(false)
    expect(() => writeMemoryFile(dir, '../escape.md', 'x')).toThrow(/escapes/)
  })

  it('ignores a stale shared temp path left by another writer', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    const memoryDir = path.join(dir, 'memory')
    mkdirSync(path.join(memoryDir, 'auth.md.tmp'), { recursive: true })

    writeMemoryFile(dir, 'auth.md', 'complete')

    expect(readFileSync(path.join(memoryDir, 'auth.md'), 'utf8')).toBe('complete')
    expect(readdirSync(memoryDir).filter(name => name.endsWith('.tmp'))).toEqual(['auth.md.tmp'])
  })
})
