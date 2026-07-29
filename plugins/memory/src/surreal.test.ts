import { afterAll, describe, expect, it } from 'bun:test'
import { RecordId, Surreal } from 'surrealdb'
import { claimId, EVENT_KIND, LINK_KIND, MEMORY_ACCESS, MemoryScope, PROJECT_NAME_NOTE_ID, isRecord, type AccessVia, type EventKind, type EventRecord, type MemoryAccessMode, type MemoryAuthor, type MemoryNote, type NoteView } from '@orc/contracts'
import { SurrealMemory } from './surreal'
import { eventFixture } from '@orc/contracts/fixtures'
import { createTestSurreal } from './test-helpers'

const note = (over = {}) => ({
  id: 'auth', scope: 'project', kind: 'fact', sourceRevision: null,
  title: 'Auth', categories: ['security'], tags: ['auth'], links: [], paths: ['src/auth.ts'],
  summary: 'tokens rotate', body: 'full text about auth tokens', ...over,
})
// tier-specific columns read through the shared view: these tests assert on what the read model
// stored, not on which lane a fixture happened to land in
const view = (n: MemoryNote | null): NoteView | undefined => n ?? undefined
const cli: MemoryAuthor = { source: 'cli' }
const written = (seq: number, n = note(), author: MemoryAuthor = cli): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_written', payload: { note: n, author }, ts: `2026-07-18T0${Math.min(seq, 9)}:00:00Z` })
const deleted = (seq: number, id: string, scope = 'project'): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_deleted', payload: { id, scope, author: cli }, ts: `2026-07-18T0${Math.min(seq, 9)}:00:00Z` })
const accessed = (seq: number, id: string, mode: MemoryAccessMode = MEMORY_ACCESS.read, scope = 'project', via?: AccessVia): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_accessed', payload: { id, scope, mode, author: cli, ...(via && { via }) }, ts: `2026-07-18T0${Math.min(seq, 9)}:00:00Z` })

const drops: (() => Promise<void>)[] = []
// One throwaway Surreal database per test. Serial drops blew bun's default 5s hook budget as soon
// as the file grew another case (same fix and reason as main.test.ts's pg teardown) — the databases
// are distinct, so drop them concurrently and give the hook a real budget.
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

// Teardown must be unconditional: a bare `await m.close()` after the assertions is skipped the
// moment an expect above it throws, and the leaked websocket outlives the test file. Registering
// close beside the database drop makes a FAILING test clean up too.
const openMemory = async (...args: Parameters<typeof SurrealMemory.open>) => {
  const m = await SurrealMemory.open(...args)
  drops.push(() => m.close())
  return m
}

describe('SurrealMemory.applyEvent', () => {
  it('applies a write, reads it back, and increments revision on update', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    expect(await m.applyEvent(written(1))).toBe(true)
    let got = await m.get('auth', 'project')
    expect(got?.revision).toBe(1)
    expect(got?.createdBy).toBe('cli')
    expect(view(got)?.kind).toBe('fact')
    await m.applyEvent(written(2, note({ summary: 'rotate on use' }), { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' }))
    got = await m.get('auth', 'project')
    expect(got?.revision).toBe(2)
    expect(got?.createdBy).toBe('cli')            // unchanged
    expect(got?.updatedBy).toBe('api-loop·opus·review')
    expect(got?.summary).toBe('rotate on use')
  })

  // list() used to push the category predicate into the surqlize builder, where `.contains` on an
  // option-wrapped array resolves as a FIELD access (a ProxyObject), not the array method — so
  // `orc memory ls --category X` crashed while search's raw arms filtered the same field fine.
  // One spelling now: the builder narrows scope, matchesRow answers tier/category/tag.
  it('list filters by category, tag and tier without crashing on the option-wrapped column', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))
    expect((await m.list({ category: 'security' })).map(n => n.id)).toEqual(['auth'])
    expect(await m.list({ category: 'nope' })).toEqual([])
    expect((await m.list({ tag: 'auth' })).map(n => n.id)).toEqual(['auth'])
  })

  // A MemoryLink carries no scope, and both sides of the flow used to resolve it in the SOURCE's
  // scope: the projector pointed the edge at key(note.scope, l.id), traversal looked it up there.
  // So a plan note referring to durable project knowledge authored an edge that read as a
  // connection and returned nothing — 7 of 23 edges on a real grounded run, every one of them the
  // link carried memory actually depends on.
  it('a transient-scope note reaches the project note it links to; the reverse stays scoped', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1, note({ id: 'arch-overview', scope: MemoryScope.project, title: 'Architecture' })))
    await m.applyEvent(written(2, note({
      id: 'masterplan', scope: 'plan-t1', title: 'Masterplan',
      links: [{ id: 'arch-overview', kind: LINK_KIND.derived_from }],
    })))

    const reached = await m.neighbors('masterplan', { scope: 'plan-t1' })
    expect(reached.map(n => n.id)).toEqual(['arch-overview'])
    // the caller is told WHERE it was found, because reading it back needs the right scope
    expect(reached[0]?.scope).toBe(MemoryScope.project)
    expect(await m.get('arch-overview', reached[0]!.scope!)).not.toBeNull()

    // and the project lane is not polluted in return: a project traversal sees only its own edges,
    // so a transient plan's decomposition can never leak into durable recall
    expect(await m.neighbors('arch-overview', { scope: MemoryScope.project })).toEqual([])
  })

  it('redelivery is a no-op: same event twice leaves revision 1, one edge, cursor advanced once', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    const e = written(3, note({ id: 'a', links: [{ id: 'b', kind: 'supersedes' }] }))
    expect(await m.applyEvent(e)).toBe(true)
    expect(await m.applyEvent(e)).toBe(false) // seq <= cursor → rejected inside the transaction
    expect((await m.get('a', 'project'))?.revision).toBe(1)
    await m.applyEvent(written(4, note({ id: 'b' })))
    expect((await m.neighbors('a')).map(n => n.id)).toEqual(['b']) // exactly one edge
    expect(await m.getCursor()).toBe(4)
  })

  it('write → delete → stale write leaves the note deleted, no tombstone needed', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    const stale = written(1)
    await m.applyEvent(stale)
    await m.applyEvent(deleted(2, 'auth'))
    expect(await m.applyEvent(stale)).toBe(false) // ordered cursor rejects the redelivery
    expect(await m.get('auth', 'project')).toBeNull()
  })

  it('search matches on body/summary/title; delete removes', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))
    expect((await m.search('tokens')).map(n => n.id)).toEqual(['auth'])
    // case-insensitive: query is uppercase, stored summary/body are lowercase.
    expect((await m.search('TOKENS')).map(n => n.id)).toEqual(['auth'])
    await m.applyEvent(deleted(6, 'auth'))
    expect(await m.get('auth', 'project')).toBeNull()
  })

  it('search ranks whole-query coverage first, but does not require it', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))
    await m.applyEvent(written(2, note({ id: 'other', title: 'Sessions', summary: 'cookies expire', body: 'session cookie details' })))
    // terms scattered across title/summary/body — a whole-query substring match would miss.
    // 'other' reaches the quorum on 'auth' alone (it carries the fixture's default tag), and ranks
    // second: covering both terms in heavier fields is what wins, not covering them at all.
    expect((await m.search('rotate auth')).map(n => n.id)).toEqual(['auth', 'other'])
    // A term matching nowhere no longer rejects the note — it only costs it coverage. Requiring
    // every term is what made the arm silent on every query of 5+ terms (see the natural-language
    // test below); the quorum rule replaces it. Each note here carries exactly one of the two
    // terms, and 'other' wins on WHERE it carries it: summary (2) plus body (1) against 'auth's
    // summary alone. That body hit is also the analyzer at work — the query said 'cookies' and the
    // body says 'cookie', which the substring arm this replaced could not match.
    expect((await m.search('rotate cookies')).map(n => n.id)).toEqual(['other', 'auth'])
    // a query matching NOTHING is still empty — recall was widened, not made unconditional
    expect(await m.search('kubernetes helm')).toEqual([])
  })

  // The other end of the same rule. Dropping one-character tokens is right when they are noise
  // beside real terms, and wrong when they ARE the query: it left an empty term list, which matches
  // nothing, and `orc memory search x` reported "_no notes_" for a note tagged 'x'. Caught by the
  // CLI round-trip (packages/cli/src/main.test.ts) because only that test searches a single
  // character; it belongs here, at the layer that owns the rule.
  it('a single-character query still reaches a note tagged with that character', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1, note({ id: 'tagged', title: 'Untitled', summary: 'no mention', body: 'none', tags: ['x'] })))
    expect((await m.search('x')).map(n => n.id)).toEqual(['tagged'])
  })

  it('a long natural-language query still reaches the note it describes', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    // AND across every term made recall collapse with query length: measured on the live graph,
    // EVERY probe of 5+ terms returned nothing while 2-4 term queries worked. Agents ask questions,
    // not keywords, so the arm was silent exactly when it was needed.
    await m.applyEvent(written(1, note({
      id: 'zone-fence', title: 'Zone write-fence',
      summary: 'a step may only write inside the globs its plan declared',
    })))
    const hits = await m.search('the fence that stops a step writing outside the globs it declared')
    expect(hits.map(n => n.id)).toContain('zone-fence')
  })

  // The quorum is unit-tested pure in keyword.test.ts, but nothing pinned that keywordSearch
  // actually CALLS it: in every other fixture here, a note that reaches the OR'd WHERE also clears
  // half the terms, so deleting the filter left the whole suite green. This fixture separates the
  // two — 'auth' carries exactly one term of four and must be excluded even though the WHERE
  // matched it, while a note carrying all four survives.
  it('search drops a row that matched but carries fewer than half the query terms', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))                                            // title Auth, summary 'tokens rotate'
    await m.applyEvent(written(2, note({ id: 'both', title: 'Auth kubernetes', summary: 'helm charts' })))
    // 4 terms; 'auth' matches 1 (auth) → excluded, 'both' matches 4 (auth/kubernetes/helm/charts,
    // 'charts' also lands in summary alongside 'helm') → kept
    expect((await m.search('auth kubernetes helm charts')).map(n => n.id)).toEqual(['both'])
    // and the excluded note IS reachable — the exclusion is the quorum, not an empty match set
    expect((await m.search('auth tokens')).map(n => n.id)).toContain('auth')
  })

  it('search survives a long query — the term cap bounds what is sent', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))
    // Under the builder-nested WHERE this replaced, 40 terms threw SurrealDB's "Exceeded query
    // recursion depth limit" (observed live from an agent's long descriptive query). That is no
    // longer why the cap exists — the raw-string form takes 32 terms / 384 expressions without
    // complaint (measured, see keyword.ts) — but a query this long must still come back clean
    // rather than growing without bound.
    // ponytail: this asserts the RESULT, not the cap. Deleting MAX_SEARCH_TERMS still passes it,
    // because 40 nonsense terms match nothing either way. Pinning the cap itself needs a query
    // whose 9th+ term changes the answer; keyword.test.ts pins the term list length instead.
    const spam = Array.from({ length: 40 }, (_, i) => `zz${i}`).join(' ')
    expect(await m.search(spam)).toEqual([])
  })

  it('search ranks field-weighted relevance above recency', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    // older note matches in title+summary; newer one only deep in the body
    await m.applyEvent(written(1, note({ id: 'relevant', title: 'Token rotation', summary: 'tokens rotate on use' })))
    await m.applyEvent(written(2, note({ id: 'recent', title: 'Sessions', summary: 'cookie jar', body: 'mentions tokens once' })))
    expect((await m.search('tokens')).map(n => n.id)).toEqual(['relevant', 'recent'])
    // durable project notes outrank same-relevance transient plan-scope notes
    await m.applyEvent(written(3, note({ id: 'plannote', scope: 'plan-x', title: 'Token rotation', summary: 'tokens rotate on use' })))
    expect((await m.search('tokens'))[0].id).toBe('relevant')
  })

  it('materializes typed RELATE edges and ranks neighbours; delete removes edges', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1, note({ id: 'a', links: [{ id: 'b', kind: 'supersedes' }, { id: 'c', kind: 'relates_to' }] })))
    await m.applyEvent(written(2, note({ id: 'b' })))
    await m.applyEvent(written(3, note({ id: 'c' })))

    const nb = await m.neighbors('a', { depth: 2 })
    expect(nb.map(n => n.id)).toEqual(['b', 'c'])            // supersedes(1.0) ranked above relates_to(0.5)
    expect(nb[0]).toMatchObject({ id: 'b', via: 'supersedes' })
    expect((await m.neighbors('a', { kinds: ['supersedes'] })).map(n => n.id)).toEqual(['b'])
    expect((await m.neighbors('b')).map(n => n.id)).toContain('a') // reverse: what supersedes b (spec RG4)

    // re-writing a note re-materializes its out-edges (delete-then-RELATE), no duplicates
    await m.applyEvent(written(4, note({ id: 'a', links: [{ id: 'b', kind: 'supersedes' }] })))
    expect((await m.neighbors('a')).map(n => n.id)).toEqual(['b'])

    await m.applyEvent(deleted(5, 'a'))
    expect(await m.neighbors('a')).toEqual([])               // edges gone with the note
  })

  it('persists rationale/uncertainty through the read model (not just the event log)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1, note({ id: 'plan-db', rationale: 'why', uncertainty: ['schema unknown'] })))
    const got = await m.get('plan-db', 'project')
    expect(view(got)?.rationale).toBe('why')
    expect(view(got)?.uncertainty).toEqual(['schema unknown'])
  })

  // The cursor authorizes replay: applyEvent rejects e.seq <= cursor. So a clear that drops
  // content while leaving the cursor ahead of it is unrecoverable through the normal paths —
  // start()/catchUp() both drain zero and probeMemory reports healthy, because "no events after
  // the cursor" is legitimately true. Only an explicit second rebuild() would heal it.
  it('a failed clear never leaves the cursor ahead of the content it describes', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))
    expect(await m.getCursor()).toBe(1)

    // Fault injection: fail the SECOND delete of the clear. Injecting through the orm's
    // transaction seam (rather than the raw socket) is also the regression check — if clear()
    // ever goes back to independent statements, `insideTransaction` stays false.
    // ponytail: retained cast — `db` is a private field of SurrealMemory; TypeScript has no
    // cast-free read of a private member. Upgrade path: an internal/test-only accessor for the orm.
    const db = (m as unknown as { db: { transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> } }).db
    const realTransaction = db.transaction.bind(db)
    let insideTransaction = false
    db.transaction = (cb) => realTransaction(async (tx) => {
      insideTransaction = true
      if (!isRecord(tx) || typeof tx.delete !== 'function') throw new Error('transaction seam exposes no delete')
      const realDelete = tx.delete.bind(tx)
      let deletes = 0
      tx.delete = (...a: unknown[]) => {
        if (++deletes === 2) throw new Error('socket dropped')
        return realDelete(...a)
      }
      return cb(tx)
    })
    await m.clear().catch(() => {})
    db.transaction = realTransaction

    expect(insideTransaction).toBe(true) // clear() must apply its deletes atomically
    const cursor = await m.getCursor()
    const notes = await m.allNotes()
    expect(cursor === 0 || notes.length > 0).toBe(true)
  })

  // An agent must not be able to claim when it fetched a page, and a rebuild must reproduce the
  // stamp exactly — so retrievedAt comes from the canonical event ts, not from wall-clock time.
  it('stamps citation retrievedAt from the event timestamp, identically on redelivery', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    const cited = note({
      id: 'finding', kind: 'research',
      sources: [{ url: 'https://example.test/a', title: 'A' }, { url: 'https://example.test/b' }],
    })
    const e = written(1, cited)
    await m.applyEvent(e)
    const got = await m.get('finding', 'project')
    expect(view(got)?.sources).toEqual([
      { url: 'https://example.test/a', title: 'A', retrievedAt: e.ts },
      { url: 'https://example.test/b', title: undefined, retrievedAt: e.ts },
    ])
    // replaying the same history yields the same stamp — no wall-clock anywhere in the path
    await m.clear()
    await m.applyEvent(e)
    expect(view(await m.get('finding', 'project'))?.sources?.[0]?.retrievedAt).toBe(e.ts)
  })

  it('stores kind and sourceRevision; allNotes returns deterministic order', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1, note({ id: 'zz', kind: 'architecture_current', sourceRevision: 'abc123' })))
    await m.applyEvent(written(2, note({ id: 'aa', kind: 'architecture_target' })))
    const all = await m.allNotes()
    expect(all.map(n => n.id)).toEqual(['aa', 'zz'])
    expect(all[1]).toMatchObject({ kind: 'architecture_current', sourceRevision: 'abc123' })
    expect(all[0]?.sourceRevision).toBeNull()
  })

  // Access counts are canonical, not incidental: applying the event merges hits/lastAccessedAt
  // onto the row without wiping the authored fields, and lastAccessedAt comes from the event ts
  // so a replay lands on the same value. hits/lastAccessedAt are dropped from the public
  // MemoryNote (see toNote), so they're checked via a raw peek at the row.
  const rawRow = async (t: { url: string; ns: string; db: string; username: string; password: string }) => {
    const raw = new Surreal()
    await raw.connect(t.url)
    await raw.signin({ username: t.username, password: t.password })
    await raw.use({ namespace: t.ns, database: t.db })
    const [rows] = await raw.query<[{ hits?: number; lastAccessedAt?: string }[]]>(
      'SELECT hits, lastAccessedAt FROM $rid', { rid: new RecordId('note', 'project:auth') },
    )
    await raw.close()
    return rows[0]
  }

  // Edge-row twin of rawRow: link rows have generated ids (RELATE, not a deterministic key), so
  // the peek matches on the (scope, fromId, toId, kind) tuple instead of a RecordId.
  const rawLinkRow = async (
    t: { url: string; ns: string; db: string; username: string; password: string },
    fromId: string, toId: string, kind: string, scope = 'project',
  ) => {
    const raw = new Surreal()
    await raw.connect(t.url)
    await raw.signin({ username: t.username, password: t.password })
    await raw.use({ namespace: t.ns, database: t.db })
    const [rows] = await raw.query<[{ hits?: number; lastAccessedAt?: string }[]]>(
      'SELECT hits, lastAccessedAt FROM link WHERE fromId = $fromId AND toId = $toId AND kind = $kind AND scope = $scope',
      { fromId, toId, kind, scope },
    )
    await raw.close()
    return rows[0]
  }

  // (a) The v1 blueprint ranked a walked edge above an untouched sibling — that passes from node
  // heat alone and never exercises the edge code. Here node heat is forced EQUAL (one hit each,
  // same timestamp): only the edge boost can break the tie. Ids are deliberately chosen so
  // alphabetical order OPPOSES the intended winner (walked 'edge-z' vs untouched 'edge-a') —
  // rankNeighbors' tie-break sort is `localeCompare(id)`, so a same-named-the-other-way test
  // would pass on tie-break luck even with a no-op boost. Score is asserted directly too.
  it('an edge walked with provenance outranks a structurally-identical untouched sibling at equal node heat', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    const ts = '2026-07-10T00:00:00.000Z'
    let seq = 0
    const apply = (kind: EventKind, payload: Record<string, unknown>) =>
      m.applyEvent(eventFixture({ seq: ++seq, ts, kind, payload }))
    const note = (id: string, links: Array<{ id: string; kind: 'relates_to' }> = []) =>
      apply(EVENT_KIND.memory_written, { note: { id, scope: 'project', title: id, links }, author: { source: 'cli' } })
    await note('edge-z')
    await note('edge-a')
    await note('edge-seed', [{ id: 'edge-z', kind: 'relates_to' }, { id: 'edge-a', kind: 'relates_to' }])
    // Z is reached WITH provenance — the edge itself earns credit; A is read directly — same
    // node-level hit, but no edge to strengthen. A would win a same-score tie-break sort
    // (localeCompare), so Z winning proves the boost, not alphabetical luck.
    await apply(EVENT_KIND.memory_accessed, {
      id: 'edge-z', scope: 'project', mode: 'read', author: { source: 'cli' },
      via: { seed: 'edge-seed', kind: 'relates_to', direction: 'out' },
    })
    await apply(EVENT_KIND.memory_accessed, { id: 'edge-a', scope: 'project', mode: 'read', author: { source: 'cli' } })

    const ranked = await m.neighbors('edge-seed', { now: ts })
    // node heat is EQUAL: both notes were hit exactly once at the same timestamp
    const z = ranked.find(n => n.id === 'edge-z')!
    const a = ranked.find(n => n.id === 'edge-a')!
    expect(z.activation).toBe(a.activation)
    expect(z.activation).toBeGreaterThan(0)
    // ...yet Z outranks A — the only remaining discriminator is the edge boost (score checked
    // directly, not just rank, so a tie-break-driven pass is impossible)
    expect(z.score).toBeGreaterThan(a.score)
    expect(ranked.map(n => n.id)[0]).toBe('edge-z')

    const link = await rawLinkRow(t, 'edge-seed', 'edge-z', 'relates_to')
    expect(link?.hits).toBe(1)
  })

  // (b) THE blocker: memory_written's delete-then-RELATE re-materialization must carry forward
  // stats for a link that survives the rewrite, or every note UPDATE silently wipes its edges'
  // earned activation — live and on rebuild alike.
  it('a note UPDATE preserves accumulated edge stats for links that survive the rewrite', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1, note({ id: 'up-src', links: [{ id: 'up-dst', kind: 'relates_to' }] })))
    await m.applyEvent(written(2, note({ id: 'up-dst' })))
    await m.applyEvent(accessed(3, 'up-dst', MEMORY_ACCESS.read, 'project', { seed: 'up-src', kind: 'relates_to', direction: 'out' }))
    const before = await rawLinkRow(t, 'up-src', 'up-dst', 'relates_to')
    expect(before?.hits).toBe(1)

    // re-apply memory_written for the source note, keeping the SAME link — this used to wipe
    // the edge's stats via the unconditional delete-then-RELATE.
    await m.applyEvent(written(4, note({ id: 'up-src', links: [{ id: 'up-dst', kind: 'relates_to' }], summary: 'revised' })))
    const after = await rawLinkRow(t, 'up-src', 'up-dst', 'relates_to')
    expect(after?.hits).toBe(1)
    expect(after?.lastAccessedAt).toBe(before?.lastAccessedAt)
  })

  // (c) Zero-access graph must rank byte-identically to the pre-activation structural scores —
  // activationBoost(0) === 1 for every edge, so the boost multiplication is a no-op throughout.
  it('a zero-access graph ranks byte-identically to the pre-activation structural scores', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1, note({ id: 'za', links: [{ id: 'zb', kind: 'supersedes' }, { id: 'zc', kind: 'relates_to' }] })))
    await m.applyEvent(written(2, note({ id: 'zb' })))
    await m.applyEvent(written(3, note({ id: 'zc' })))
    const nb = await m.neighbors('za', { depth: 2 })
    // DEFAULT_LINK_WEIGHTS: supersedes 1.0, relates_to 0.5 — decay^0 at depth 1, confidence 1
    expect(nb.map(n => ({ id: n.id, score: n.score, activation: n.activation }))).toEqual([
      { id: 'zb', score: 1, activation: 0 },
      { id: 'zc', score: 0.5, activation: 0 },
    ])
  })

  it('memory_accessed merges hits/lastAccessedAt from the event ts, leaving authored fields intact', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))
    await m.applyEvent(accessed(2, 'auth'))
    await m.applyEvent(accessed(3, 'auth'))
    const got = await m.get('auth', 'project')
    expect(got?.title).toBe('Auth')
    expect(got?.body).toBe('full text about auth tokens')
    expect(got?.revision).toBe(1) // an access is not a write

    const row = await rawRow(t)
    expect(row?.hits).toBe(2)
    expect(row?.lastAccessedAt).toBe('2026-07-18T03:00:00Z') // the event ts, not wall-clock
  })

  it('get() performs no write — reading is not an access, only the event is', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    await m.applyEvent(written(1))
    await m.get('auth', 'project')
    await m.get('auth', 'project')
    expect((await rawRow(t))?.hits).toBe(0)
  })

  // The degraded-memory guarantee depends on open() FAILING when Surreal is unreachable. The
  // driver's connect() does not reject on an unreachable endpoint — measured still pending after
  // 400s against a closed port — so without a bound here, every caller inherits an unbounded
  // hang: `orc status`, `orc memory *`, and the degraded-mode catch in the CLI runtime, which
  // can only run once open() throws. The test's own timeout is the assertion: a regression
  // hangs, so bound it well under the 5s production default.
  it('open() against an unreachable endpoint rejects instead of hanging', async () => {
    const started = Date.now()
    await expect(SurrealMemory.open({
      url: 'ws://127.0.0.1:9/rpc', ns: 'orc', db: 'nope',
      username: 'root', password: 'orc', connectTimeoutMs: 250,
    })).rejects.toThrow(/unreachable|timed out/i)
    expect(Date.now() - started).toBeLessThan(4_000)
  }, 8_000)

  it('an access for a note that does not exist creates no phantom row', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t)
    expect(await m.applyEvent(accessed(1, 'ghost'))).toBe(true) // cursor still advances
    expect(await m.get('ghost', 'project')).toBeNull()
    expect(await m.allNotes()).toEqual([])
  })

  it('re-ranks equal structural neighbors by activation: the hot note wins, and activation is exposed', async () => {
    const t = await createTestSurreal()
    drops.push(t.drop)
    const m = await openMemory(t)
    const ts = '2026-07-01T00:00:00.000Z'
    let seq = 0
    const apply = (kind: EventKind, payload: Record<string, unknown>) =>
      m.applyEvent(eventFixture({ seq: ++seq, ts, kind, payload }))
    const note = (id: string, links: Array<{ id: string; kind: 'relates_to' }> = []) =>
      apply(EVENT_KIND.memory_written, { note: { id, scope: 'project', title: id, links }, author: { source: 'cli' } })
    // seed → b and seed → c with the SAME kind: identical structural score
    await note('act-b')
    await note('act-c')
    await note('act-seed', [{ id: 'act-b', kind: 'relates_to' }, { id: 'act-c', kind: 'relates_to' }])
    for (let i = 0; i < 5; i++)
      await apply(EVENT_KIND.memory_accessed, { id: 'act-c', scope: 'project', mode: 'read', author: { source: 'cli' } })
    const ranked = await m.neighbors('act-seed', { now: ts })
    expect(ranked.map(n => n.id)[0]).toBe('act-c') // hot beats cold at equal structure
    expect(ranked.find(n => n.id === 'act-c')!.activation).toBeGreaterThan(0)
    expect(ranked.find(n => n.id === 'act-b')!.activation).toBe(0)
  })
})

// The project's display name and working directory are chat infrastructure stored as notes. They
// are hidden from the graph view, but retrieval had never heard of them — so a real run handed an
// agent 'ui-project-name' as context and then cited it as provenance.
it('search never returns ui-metadata notes; get still resolves them by id', async () => {
  const t = await createTestSurreal(); const mem = await SurrealMemory.open(t)
  try {
    await mem.applyEvent(written(1, note({ id: PROJECT_NAME_NOTE_ID, title: 'orc-sim', summary: 'display name for the project chat' })))
    await mem.applyEvent(written(2, note({ id: 'real-note', title: 'orc-sim architecture', summary: 'display name and other things' })))
    expect((await mem.search('orc-sim')).map(n => n.id)).toEqual(['real-note'])
    expect((await mem.get(PROJECT_NAME_NOTE_ID))?.id).toBe(PROJECT_NAME_NOTE_ID)
  } finally { await mem.close(); await t.drop() }
})

describe('SurrealMemory claim projection', () => {
  const claim = (text: string, sourceRevision: string | null = null) =>
    ({ id: claimId(text), text, sourceRevision })

  it('projects one row per live claim, stamped with the event ts', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'n', claims: [claim('a')] })))
    const rows = await mem.claimsFor('n', 'project')
    expect(rows.map(c => c.text)).toEqual(['a'])
    // a writer cannot date its own claim: the event that carried it does
    expect(rows[0]?.validFrom).toBe('2026-07-18T01:00:00Z')
  })

  it('a rewrite re-materializes claims: retired ones disappear, survivors keep their validFrom', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'n', claims: [claim('a')] })))
    await mem.applyEvent(written(2, note({ id: 'n', claims: [claim('a'), claim('b')] })))
    let rows = await mem.claimsFor('n', 'project')
    expect(rows.map(c => c.text).sort()).toEqual(['a', 'b'])
    // re-stating a fact does not make it new — 'a' keeps the ts of the write that FIRST carried it
    expect(rows.find(c => c.text === 'a')?.validFrom).toBe('2026-07-18T01:00:00Z')
    expect(rows.find(c => c.text === 'b')?.validFrom).toBe('2026-07-18T02:00:00Z')

    await mem.applyEvent(written(3, note({ id: 'n', claims: [claim('b')] })))
    rows = await mem.claimsFor('n', 'project')
    expect(rows.map(c => c.text)).toEqual(['b']) // retired 'a' is no longer live
    expect(rows[0]?.validFrom).toBe('2026-07-18T02:00:00Z')
  })

  it('carries a claim sourceRevision through the read model', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'n', claims: [claim('a', 'deadbeef'), claim('b')] })))
    const rows = await mem.claimsFor('n', 'project')
    expect(rows.find(c => c.text === 'a')?.sourceRevision).toBe('deadbeef')
    expect(rows.find(c => c.text === 'b')?.sourceRevision).toBeNull()
  })

  it('deleting a note drops its claim rows with it', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'n', claims: [claim('a')] })))
    await mem.applyEvent(deleted(2, 'n'))
    expect(await mem.claimsFor('n', 'project')).toEqual([])
  })

  it('a claim is scoped to its owning note — same statement on two notes is two rows', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'n1', claims: [claim('shared')] })))
    await mem.applyEvent(written(2, note({ id: 'n2', claims: [claim('shared')] })))
    expect(await mem.claimsFor('n1', 'project')).toHaveLength(1)
    expect(await mem.claimsFor('n2', 'project')).toHaveLength(1)
  })

  it('a plan note contributes no claim rows — the tier has no such field', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'p', tier: 'plan', rationale: 'why', claims: [claim('a')] })))
    expect(await mem.claimsFor('p', 'project')).toEqual([])
  })
})

describe('SurrealMemory.searchClaims', () => {
  const claim = (text: string) => ({ id: claimId(text), text, sourceRevision: null })

  it('returns the matched statement and its owning note, not the whole note', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({
      id: 'truth', title: 'Decision log', claims: [claim('the event log is the only truth'), claim('surreal is disposable')],
    })))
    const hits = await mem.searchClaims('event log truth')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ noteId: 'truth', title: 'Decision log', text: 'the event log is the only truth' })
    expect(hits[0]?.validFrom).toBe('2026-07-18T01:00:00Z')
  })

  // The claim arm's half of the same wiring check as the note arm's above: keywordClaims has its
  // own meetsQuorum call, and every other fixture in this block clears the quorum trivially.
  it('the keyword claim arm drops a statement carrying fewer than half the query terms', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({
      id: 'partial', title: 'P',
      claims: [claim('surreal is disposable'), claim('a surreal projection replays kubernetes helm charts')],
    })))
    // 4 terms; 'surreal is disposable' carries only 'surreal' → excluded, the other carries all 4
    const hits = await mem.searchClaims('surreal kubernetes helm charts', {}, { mode: 'keyword', perNote: 'all' })
    expect(hits.map(h => h.text)).toEqual(['a surreal projection replays kubernetes helm charts'])
    // the excluded statement is still findable on a query it does cover — the exclusion is the
    // quorum, not a missing row
    expect((await mem.searchClaims('surreal disposable', {}, { mode: 'keyword', perNote: 'all' })).map(h => h.text))
      .toContain('surreal is disposable')
  })

  it('one note cannot fill every slot — at most its best-ranked claim comes back', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({
      id: 'hoarder', title: 'H', claims: [claim('scope alpha'), claim('scope beta'), claim('scope gamma')],
    })))
    await mem.applyEvent(written(2, note({ id: 'other', title: 'O', claims: [claim('scope delta')] })))
    const hits = await mem.searchClaims('scope')
    expect(hits.map(h => h.noteId).sort()).toEqual(['hoarder', 'other'])
  })

  it('honours the note-level scope filter a claim row cannot answer itself', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'p', scope: 'project', title: 'P', claims: [claim('shared statement')] })))
    await mem.applyEvent(written(2, note({ id: 'i', scope: 'infra', title: 'I', claims: [claim('shared statement')] })))
    expect((await mem.searchClaims('shared', { scope: 'infra' })).map(h => h.noteId)).toEqual(['i'])
  })

  it('a retired claim stops being findable', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'n', title: 'N', claims: [claim('retire me later')] })))
    expect(await mem.searchClaims('retire')).toHaveLength(1)
    await mem.applyEvent(written(2, note({ id: 'n', title: 'N', claims: [] })))
    expect(await mem.searchClaims('retire')).toEqual([])
  })

  // search() wraps both its arms in knowledge(); the claim arm resolved owners through list(),
  // which has no such exclusion — so a claim asserted on a ui-metadata note came back from
  // memory_search's claim arm while the note itself stayed hidden. ARCHITECTURE.md states the
  // invariant as "excluded from the retrieval surface entirely", and the claim arm IS one.
  it('never returns a claim asserted on a ui-metadata note, the same exclusion search() applies', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: PROJECT_NAME_NOTE_ID, title: 'orc-sim', claims: [claim('the project is called orc-sim')] })))
    await mem.applyEvent(written(2, note({ id: 'real-note', title: 'R', claims: [claim('the project is called by its slug')] })))
    expect((await mem.searchClaims('project is called')).map(h => h.noteId)).toEqual(['real-note'])
  })

  it('an empty query matches nothing rather than everything', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const mem = await openMemory(t)
    await mem.applyEvent(written(1, note({ id: 'n', title: 'N', claims: [claim('a statement')] })))
    expect(await mem.searchClaims('   ')).toEqual([])
  })
})
