import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, MemoryNote, MEMORY_ID_RE } from './memory'

describe('MemoryNoteInput', () => {
  it('accepts a minimal note and applies array/string defaults', () => {
    const n = MemoryNoteInput.parse({ id: 'auth-token-refresh', title: 'Auth token refresh' })
    expect(n.scope).toBe('project')
    expect(n.categories).toEqual([])
    expect(n.tags).toEqual([])
    expect(n.links).toEqual([])
    expect(n.paths).toEqual([])
    expect(n.rules).toEqual([])
    expect(n.summary).toBe('')
    expect(n.body).toBe('')
  })

  it('rejects an id with illegal characters', () => {
    expect(MemoryNoteInput.safeParse({ id: 'Auth Token', title: 'x' }).success).toBe(false)
    expect(MEMORY_ID_RE.test('auth-token-refresh')).toBe(true)
    expect(MEMORY_ID_RE.test('Auth')).toBe(false)
  })

  it('MemoryNote extends input with derived provenance/lifecycle', () => {
    const full = MemoryNote.parse({
      id: 'x', title: 'X',
      createdAt: '2026-07-18T00:00:00Z', createdBy: 'cli',
      updatedAt: '2026-07-18T00:00:00Z', updatedBy: 'cli', revision: 1,
    })
    expect(full.revision).toBe(1)
  })
})
