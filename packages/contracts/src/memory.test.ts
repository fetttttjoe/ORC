import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, MemoryNote, MEMORY_ID_RE, LINK_KINDS, NOTE_TIER, inferTier, type PlanNoteInput, type SemanticNoteInput } from './memory'
import { PAYLOAD_SCHEMAS } from './events'

// The tier discriminates the union, so a test that asserts tier-specific fields has to say which
// lane it is in. These parse through the real union (inference included) and then narrow, so a
// note that lands in the wrong lane fails the test loudly instead of type-erroring at compile time.
const semantic = (draft: unknown): SemanticNoteInput => {
  const n = MemoryNoteInput.parse(draft)
  if (n.tier !== NOTE_TIER.semantic) throw new Error(`expected a semantic note, got '${n.tier}'`)
  return n
}
const plan = (draft: unknown): PlanNoteInput => {
  const n = MemoryNoteInput.parse(draft)
  if (n.tier !== NOTE_TIER.plan) throw new Error(`expected a plan note, got '${n.tier}'`)
  return n
}

describe('note tiers', () => {
  // The lane a writer never named is derived from the shape it wrote — this is what lets every
  // event appended before the split still fold, and it must not re-label anything by accident.
  it('classifies an unlabelled note from the shape its writer produced', () => {
    expect(inferTier({ id: 'a', title: 'A' })).toBe('semantic')
    expect(inferTier({ id: 'a', title: 'A', scope: 'project', retention: 'expirable' })).toBe('semantic')
    expect(inferTier({ id: 'a', title: 'A', scope: 'plan-t1', retention: 'expirable' })).toBe('episodic')
    expect(inferTier({ id: 'a', title: 'A', scope: 'plan-t1', kind: 'plan' })).toBe('plan')
    expect(inferTier({ id: 'a', title: 'A', zone: ['docs/**'] })).toBe('plan')
    expect(inferTier({ id: 'a', title: 'A', rationale: 'because' })).toBe('plan')
    expect(inferTier({ id: 'a', title: 'A', uncertainty: ['unknown'] })).toBe('plan')
    expect(inferTier('not an object')).toBe('semantic')
  })

  it('an explicit tier always wins over inference', () => {
    // a plan-shaped payload the author labelled semantic keeps the label — and loses the fields
    // that lane does not have, rather than being silently re-laned
    const n = MemoryNoteInput.parse({ tier: 'semantic', id: 'a', title: 'A', zone: ['docs/**'] })
    expect(n.tier).toBe('semantic')
    expect(n).not.toHaveProperty('zone')
  })

  // The episodic lane's sweepability is structural, not conventional: no writer can mint a step
  // note the TTL sweep will never be allowed to touch.
  it('pins episodic retention to expirable and rejects an attempt to make one durable', () => {
    const n = MemoryNoteInput.parse({ tier: 'episodic', id: 'step-a', scope: 'plan-t1', title: 'Step A' })
    expect(n.retention).toBe('expirable')
    expect(MemoryNoteInput.safeParse({ tier: 'episodic', id: 'step-a', scope: 'plan-t1', title: 'Step A', retention: 'durable' }).success).toBe(false)
  })

  it('each tier keeps only its own fields', () => {
    const s = semantic({ id: 'a', title: 'A', rules: ['never do Y'] })
    expect(s.rules).toEqual(['never do Y'])
    expect(s).not.toHaveProperty('zone')
    const p = plan({ id: 'b', title: 'B', zone: ['docs/**'], rules: ['never do Y'] })
    expect(p.zone).toEqual(['docs/**'])
    expect(p).not.toHaveProperty('rules')
    const e = MemoryNoteInput.parse({ tier: 'episodic', id: 'c', scope: 'plan-t1', title: 'C', rules: ['x'], zone: ['y'] })
    expect(e).not.toHaveProperty('rules')
    expect(e).not.toHaveProperty('zone')
  })
})

describe('MemoryNoteInput', () => {
  it('accepts a minimal note and applies array/string defaults', () => {
    const n = semantic({ id: 'auth-token-refresh', title: 'Auth token refresh' })
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
    const n = semantic({
      id: 'finding', title: 'Finding',
      sources: [{ url: 'https://example.test/a' }, { url: 'http://example.test/b', title: 'B' }],
    })
    expect(n.sources).toEqual([{ url: 'https://example.test/a' }, { url: 'http://example.test/b', title: 'B' }])
    expect(semantic({ id: 'plain', title: 'Plain' }).sources).toEqual([])
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
    const n = semantic({
      id: 'finding', title: 'Finding', kind: 'research',
      sources: [{ url: 'https://example.test/a', retrievedAt: '1999-01-01T00:00:00.000Z' }],
    })
    expect(n.sources[0]).not.toHaveProperty('retrievedAt')
  })

  it('requires at least one citation for kind research, and only for research', () => {
    expect(() => MemoryNoteInput.parse({ id: 'r', title: 'R', kind: 'research' })).toThrow()
    expect(semantic({
      id: 'r', title: 'R', kind: 'research', sources: [{ url: 'https://example.test/a' }],
    }).kind).toBe('research')
    // every other kind may cite, or not
    expect(semantic({ id: 'f', title: 'F', kind: 'fact' }).sources).toEqual([])
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
    const n = semantic({ id: 'coerce', title: 'Coerce', paths: 'src/x.ts', tags: 'Postgres', rules: 'never do Y', categories: 'arch' })
    expect(n.paths).toEqual(['src/x.ts'])
    expect(n.tags).toEqual(['postgres']) // item normalization still applies
    expect(n.rules).toEqual(['never do Y'])
    expect(n.categories).toEqual(['arch'])
    const p = plan({ id: 'coerce-plan', title: 'Coerce plan', uncertainty: 'untested', zone: 'docs/**' })
    expect(p.uncertainty).toEqual(['untested'])
    expect(p.zone).toEqual(['docs/**'])
    expect(MemoryNoteInput.safeParse({ id: 'x', title: 'X', links: 'other-note' }).success).toBe(false)
  })

  it("collapses an explicit empty string to [] (the model's clear spelling), never a junk [''] entry", () => {
    const n = semantic({ id: 'clear', title: 'Clear', categories: '', tags: '', paths: '', rules: '' })
    expect(n.categories).toEqual([])
    expect(n.tags).toEqual([])
    expect(n.paths).toEqual([])
    expect(n.rules).toEqual([])
    expect(n.categories).not.toContain('') // the regression: '' → [''] would render junk in the vault
    expect(plan({ tier: 'plan', id: 'clear-plan', title: 'Clear plan', uncertainty: '' }).uncertainty).toEqual([])
    // zone keeps its own min(1) item, so '' still rejects there (an empty glob is meaningless)
    expect(MemoryNoteInput.safeParse({ tier: 'plan', id: 'z', title: 'Z', zone: '' }).success).toBe(false)
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
    expect(full.tier).toBe('semantic')
  })

  it('kind defaults to fact and sourceRevision to null', () => {
    const n = semantic({ id: 'x', title: 'X' })
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
