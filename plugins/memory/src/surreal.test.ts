import { afterAll, describe, expect, it } from 'bun:test'
import { RecordId, Surreal } from 'surrealdb'
import { EVENT_KIND, MEMORY_ACCESS, isRecord, type AccessVia, type EventKind, type EventRecord, type MemoryAccessMode, type MemoryAuthor } from '@orc/contracts'
import { SurrealMemory } from './surreal'
import { eventFixture } from '@orc/contracts/fixtures'
import { createTestSurreal } from './test-helpers'

const note = (over = {}) => ({
  id: 'auth', scope: 'project', kind: 'fact', sourceRevision: null,
  title: 'Auth', categories: ['security'], tags: ['auth'], links: [], paths: ['src/auth.ts'], rules: [],
  summary: 'tokens rotate', body: 'full text about auth tokens', ...over,
})
const cli: MemoryAuthor = { source: 'cli' }
const written = (seq: number, n = note(), author: MemoryAuthor = cli): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_written', payload: { note: n, author }, ts: `2026-07-18T0${Math.min(seq, 9)}:00:00Z` })
const deleted = (seq: number, id: string, scope = 'project'): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_deleted', payload: { id, scope, author: cli }, ts: `2026-07-18T0${Math.min(seq, 9)}:00:00Z` })
const accessed = (seq: number, id: string, mode: MemoryAccessMode = MEMORY_ACCESS.read, scope = 'project', via?: AccessVia): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_accessed', payload: { id, scope, mode, author: cli, ...(via && { via }) }, ts: `2026-07-18T0${Math.min(seq, 9)}:00:00Z` })

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

describe('SurrealMemory.applyEvent', () => {
  it('applies a write, reads it back, and increments revision on update', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    expect(await m.applyEvent(written(1))).toBe(true)
    let got = await m.get('auth', 'project')
    expect(got?.revision).toBe(1)
    expect(got?.createdBy).toBe('cli')
    expect(got?.kind).toBe('fact')
    await m.applyEvent(written(2, note({ summary: 'rotate on use' }), { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' }))
    got = await m.get('auth', 'project')
    expect(got?.revision).toBe(2)
    expect(got?.createdBy).toBe('cli')            // unchanged
    expect(got?.updatedBy).toBe('api-loop·opus·review')
    expect(got?.summary).toBe('rotate on use')
    await m.close()
  })

  it('redelivery is a no-op: same event twice leaves revision 1, one edge, cursor advanced once', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    const e = written(3, note({ id: 'a', links: [{ id: 'b', kind: 'supersedes' }] }))
    expect(await m.applyEvent(e)).toBe(true)
    expect(await m.applyEvent(e)).toBe(false) // seq <= cursor → rejected inside the transaction
    expect((await m.get('a', 'project'))?.revision).toBe(1)
    await m.applyEvent(written(4, note({ id: 'b' })))
    expect((await m.neighbors('a')).map(n => n.id)).toEqual(['b']) // exactly one edge
    expect(await m.getCursor()).toBe(4)
    await m.close()
  })

  it('write → delete → stale write leaves the note deleted, no tombstone needed', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    const stale = written(1)
    await m.applyEvent(stale)
    await m.applyEvent(deleted(2, 'auth'))
    expect(await m.applyEvent(stale)).toBe(false) // ordered cursor rejects the redelivery
    expect(await m.get('auth', 'project')).toBeNull()
    await m.close()
  })

  it('search matches on body/summary/title; delete removes', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1))
    expect((await m.search('tokens')).map(n => n.id)).toEqual(['auth'])
    // case-insensitive: query is uppercase, stored summary/body are lowercase.
    expect((await m.search('TOKENS')).map(n => n.id)).toEqual(['auth'])
    await m.applyEvent(deleted(6, 'auth'))
    expect(await m.get('auth', 'project')).toBeNull()
    await m.close()
  })

  it('search ANDs whitespace-separated terms, each matching any field', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1))
    await m.applyEvent(written(2, note({ id: 'other', title: 'Sessions', summary: 'cookies expire', body: 'session cookie details' })))
    // terms scattered across title/summary/body — a whole-query substring match would miss
    expect((await m.search('rotate auth')).map(n => n.id)).toEqual(['auth'])
    // one term with no match anywhere rejects the note
    expect(await m.search('rotate cookies')).toEqual([])
    await m.close()
  })

  it('search survives a long query — term cap keeps the WHERE depth bounded', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1))
    // pre-cap this threw SurrealDB's "Exceeded query recursion depth limit" (observed live
    // from an agent's long descriptive query); post-cap it is a clean empty result
    const spam = Array.from({ length: 40 }, (_, i) => `zz${i}`).join(' ')
    expect(await m.search(spam)).toEqual([])
    await m.close()
  })

  it('search ranks field-weighted relevance above recency', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    // older note matches in title+summary; newer one only deep in the body
    await m.applyEvent(written(1, note({ id: 'relevant', title: 'Token rotation', summary: 'tokens rotate on use' })))
    await m.applyEvent(written(2, note({ id: 'recent', title: 'Sessions', summary: 'cookie jar', body: 'mentions tokens once' })))
    expect((await m.search('tokens')).map(n => n.id)).toEqual(['relevant', 'recent'])
    // durable project notes outrank same-relevance transient plan-scope notes
    await m.applyEvent(written(3, note({ id: 'plannote', scope: 'plan-x', title: 'Token rotation', summary: 'tokens rotate on use' })))
    expect((await m.search('tokens'))[0].id).toBe('relevant')
    await m.close()
  })

  it('materializes typed RELATE edges and ranks neighbours; delete removes edges', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
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
    await m.close()
  })

  it('persists rationale/uncertainty through the read model (not just the event log)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1, note({ id: 'plan-db', rationale: 'why', uncertainty: ['schema unknown'] })))
    const got = await m.get('plan-db', 'project')
    expect(got?.rationale).toBe('why')
    expect(got?.uncertainty).toEqual(['schema unknown'])
    await m.close()
  })

  // The cursor authorizes replay: applyEvent rejects e.seq <= cursor. So a clear that drops
  // content while leaving the cursor ahead of it is unrecoverable through the normal paths —
  // start()/catchUp() both drain zero and probeMemory reports healthy, because "no events after
  // the cursor" is legitimately true. Only an explicit second rebuild() would heal it.
  it('a failed clear never leaves the cursor ahead of the content it describes', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
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
    await m.close()
  })

  // An agent must not be able to claim when it fetched a page, and a rebuild must reproduce the
  // stamp exactly — so retrievedAt comes from the canonical event ts, not from wall-clock time.
  it('stamps citation retrievedAt from the event timestamp, identically on redelivery', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    const cited = note({
      id: 'finding', kind: 'research',
      sources: [{ url: 'https://example.test/a', title: 'A' }, { url: 'https://example.test/b' }],
    })
    const e = written(1, cited)
    await m.applyEvent(e)
    const got = await m.get('finding', 'project')
    expect(got?.sources).toEqual([
      { url: 'https://example.test/a', title: 'A', retrievedAt: e.ts },
      { url: 'https://example.test/b', title: undefined, retrievedAt: e.ts },
    ])
    // replaying the same history yields the same stamp — no wall-clock anywhere in the path
    await m.clear()
    await m.applyEvent(e)
    expect((await m.get('finding', 'project'))?.sources?.[0]?.retrievedAt).toBe(e.ts)
    await m.close()
  })

  it('stores kind and sourceRevision; allNotes returns deterministic order', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1, note({ id: 'zz', kind: 'architecture_current', sourceRevision: 'abc123' })))
    await m.applyEvent(written(2, note({ id: 'aa', kind: 'architecture_target' })))
    const all = await m.allNotes()
    expect(all.map(n => n.id)).toEqual(['aa', 'zz'])
    expect(all[1]).toMatchObject({ kind: 'architecture_current', sourceRevision: 'abc123' })
    expect(all[0]?.sourceRevision).toBeNull()
    await m.close()
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
  // same timestamp): only the edge boost can break the tie.
  it('an edge walked with provenance outranks a structurally-identical untouched sibling at equal node heat', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    const ts = '2026-07-10T00:00:00.000Z'
    let seq = 0
    const apply = (kind: EventKind, payload: Record<string, unknown>) =>
      m.applyEvent(eventFixture({ seq: ++seq, ts, kind, payload }))
    const note = (id: string, links: Array<{ id: string; kind: 'relates_to' }> = []) =>
      apply(EVENT_KIND.memory_written, { note: { id, scope: 'project', title: id, links }, author: { source: 'cli' } })
    await note('edge-a')
    await note('edge-b')
    await note('edge-seed', [{ id: 'edge-a', kind: 'relates_to' }, { id: 'edge-b', kind: 'relates_to' }])
    // A is reached WITH provenance — the edge itself earns credit; B is read directly — same
    // node-level hit, but no edge to strengthen.
    await apply(EVENT_KIND.memory_accessed, {
      id: 'edge-a', scope: 'project', mode: 'read', author: { source: 'cli' },
      via: { seed: 'edge-seed', kind: 'relates_to', direction: 'out' },
    })
    await apply(EVENT_KIND.memory_accessed, { id: 'edge-b', scope: 'project', mode: 'read', author: { source: 'cli' } })

    const ranked = await m.neighbors('edge-seed', { now: ts })
    // node heat is EQUAL: both notes were hit exactly once at the same timestamp
    const actA = ranked.find(n => n.id === 'edge-a')!.activation
    const actB = ranked.find(n => n.id === 'edge-b')!.activation
    expect(actA).toBe(actB)
    expect(actA).toBeGreaterThan(0)
    // ...yet A outranks B — the only remaining discriminator is the edge boost
    expect(ranked.map(n => n.id)[0]).toBe('edge-a')

    const link = await rawLinkRow(t, 'edge-seed', 'edge-a', 'relates_to')
    expect(link?.hits).toBe(1)
    await m.close()
  })

  // (b) THE blocker: memory_written's delete-then-RELATE re-materialization must carry forward
  // stats for a link that survives the rewrite, or every note UPDATE silently wipes its edges'
  // earned activation — live and on rebuild alike.
  it('a note UPDATE preserves accumulated edge stats for links that survive the rewrite', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
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
    await m.close()
  })

  // (c) Zero-access graph must rank byte-identically to the pre-activation structural scores —
  // activationBoost(0) === 1 for every edge, so the boost multiplication is a no-op throughout.
  it('a zero-access graph ranks byte-identically to the pre-activation structural scores', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1, note({ id: 'za', links: [{ id: 'zb', kind: 'supersedes' }, { id: 'zc', kind: 'relates_to' }] })))
    await m.applyEvent(written(2, note({ id: 'zb' })))
    await m.applyEvent(written(3, note({ id: 'zc' })))
    const nb = await m.neighbors('za', { depth: 2 })
    // DEFAULT_LINK_WEIGHTS: supersedes 1.0, relates_to 0.5 — decay^0 at depth 1, confidence 1
    expect(nb.map(n => ({ id: n.id, score: n.score, activation: n.activation }))).toEqual([
      { id: 'zb', score: 1, activation: 0 },
      { id: 'zc', score: 0.5, activation: 0 },
    ])
    await m.close()
  })

  it('memory_accessed merges hits/lastAccessedAt from the event ts, leaving authored fields intact', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
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
    await m.close()
  })

  it('get() performs no write — reading is not an access, only the event is', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1))
    await m.get('auth', 'project')
    await m.get('auth', 'project')
    expect((await rawRow(t))?.hits).toBe(0)
    await m.close()
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
    const m = await SurrealMemory.open(t)
    expect(await m.applyEvent(accessed(1, 'ghost'))).toBe(true) // cursor still advances
    expect(await m.get('ghost', 'project')).toBeNull()
    expect(await m.allNotes()).toEqual([])
    await m.close()
  })

  it('re-ranks equal structural neighbors by activation: the hot note wins, and activation is exposed', async () => {
    const t = await createTestSurreal()
    drops.push(t.drop)
    const m = await SurrealMemory.open(t)
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
    await m.close()
  })
})
