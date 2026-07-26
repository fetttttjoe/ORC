import { afterAll, describe, expect, it } from 'bun:test'
import { claimId, type EmbeddingProvider, type EventRecord, type MemoryAuthor } from '@orc/contracts'
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

  it('hybrid fusion is load-bearing: keyword agreement lifts a note above a hotter semantic-only one', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    // 'both' matches query 'alpha' by BOTH keyword (token 'alpha') and vector; left cold.
    await m.applyEvent(written(1, note({ id: 'both', title: 'Alpha', summary: 'alpha', body: 'alpha' })))
    // 'sem' matches ONLY by vector (body 'zeta' ≈ alpha, no 'alpha' token) and is read twice → hot,
    // so in the semantic arm alone it outranks 'both'. Only keyword agreement can flip the order.
    await m.applyEvent(written(2, note({ id: 'sem', title: 'S', summary: 'zeta', body: 'zeta' })))
    await m.applyEvent(accessed(3, 'sem'))
    await m.applyEvent(accessed(4, 'sem'))
    const ids = (await m.search('alpha', {}, { mode: 'hybrid' })).map(n => n.id)
    expect(ids[0]).toBe('both') // fails if only the semantic arm is returned (would give the hotter 'sem')
    expect(ids).toContain('sem') // the semantic-only note survives the (scope,id) fuse; fails if mis-keyed
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

describe('tier on the retrieval surface', () => {
  // Regression: the cosine SELECT projected every summary field EXCEPT tier, so a vector hit on a
  // plan or episodic note came back labelled 'semantic' — the lane a reader uses to tell durable
  // knowledge from one run's trail was fabricated by shape inference over a row that carries none
  // of the columns inference reads.
  it('a vector hit reports the lane it actually came from, not an inferred one', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    await m.applyEvent(written(1, { tier: 'plan', id: 'subplan', scope: 'plan-t1', title: 'Alpha subplan', body: 'alpha', rationale: 'why' }))
    await m.applyEvent(written(2, { tier: 'episodic', id: 'step-a', scope: 'plan-t1', title: 'Alpha step', body: 'alpha' }))
    await m.applyEvent(written(3, note({ id: 'claim', title: 'Alpha claim', body: 'alpha' })))
    const byId = new Map((await m.search('alpha', {}, { mode: 'semantic' })).map(n => [n.id, n.tier]))
    expect(byId.get('subplan')).toBe('plan')
    expect(byId.get('step-a')).toBe('episodic')
    expect(byId.get('claim')).toBe('semantic')
    await m.close()
  })

  it('filters both retrieval arms and list() down to one lane', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    await m.applyEvent(written(1, { tier: 'episodic', id: 'step-a', scope: 'plan-t1', title: 'Alpha step', body: 'alpha' }))
    await m.applyEvent(written(2, note({ id: 'claim', title: 'Alpha claim', body: 'alpha' })))
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const)
      expect((await m.search('alpha', { tier: 'semantic' }, { mode })).map(n => n.id)).toEqual(['claim'])
    expect((await m.list({ tier: 'episodic' })).map(n => n.id)).toEqual(['step-a'])
    await m.close()
  })
})

// The whole reason a claim carries its OWN vector: a note's embedding is title+summary+body, so a
// single statement buried in a long note is diluted to nothing. These are the claim-arm equivalents
// of the note tests above — same fake encoder, same synonym trick.
describe('SurrealMemory claim semantic + hybrid search', () => {
  const claim = (text: string) => ({ id: claimId(text), text, sourceRevision: null })

  it('finds a CLAIM by meaning when the query shares no token with it', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    await m.applyEvent(written(1, note({ id: 'na', title: 'A', claims: [claim('the alpha invariant holds')] })))
    await m.applyEvent(written(2, note({ id: 'nb', title: 'B', claims: [claim('the beta invariant holds')] })))
    // 'zeta' is in neither claim's text → the keyword arm cannot serve it…
    expect(await m.searchClaims('zeta', {}, { mode: 'keyword' })).toEqual([])
    // …but it maps to alpha's vector, so the claim arm surfaces the alpha STATEMENT
    const hits = await m.searchClaims('zeta', {}, { mode: 'semantic' })
    expect(hits[0]?.noteId).toBe('na')
    expect(hits[0]?.text).toBe('the alpha invariant holds')
    await m.close()
  })

  it('embeds each claim separately — two claims on ONE note rank independently', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    // both statements live on the SAME note, so a note-level vector could not tell them apart
    await m.applyEvent(written(1, note({ id: 'n', title: 'N', claims: [claim('alpha statement'), claim('beta statement')] })))
    expect((await m.searchClaims('zeta', {}, { mode: 'semantic' }))[0]?.text).toBe('alpha statement')
    expect((await m.searchClaims('beta', {}, { mode: 'semantic' }))[0]?.text).toBe('beta statement')
    await m.close()
  })

  it('hybrid fuses both claim arms; agreement between them wins', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    // 'both' matches 'alpha' by keyword AND vector; 'sem' only by vector (zeta ≈ alpha, no token)
    await m.applyEvent(written(1, note({ id: 'both', title: 'B', claims: [claim('alpha holds here')] })))
    await m.applyEvent(written(2, note({ id: 'sem', title: 'S', claims: [claim('zeta holds here')] })))
    const ids = (await m.searchClaims('alpha', {}, { mode: 'hybrid' })).map(h => h.noteId)
    expect(ids[0]).toBe('both')
    expect(ids).toContain('sem') // the semantic-only claim survives the fuse; fails if mis-keyed
    await m.close()
  })

  it('claim search degrades to keyword when no embedder is configured', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t) // no embedder
    await m.applyEvent(written(1, note({ id: 'n', title: 'N', claims: [claim('tokens rotate on use')] })))
    expect((await m.searchClaims('tokens', {}, { mode: 'semantic' })).map(h => h.text)).toEqual(['tokens rotate on use'])
    expect(await m.searchClaims('zeta', {}, { mode: 'semantic' })).toEqual([]) // no vector path, no match
    await m.close()
  })

  it('a retired claim loses its vector too — semantic cannot resurrect it', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    await m.applyEvent(written(1, note({ id: 'n', title: 'N', claims: [claim('alpha was true once')] })))
    expect(await m.searchClaims('zeta', {}, { mode: 'semantic' })).toHaveLength(1)
    await m.applyEvent(written(2, note({ id: 'n', title: 'N', claims: [] })))
    expect(await m.searchClaims('zeta', {}, { mode: 'semantic' })).toEqual([])
    await m.close()
  })
})
