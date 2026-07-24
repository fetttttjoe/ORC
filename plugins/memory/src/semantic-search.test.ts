import { afterAll, describe, expect, it } from 'bun:test'
import type { EmbeddingProvider, EventRecord, MemoryAuthor } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'

// A deterministic fake encoder: maps text to one of three orthogonal vectors by concept keyword.
// 'zeta' shares NO literal token with the 'alpha' note yet maps to the SAME vector — the synonym
// case keyword search cannot serve. dimensions = 3 keeps cosine trivially checkable.
const vec = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('alpha') || t.includes('zeta')) return [1, 0, 0] // zeta ≈ alpha in fake-space
  if (t.includes('beta')) return [0, 1, 0]
  return [0, 0, 1]
}
const fakeEmbedder: EmbeddingProvider = { embed: async texts => texts.map(vec) }

const cli: MemoryAuthor = { source: 'cli' }
const note = (over = {}) => ({
  id: 'n', scope: 'project', kind: 'fact', sourceRevision: null, title: 'T', categories: [], tags: [],
  links: [], paths: [], rules: [], summary: '', body: '', ...over,
})
const written = (seq: number, n: object): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_written', payload: { note: n, author: cli }, ts: `2026-07-24T0${seq}:00:00Z` })
const accessed = (seq: number, id: string): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_accessed', payload: { id, scope: 'project', mode: 'read', author: cli }, ts: `2026-07-24T0${seq}:00:00Z` })

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

describe('SurrealMemory semantic + hybrid search', () => {
  it('finds a note by MEANING when the query shares no tokens with it (keyword misses, semantic hits)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    await m.applyEvent(written(1, note({ id: 'alpha-note', title: 'Alpha subject', summary: 'the alpha thing', body: 'alpha' })))
    await m.applyEvent(written(2, note({ id: 'beta-note', title: 'Beta subject', summary: 'the beta thing', body: 'beta' })))
    // 'zeta' appears in NEITHER note → keyword returns nothing…
    expect(await m.search('zeta', {}, { mode: 'keyword' })).toEqual([])
    // …but it maps to alpha's vector, so semantic surfaces the alpha note first
    expect((await m.search('zeta', {}, { mode: 'semantic' }))[0]?.id).toBe('alpha-note')
    await m.close()
  })

  it('semantic mode is exact by vector; hybrid fuses both arms', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    await m.applyEvent(written(1, note({ id: 'alpha-note', title: 'Alpha', summary: 'alpha', body: 'alpha' })))
    await m.applyEvent(written(2, note({ id: 'beta-note', title: 'Beta', summary: 'beta', body: 'beta' })))
    expect((await m.search('beta', {}, { mode: 'semantic' }))[0]?.id).toBe('beta-note')
    // 'alpha' matches alpha-note by BOTH keyword and vector → agreement ranks it first
    expect((await m.search('alpha', {}, { mode: 'hybrid' }))[0]?.id).toBe('alpha-note')
    await m.close()
  })

  it('falls back to keyword when no embedder is configured, even if a semantic mode is requested', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t) // no embedder → degraded to keyword
    await m.applyEvent(written(1, note({ id: 'k', title: 'Tokens', summary: 'tokens rotate', body: 'x' })))
    expect((await m.search('tokens', {}, { mode: 'semantic' })).map(n => n.id)).toEqual(['k']) // keyword still serves
    expect(await m.search('zeta', {}, { mode: 'semantic' })).toEqual([]) // no vector path, no match
    await m.close()
  })

  it('a note that gets USED ranks above an equally-relevant cold note (activation heat)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    await m.applyEvent(written(1, note({ id: 'alpha-hot', title: 'Alpha one', summary: 'alpha', body: 'alpha' })))
    await m.applyEvent(written(2, note({ id: 'alpha-cold', title: 'Alpha two', summary: 'alpha', body: 'alpha' })))
    // both map to the SAME vector (a cosine tie) — only read-heat can separate them
    await m.applyEvent(accessed(3, 'alpha-hot'))
    await m.applyEvent(accessed(4, 'alpha-hot'))
    expect((await m.search('alpha', {}, { mode: 'semantic' })).map(n => n.id)).toEqual(['alpha-hot', 'alpha-cold'])
    await m.close()
  })
})
