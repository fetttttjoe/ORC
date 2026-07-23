import { afterAll, describe, expect, it } from 'bun:test'
import { RecordId, Surreal } from 'surrealdb'
import { EVENT_KIND, MEMORY_ACCESS, type EventKind, type EventRecord, type MemoryAccessMode, type MemoryAuthor } from '@orc/contracts'
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
const accessed = (seq: number, id: string, mode: MemoryAccessMode = MEMORY_ACCESS.read, scope = 'project'): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_accessed', payload: { id, scope, mode, author: cli }, ts: `2026-07-18T0${Math.min(seq, 9)}:00:00Z` })

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
    const db = (m as unknown as { db: { transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> } }).db
    const realTransaction = db.transaction.bind(db)
    let insideTransaction = false
    db.transaction = (cb) => realTransaction(async (tx) => {
      insideTransaction = true
      const t = tx as { delete: (...a: unknown[]) => unknown }
      const realDelete = t.delete.bind(t)
      let deletes = 0
      t.delete = (...a: unknown[]) => {
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
