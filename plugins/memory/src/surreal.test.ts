import { afterAll, describe, expect, it } from 'bun:test'
import { RecordId, Surreal } from 'surrealdb'
import type { EventRecord, MemoryAuthor } from '@orc/contracts'
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

  // ponytail: cheap de-risk for Task 7 (not in the brief's gate) — confirms upsert().set()
  // with a partial field set MERGES rather than REPLACES the stored note. readCount/lastReadAt
  // are Tier-2 fields dropped from the public MemoryNote (see toNote), so they're checked here
  // via a raw peek at the row rather than through m.get().
  it('bumpRead merges readCount/lastReadAt without wiping other fields', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyEvent(written(1))
    await m.bumpRead('auth', 'project')
    const got = await m.get('auth', 'project')
    expect(got?.title).toBe('Auth')
    expect(got?.body).toBe('full text about auth tokens')
    expect(got?.revision).toBe(1)

    const raw = new Surreal()
    await raw.connect(t.url)
    await raw.signin({ username: t.username, password: t.password })
    await raw.use({ namespace: t.ns, database: t.db })
    const [rows] = await raw.query<[{ readCount: number; lastReadAt: string }[]]>(
      'SELECT readCount, lastReadAt FROM $rid', { rid: new RecordId('note', 'project:auth') },
    )
    expect(rows[0]?.readCount).toBe(1)
    expect(typeof rows[0]?.lastReadAt).toBe('string')
    await raw.close()
    await m.close()
  })
})
