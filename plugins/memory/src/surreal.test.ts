import { afterAll, describe, expect, it } from 'bun:test'
import { RecordId, Surreal } from 'surrealdb'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'

const note = (over = {}) => ({ id: 'auth', scope: 'project', title: 'Auth', categories: ['security'], tags: ['auth'], links: [], paths: ['src/auth.ts'], rules: [], summary: 'tokens rotate', body: 'full text about auth tokens', ...over })
const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

describe('SurrealMemory', () => {
  it('applies a write, reads it back, and increments revision on update', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyWritten({ seq: 1, ts: '2026-07-18T00:00:00Z', note: note(), author: { source: 'cli' } })
    let got = await m.get('auth', 'project')
    expect(got?.revision).toBe(1)
    expect(got?.createdBy).toBe('cli')
    await m.applyWritten({ seq: 2, ts: '2026-07-18T01:00:00Z', note: note({ summary: 'rotate on use' }), author: { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' } })
    got = await m.get('auth', 'project')
    expect(got?.revision).toBe(2)
    expect(got?.createdBy).toBe('cli')            // unchanged
    expect(got?.updatedBy).toBe('api-loop·opus·review')
    expect(got?.summary).toBe('rotate on use')
    await m.close()
  })

  it('search matches on body/summary/title; delete removes; cursor round-trips', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyWritten({ seq: 1, ts: '2026-07-18T00:00:00Z', note: note(), author: { source: 'cli' } })
    expect((await m.search('tokens')).map(n => n.id)).toEqual(['auth'])
    await m.setCursor(5); expect(await m.getCursor()).toBe(5)
    await m.applyDeleted({ seq: 6, ts: '2026-07-18T02:00:00Z', id: 'auth', scope: 'project', author: { source: 'cli' } })
    expect(await m.get('auth', 'project')).toBeNull()
    await m.close()
  })

  // ponytail: cheap de-risk for Task 7 (not in the brief's gate) — confirms upsert().set()
  // with a partial field set MERGES rather than REPLACES the stored note. readCount/lastReadAt
  // are Tier-2 fields dropped from the public MemoryNote (see toNote), so they're checked here
  // via a raw peek at the row rather than through m.get().
  it('bumpRead merges readCount/lastReadAt without wiping other fields', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyWritten({ seq: 1, ts: '2026-07-18T00:00:00Z', note: note(), author: { source: 'cli' } })
    await m.bumpRead('auth', 'project')
    const got = await m.get('auth', 'project')
    expect(got?.title).toBe('Auth')
    expect(got?.body).toBe('full text about auth tokens')
    expect(got?.revision).toBe(1)

    const raw = new Surreal()
    await raw.connect(t.url)
    await raw.signin({ username: 'root', password: 'orc' })
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
