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

  // Captured at write time because that is the only moment the author's judgment exists; a note
  // nobody classified must never become auto-deletable, so the default is durable.
  it('defaults retention to durable and accepts an explicit expirable', () => {
    expect(MemoryNoteInput.parse({ id: 'a', title: 'A' }).retention).toBe('durable')
    expect(MemoryNoteInput.parse({ id: 'a', title: 'A', retention: 'expirable' }).retention).toBe('expirable')
    expect(() => MemoryNoteInput.parse({ id: 'a', title: 'A', retention: 'forever' })).toThrow()
  })

  // A finding pulled off the web is only knowledge if its provenance survives with it. These
  // bounds run before memory_written is appended, so a malformed citation never reaches history.
  it('accepts bounded credential-free http(s) citations', () => {
    const n = MemoryNoteInput.parse({
      id: 'finding', title: 'Finding',
      sources: [{ url: 'https://example.test/a' }, { url: 'http://example.test/b', title: 'B' }],
    })
    expect(n.sources).toEqual([{ url: 'https://example.test/a' }, { url: 'http://example.test/b', title: 'B' }])
    expect(MemoryNoteInput.parse({ id: 'plain', title: 'Plain' }).sources).toEqual([])
  })

  it('rejects unsafe or unbounded citations', () => {
    const note = { id: 'bounded', title: 'Bounded' }
    const invalid = [
      { sources: Array(21).fill({ url: 'https://example.test/a' }) },     // over the 20 cap
      { sources: [{ url: `https://example.test/${'x'.repeat(2_048)}` }] }, // over 2048 chars
      { sources: [{ url: 'https://example.test/a', title: 'x'.repeat(301) }] },
      { sources: [{ url: 'ftp://example.test/a' }] },                      // not http(s)
      { sources: [{ url: 'javascript:alert(1)' }] },
      { sources: [{ url: 'file:///etc/passwd' }] },
      { sources: [{ url: 'https://user:pw@example.test/a' }] },            // embedded credentials
      { sources: [{ url: 'not a url at all' }] },
    ]
    for (const over of invalid) expect(() => MemoryNoteInput.parse({ ...note, ...over })).toThrow()
  })

  // retrievedAt is derived from the canonical memory_written event timestamp by the projector —
  // an agent must not be able to claim when it fetched something.
  it("a writer cannot supply a citation's retrievedAt", () => {
    const n = MemoryNoteInput.parse({
      id: 'finding', title: 'Finding', kind: 'research',
      sources: [{ url: 'https://example.test/a', retrievedAt: '1999-01-01T00:00:00.000Z' }],
    })
    expect(n.sources[0]).not.toHaveProperty('retrievedAt')
  })

  it('requires at least one citation for kind research, and only for research', () => {
    expect(() => MemoryNoteInput.parse({ id: 'r', title: 'R', kind: 'research' })).toThrow()
    expect(MemoryNoteInput.parse({
      id: 'r', title: 'R', kind: 'research', sources: [{ url: 'https://example.test/a' }],
    }).kind).toBe('research')
    // every other kind may cite, or not
    expect(MemoryNoteInput.parse({ id: 'f', title: 'F', kind: 'fact' }).sources).toEqual([])
  })

  // search lowercases the query before matching tags, while the list/ls filter compares
  // case-exactly — an un-normalized tag is reachable from one path and invisible to the other.
  it('lowercases tags so search and filter agree', () => {
    const n = MemoryNoteInput.parse({ id: 'db-choice', title: 'DB choice', tags: ['Postgres', 'MIXED-Case'] })
    expect(n.tags).toEqual(['postgres', 'mixed-case'])
  })

  // Models write `paths: "src/x.ts"` for `paths: ["src/x.ts"]` often enough to cost real
  // iterations — the scalar is the same intent, so it coerces instead of failing the write.
  // Object arrays (links/sources) stay strict: a bare string there is a shape mistake.
  it('accepts a bare string as a one-element list for string-array fields', () => {
    const n = MemoryNoteInput.parse({
      id: 'coerce', title: 'Coerce', paths: 'src/x.ts', tags: 'Postgres', rules: 'never do Y',
      categories: 'arch', uncertainty: 'untested', zone: 'docs/**',
    })
    expect(n.paths).toEqual(['src/x.ts'])
    expect(n.tags).toEqual(['postgres']) // item normalization still applies
    expect(n.rules).toEqual(['never do Y'])
    expect(n.categories).toEqual(['arch'])
    expect(n.uncertainty).toEqual(['untested'])
    expect(n.zone).toEqual(['docs/**'])
    expect(MemoryNoteInput.safeParse({ id: 'x', title: 'X', links: 'other-note' }).success).toBe(false)
  })

  it('rejects notes above persisted collection and text limits', () => {
    const note = { id: 'bounded', title: 'Bounded' }
    const invalid = [
      { categories: Array(51).fill('x') },
      { categories: ['x'.repeat(65)] },
      { tags: Array(51).fill('x') },
      { tags: ['x'.repeat(65)] },
      { links: Array.from({ length: 101 }, (_, i) => ({ id: `n-${i}` })) },
      { paths: Array(101).fill('x') },
      { paths: ['x'.repeat(1001)] },
      { rules: Array(101).fill('x') },
      { rules: ['x'.repeat(1001)] },
      { uncertainty: Array(101).fill('x') },
      { uncertainty: ['x'.repeat(1001)] },
      { body: 'x'.repeat(100_001) },
      { rationale: 'x'.repeat(20_001) },
    ]
    for (const value of invalid)
      expect(MemoryNoteInput.safeParse({ ...note, ...value }).success).toBe(false)
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

  it('accepts a decomposes_into typed link (M5b plan-graph edges)', () => {
    const n = MemoryNoteInput.parse({ id: 'a', title: 'A', links: [{ id: 'subplan-1', kind: 'decomposes_into' }] })
    expect(n.links[0]).toEqual({ id: 'subplan-1', kind: 'decomposes_into' })
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
