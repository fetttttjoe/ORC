import { describe, expect, it } from 'bun:test'
import { MemoryNoteDraftInput, MemoryNoteInput, MemoryNote, MEMORY_ID_RE, MEMORY_USE, USE_VERDICT, LINK_KINDS, MemoryScope, NOTE_TIER, VerifiedStamp, deriveNoteProvenance, foldMemory, inferTier, noteContentKey, noteKey, parseLinkSpec, useLine, useVerdict, type MemoryUseOutcome, type PlanNoteInput, type SemanticNoteInput, type UseStats } from './memory'
import { EVENT_KIND } from './event-kinds'
import { PAYLOAD_SCHEMAS } from './events'
import { TEST_WORKSPACE_ID } from './fixtures'

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
    // a real claim, so 'not.toHaveProperty(claims)' below has something to actually strip —
    // an absent field would make the assertion true no matter what the tier schema does
    const aClaim = { id: 'a'.repeat(12), text: 'x', sourceRevision: null }
    const s = semantic({ id: 'a', title: 'A' })
    expect(s).not.toHaveProperty('zone')
    const p = plan({ id: 'b', title: 'B', zone: ['docs/**'], claims: [aClaim] })
    expect(p.zone).toEqual(['docs/**'])
    expect(p).not.toHaveProperty('claims')
    const e = MemoryNoteInput.parse({ tier: 'episodic', id: 'c', scope: 'plan-t1', title: 'C', zone: ['y'], claims: [aClaim] })
    expect(e).not.toHaveProperty('claims')
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
    expect(n.claims).toEqual([])
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
    const n = semantic({ id: 'coerce', title: 'Coerce', paths: 'src/x.ts', tags: 'Postgres', categories: 'arch' })
    expect(n.paths).toEqual(['src/x.ts'])
    expect(n.tags).toEqual(['postgres']) // item normalization still applies
    expect(n.categories).toEqual(['arch'])
    const p = plan({ id: 'coerce-plan', title: 'Coerce plan', uncertainty: 'untested', zone: 'docs/**' })
    expect(p.uncertainty).toEqual(['untested'])
    expect(p.zone).toEqual(['docs/**'])
    expect(MemoryNoteInput.safeParse({ id: 'x', title: 'X', links: 'other-note' }).success).toBe(false)
  })

  it("collapses an explicit empty string to [] (the model's clear spelling), never a junk [''] entry", () => {
    const n = semantic({ id: 'clear', title: 'Clear', categories: '', tags: '', paths: '' })
    expect(n.categories).toEqual([])
    expect(n.tags).toEqual([])
    expect(n.paths).toEqual([])
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
    expect(PAYLOAD_SCHEMAS.memory_written.safeParse({ note: { id: 'a', title: 'A', links: [{ id: 'b', kind: 'refines' }] }, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.memory_written.safeParse({ note: { id: 'a', title: 'A', links: ['b'] }, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } }).success).toBe(false)
  })

  it('MemoryNote extends input with derived provenance/lifecycle', () => {
    const full = MemoryNote.parse({
      id: 'x', title: 'X',
      createdAt: '2026-07-18T00:00:00Z', createdBy: 'cli',
      updatedAt: '2026-07-18T00:00:00Z', updatedBy: 'cli', revision: 1,
      workspaceId: TEST_WORKSPACE_ID,
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

describe('parseLinkSpec', () => {
  it('parses bare ids and kind:id entries, defaulting kind by omission', () => {
    expect(parseLinkSpec('other-note')).toEqual([{ id: 'other-note' }])
    expect(parseLinkSpec('supersedes:old-note, other-note')).toEqual([
      { id: 'old-note', kind: 'supersedes' }, { id: 'other-note' },
    ])
    expect(parseLinkSpec('  ')).toEqual([])
  })
  it('rejects unknown kinds and malformed ids, naming the bad entry', () => {
    expect(() => parseLinkSpec('replaces:x')).toThrow(/unknown link kind 'replaces'/)
    expect(() => parseLinkSpec('supersedes:Bad Id')).toThrow(/not a valid note id/)
  })
})

// ─── the verification stamp ───────────────────────────────────────────────────────────────────
//
// The rule the whole feature rests on: verification is DECLARED by an explicit act (memory_verify →
// a memory_verified event), never INFERRED from authorship. A write can only carry an existing
// stamp forward or destroy it, so these pin both directions — a heal that carried a stale "checked"
// forward would be exactly the false confidence the stamp exists to prevent.
describe('VerifiedStamp on note provenance', () => {
  const author = { source: 'cli', workspaceId: TEST_WORKSPACE_ID } as const
  const stamp = { revision: 'c0ffee1', at: '2026-07-01T00:00:00.000Z', by: 'cli' }
  const draft = { id: 'auth-flow', title: 'Auth flow', summary: 's', body: 'b', paths: ['src/auth.ts'] }
  // `prev` is what a projected row hands deriveNoteProvenance: the note's content plus the
  // provenance columns, sources already stamped with the retrievedAt the projector derived.
  const note = MemoryNoteInput.parse(draft)
  const stored = { ...note, sources: [], createdAt: 't0', createdBy: 'cli', revision: 3 }

  it('carries an existing verified forward when the write changes no content', () => {
    // the motivating case: the commit restamp writes the note back with NO fields supplied, purely
    // to move sourceRevision to the new HEAD. That must not destroy the auditor's verification.
    const prev = { ...stored, verified: stamp }
    const restamped = MemoryNoteInput.parse({ ...draft, sourceRevision: 'newhead' })
    expect(deriveNoteProvenance(restamped, author, 't1', prev).verified).toEqual(stamp)
  })

  it('CLEARS verified when any content field changed — a heal never carries a stale check forward', () => {
    const prev = { ...stored, verified: stamp }
    for (const changed of [{ body: 'rewritten' }, { summary: 'new' }, { title: 'Renamed' }, { paths: ['src/other.ts'] }, { tags: ['x'] }]) {
      const next = MemoryNoteInput.parse({ ...draft, ...changed })
      expect(deriveNoteProvenance(next, author, 't1', prev)).not.toHaveProperty('verified')
    }
  })

  it('NO write path ever SETS verified — only memory_verify declares one', () => {
    // no previous stamp in, no stamp out: the field is absent, not defaulted, so a note that was
    // never verified cannot read as verified on any surface.
    expect(deriveNoteProvenance(note, author, 't1')).not.toHaveProperty('verified')
    expect(deriveNoteProvenance(note, author, 't1', stored)).not.toHaveProperty('verified')
  })

  it('is not authorable: `verified` is absent from the write draft surface', () => {
    // DraftCoversTiers stays satisfied because `verified` is PROVENANCE, not a tier field — an
    // agent that could pass it would be inferring its own verification.
    expect(Object.keys(MemoryNoteDraftInput.shape)).not.toContain('verified')
    expect(MemoryNoteInput.parse({ ...draft, verified: stamp })).not.toHaveProperty('verified')
  })

  it('parses onto a stored note of every tier, and rejects an empty revision', () => {
    expect(VerifiedStamp.safeParse({ revision: '', at: 't', by: 'cli' }).success).toBe(false)
    const stored = { createdAt: 't', createdBy: 'cli', updatedAt: 't', updatedBy: 'cli', revision: 1, workspaceId: TEST_WORKSPACE_ID }
    for (const d of [draft, { id: 'x', title: 'X', scope: 'plan-a', retention: 'expirable' }, { id: 'y', title: 'Y', rationale: 'why' }])
      expect(MemoryNote.parse({ ...MemoryNoteInput.parse(d), ...stored, verified: stamp })).toHaveProperty('verified', stamp)
  })

  // The FOLD half of the same rule. The read model applied memory_verified (surreal.ts) while the
  // fold ignored the event entirely, so `orc memory recheck` and `archiveCandidates` — both of which
  // rule off foldMemory — could never see a verification. Measured live on a 84-note corpus: recheck
  // reported 30 drifted where health reported 29, the gap being the one note an auditor had just
  // confirmed. Two spellings of one verdict is exactly what deriveNoteProvenance exists to prevent.
  // `draft.id` and MemoryScope.project address the SAME note in the write, the verify and the
  // lookup — spelled once, because a fold keyed on a mistyped scope returns undefined and every
  // assertion below would read as "the stamp did not arrive" rather than "the test is wrong".
  const KEY = noteKey(MemoryScope.project, draft.id)
  const wrote = (d: unknown, ts: string) => ({ kind: EVENT_KIND.memory_written, ts, payload: { note: d, author, invalidates: [] } })
  const checked = (id: string, ts: string) => ({ kind: EVENT_KIND.memory_verified, ts, payload: { id, scope: MemoryScope.project, stamp, author } })
  const foldedNote = (evs: Parameters<typeof foldMemory>[0]) => foldMemory(evs).notes.get(KEY)?.note

  it('a memory_verified event stamps the folded note', () => {
    expect(foldedNote([wrote(draft, 't0'), checked(draft.id, 't1')])).toHaveProperty('verified', stamp)
  })

  it('the fold carries a stamp across a contentless rewrite and clears it on a real edit', () => {
    // the commit restamp: only sourceRevision moves, so the auditor's check survives
    expect(foldedNote([wrote(draft, 't0'), checked(draft.id, 't1'), wrote({ ...draft, sourceRevision: 'newhead' }, 't2')]))
      .toHaveProperty('verified', stamp)
    // a heal rewrites the body — the stamp asserts an auditor read THAT text, so it must not survive
    expect(foldedNote([wrote(draft, 't0'), checked(draft.id, 't1'), wrote({ ...draft, body: 'rewritten' }, 't2')]))
      .not.toHaveProperty('verified')
  })

  it('a verification of a note the fold never saw written creates nothing', () => {
    expect(foldMemory([checked('ghost', 't1')]).notes.size).toBe(0)
  })

  it('noteContentKey ignores provenance and address, and moves with what the note SAYS', () => {
    const key = (d: unknown) => noteContentKey(MemoryNoteInput.parse(d))
    // sourceRevision is re-stamped from HEAD on every write, so it cannot be content
    expect(key({ ...draft, sourceRevision: 'aaa' })).toBe(key({ ...draft, sourceRevision: 'bbb' }))
    expect(key(draft)).not.toBe(key({ ...draft, body: 'different' }))
    // a citation's retrievedAt is provenance the projector stamps; the URL is content
    const cited = { id: 'r', title: 'R', kind: 'research', sources: [{ url: 'https://x.test/a' }] }
    expect(noteContentKey({ ...MemoryNoteInput.parse(cited), sources: [{ url: 'https://x.test/a', retrievedAt: 't9' }] }))
      .toBe(key(cited))
    expect(key({ ...cited, sources: [{ url: 'https://x.test/b' }] })).not.toBe(key(cited))
  })
})

describe('memory_verified event', () => {
  it('has a payload schema keyed by its own event kind', () => {
    const payload = {
      id: 'auth-flow', scope: 'project',
      stamp: { revision: 'c0ffee1', at: '2026-07-01T00:00:00.000Z', by: 'cli' },
      author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID },
    }
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_verified].safeParse(payload).success).toBe(true)
    // id/scope index the read model by key, same MEMORY_ID_RE guard memory_deleted carries
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_verified].safeParse({ ...payload, id: '../x' }).success).toBe(false)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_verified].safeParse({ ...payload, stamp: { at: 't', by: 'cli' } }).success).toBe(false)
  })
})

describe('memory_outcome event', () => {
  const author = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't-1' }
  const note = { id: 'auth-flow', title: 'Auth', summary: 's', body: 'b' }
  const KEY = noteKey(MemoryScope.project, note.id)
  const wrote = (ts: string) => ({ kind: EVENT_KIND.memory_written, ts, payload: { note, author, invalidates: [] } })
  const used = (id: string, outcome: MemoryUseOutcome, ts?: string) =>
    ({ kind: EVENT_KIND.memory_outcome, ...(ts !== undefined && { ts }), payload: { id, scope: MemoryScope.project, outcome, author } })

  it('has a payload schema keyed by its own event kind', () => {
    const payload = { id: 'auth-flow', scope: 'project', outcome: MEMORY_USE.useful, author: { source: 'agent', workspaceId: TEST_WORKSPACE_ID } }
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_outcome].safeParse(payload).success).toBe(true)
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_outcome].safeParse({ ...payload, outcome: MEMORY_USE.dead_end }).success).toBe(true)
    // no third value: a correction is a heal or a link, never a score — 'corrected' is spelled raw
    // here precisely because it must never exist in the vocabulary
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_outcome].safeParse({ ...payload, outcome: 'corrected' }).success).toBe(false)
    // id/scope index the read model by key, same MEMORY_ID_RE guard memory_deleted carries
    expect(PAYLOAD_SCHEMAS[EVENT_KIND.memory_outcome].safeParse({ ...payload, id: '../x' }).success).toBe(false)
  })

  it('folds per-note use stats, the two outcomes never netted into one score', () => {
    const fold = foldMemory([wrote('t0'), used(note.id, MEMORY_USE.useful, 't1'), used(note.id, MEMORY_USE.useful, 't2'), used(note.id, MEMORY_USE.dead_end, 't3')])
    expect(fold.outcomes.get(KEY)).toEqual({
      useful: { hits: 2, lastAccessedAt: 't2' },
      deadEnd: { hits: 1, lastAccessedAt: 't3' },
    })
  })

  it('an undated outcome contributes nothing — zero weight, never full weight', () => {
    // the reference implementation gave an unparseable-date record decay weight 1.0 FOREVER,
    // letting one malformed doc outrank every real signal; we fail the other way, like access
    expect(foldMemory([wrote('t0'), used(note.id, MEMORY_USE.useful)]).outcomes.size).toBe(0)
  })

  it('an outcome for a note nothing wrote still folds — evidence keyed independently, like access', () => {
    // read-then-write guards the read model; the fold keeps the stats so a later restore sees them
    expect(foldMemory([used('ghost', MEMORY_USE.dead_end, 't1')]).outcomes.get(noteKey(MemoryScope.project, 'ghost')))
      .toEqual({ useful: { hits: 0, lastAccessedAt: null }, deadEnd: { hits: 1, lastAccessedAt: 't1' } })
  })
})

describe('useVerdict', () => {
  const stats = (useful: number, deadEnd: number): UseStats => ({
    useful: { hits: useful, lastAccessedAt: useful > 0 ? 't1' : null },
    deadEnd: { hits: deadEnd, lastAccessedAt: deadEnd > 0 ? 't2' : null },
  })

  it('one useful record is an anecdote, two are corroboration', () => {
    expect(useVerdict(stats(1, 0))).toBe(USE_VERDICT.tentative)
    expect(useVerdict(stats(2, 0))).toBe(USE_VERDICT.preferred)
    expect(useVerdict(stats(5, 0))).toBe(USE_VERDICT.preferred)
  })

  it('any disagreement is contested — corroboration never outvotes a dead-end report', () => {
    expect(useVerdict(stats(5, 1))).toBe(USE_VERDICT.contested)
    expect(useVerdict(stats(1, 1))).toBe(USE_VERDICT.contested)
  })

  it('no useful evidence yields no verdict — dead-end-only is counts, never a status', () => {
    expect(useVerdict(stats(0, 0))).toBeNull()
    expect(useVerdict(stats(0, 3))).toBeNull()
  })

  it('useLine spells contested as BOTH counts, never a net score', () => {
    expect(useLine(stats(2, 1))).toBe('contested (useful 2 / dead-end 1)')
    expect(useLine(stats(3, 0))).toBe('preferred (3 useful)')
    expect(useLine(stats(1, 0))).toBe('tentative (1 useful)')
    expect(useLine(stats(0, 2))).toBe('dead-end reported (2)')
    expect(useLine(stats(0, 0))).toBeNull()
  })
})
