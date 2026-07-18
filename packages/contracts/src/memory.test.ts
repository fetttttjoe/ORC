import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, MemoryNote, MEMORY_ID_RE, LINK_KINDS } from './memory'
import { PAYLOAD_SCHEMAS } from './events'

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

  it('accepts a typed link with kind + optional confidence', () => {
    const n = MemoryNoteInput.parse({ id: 'a', title: 'A', links: [{ id: 'b', kind: 'supersedes', confidence: 0.9 }] })
    expect(n.links[0]).toEqual({ id: 'b', kind: 'supersedes', confidence: 0.9 })
  })

  it('defaults a typed link kind to relates_to and rejects a bad kind / out-of-range confidence', () => {
    expect(MemoryNoteInput.parse({ id: 'a', title: 'A', links: [{ id: 'b' }] }).links[0].kind).toBe('relates_to')
    expect(MemoryNoteInput.safeParse({ id: 'a', title: 'A', links: [{ id: 'b', kind: 'nope' }] }).success).toBe(false)
    expect(MemoryNoteInput.safeParse({ id: 'a', title: 'A', links: [{ id: 'b', confidence: 2 }] }).success).toBe(false)
    expect(LINK_KINDS).toContain('supersedes')
  })

  it('rejects a bare string id — links are typed objects only (no back-compat)', () => {
    expect(MemoryNoteInput.safeParse({ id: 'a', title: 'A', links: ['b'] }).success).toBe(false)
  })

  it('memory_written payload carries typed links (and rejects bare strings) with no events.ts change', () => {
    expect(PAYLOAD_SCHEMAS.memory_written.safeParse({ note: { id: 'a', title: 'A', links: [{ id: 'b', kind: 'refines' }] }, author: { source: 'cli' } }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.memory_written.safeParse({ note: { id: 'a', title: 'A', links: ['b'] }, author: { source: 'cli' } }).success).toBe(false)
  })

  it('MemoryNote extends input with derived provenance/lifecycle', () => {
    const full = MemoryNote.parse({
      id: 'x', title: 'X',
      createdAt: '2026-07-18T00:00:00Z', createdBy: 'cli',
      updatedAt: '2026-07-18T00:00:00Z', updatedBy: 'cli', revision: 1,
    })
    expect(full.revision).toBe(1)
  })

  it('kind defaults to fact and sourceRevision to null', () => {
    const n = MemoryNoteInput.parse({ id: 'x', title: 'X' })
    expect(n.kind).toBe('fact')
    expect(n.sourceRevision).toBeNull()
    expect(MemoryNoteInput.safeParse({ id: 'x', title: 'X', kind: 'architecture_target' }).success).toBe(true)
    expect(MemoryNoteInput.safeParse({ id: 'x', title: 'X', kind: 'vibes' }).success).toBe(false)
  })

  it("reserves project-scope note id 'index' (collides with vault/memory/index.md)", () => {
    expect(MemoryNoteInput.safeParse({ id: 'index', title: 'X' }).success).toBe(false)
    expect(MemoryNoteInput.safeParse({ id: 'index', scope: 'other', title: 'X' }).success).toBe(true)
  })
})
