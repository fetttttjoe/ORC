import { afterAll, describe, expect, it } from 'bun:test'
import { claimId, MemoryScope, type EmbeddingProvider, type EventRecord, type MemoryAuthor } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'

// Same fake encoder shape as semantic-search.test.ts: 'zeta' maps to alpha's vector while sharing no
// token with it, so grouping is proven by MEANING rather than by shared words.
const vec = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('alpha') || t.includes('zeta')) return [1, 0, 0]
  if (t.includes('beta')) return [0, 1, 0]
  return [0, 0, 1]
}
const fakeEmbedder: EmbeddingProvider = { embed: async texts => texts.map(vec) }

const cli: MemoryAuthor = { source: 'cli' }
const claim = (text: string) => ({ id: claimId(text), text, sourceRevision: null })
const note = (over = {}) => ({
  id: 'n', scope: MemoryScope.project, kind: 'fact', sourceRevision: null, title: 'T',
  categories: [], tags: [], links: [], paths: [], summary: '', body: '', ...over,
})
const written = (seq: number, n: object): EventRecord =>
  eventFixture({ seq, taskId: null, kind: 'memory_written', payload: { note: n, author: cli }, ts: `2026-07-26T0${seq}:00:00Z` })

const drops: (() => Promise<void>)[] = []
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

const open = async () => {
  const t = await createTestSurreal(); drops.push(t.drop)
  return SurrealMemory.open(t, fakeEmbedder)
}

describe('SurrealMemory topic projection', () => {
  it('groups claims that mean the same thing and separates ones that do not', async () => {
    const m = await open()
    await m.applyEvent(written(1, note({ id: 'n1', claims: [claim('alpha holds')] })))
    await m.applyEvent(written(2, note({ id: 'n2', claims: [claim('zeta holds')] })))
    await m.applyEvent(written(3, note({ id: 'n3', claims: [claim('beta holds')] })))
    await m.refreshTopics(0.75)
    const topics = await m.topics()
    expect(topics).toHaveLength(2)
    const big = topics.find(t => t.size === 2)
    expect(big?.label).toMatch(/alpha holds|zeta holds/)
    await m.close()
  })

  it('a refresh replaces the table wholesale and is idempotent on unchanged claims', async () => {
    const m = await open()
    await m.applyEvent(written(1, note({ id: 'n1', claims: [claim('alpha holds')] })))
    await m.refreshTopics(0.75)
    const first = await m.topics()
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual(first)
    await m.close()
  })

  it('drops a topic whose claims were retired', async () => {
    const m = await open()
    await m.applyEvent(written(1, note({ id: 'n1', claims: [claim('alpha holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toHaveLength(1)
    await m.applyEvent(written(2, note({ id: 'n1', claims: [] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual([])
    await m.close()
  })

  it('clusters the project scope only — a plan-scope claim is not grouped', async () => {
    const m = await open()
    await m.applyEvent(written(1, note({ id: 'p', scope: 'plan-t1', claims: [claim('alpha holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual([])
    await m.close()
  })

  it('returns a topic’s claims, and nothing for a key from an older partition', async () => {
    const m = await open()
    await m.applyEvent(written(1, note({ id: 'n1', claims: [claim('alpha holds'), claim('zeta holds')] })))
    await m.refreshTopics(0.75)
    const key = (await m.topics())[0]?.topicKey ?? ''
    expect((await m.topicClaims(key)).map(c => c.text).sort()).toEqual(['alpha holds', 'zeta holds'])
    expect(await m.topicClaims('deadbeef0000')).toEqual([])
    await m.close()
  })

  it('with no embedder there are no vectors, so no topics — claims stay findable', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t) // no embedder
    await m.applyEvent(written(1, note({ id: 'n1', claims: [claim('alpha holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual([])
    expect(await m.searchClaims('alpha')).toHaveLength(1)
    await m.close()
  })
})
