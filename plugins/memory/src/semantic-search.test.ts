import { afterAll, describe, expect, it } from 'bun:test'
import { type EmbeddingProvider, type EventRecord, type MemoryAuthor, EVENT_KIND } from '@orc/contracts'
import { TEST_WORKSPACE_ID, eventFixture } from '@orc/contracts/fixtures'
import { SEMANTIC_FLOOR, SurrealMemory } from './surreal'
import { claimFixture, createTestSurreal, noteFixture } from './test-helpers'

// A deterministic fake encoder: maps text to one of three orthogonal vectors by concept keyword.
// 'zeta' shares NO literal token with the 'alpha' note yet maps to the SAME vector — the synonym
// case keyword search cannot serve. dimensions = 3 keeps cosine trivially checkable.
// 'faint'/'near' are CALIBRATION vectors that straddle SEMANTIC_FLOOR against alpha's [1, 0, 0]:
// cosine against a unit x-axis is just the first component, so they score 0.36 and 0.76. They pin
// the floor's MAGNITUDE rather than merely its existence — this file fails if the constant ever
// leaves that band, which is the guard a re-tune needs (the value is corpus- and model-specific;
// see the sweep table beside SEMANTIC_FLOOR).
const vec = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('alpha') || t.includes('zeta')) return [1, 0, 0] // zeta ≈ alpha in fake-space
  if (t.includes('beta')) return [0, 1, 0]
  if (t.includes('faint')) return [0.36, 0.933, 0] // ‖v‖ = 1; cosine vs alpha = 0.36, below the floor
  if (t.includes('near')) return [0.76, 0.650, 0] // ‖v‖ = 1; cosine vs alpha = 0.76, above the floor
  if (t.includes('dim')) return [0.55, 0.835, 0] // ‖v‖ = 1; cosine vs alpha = 0.55 — above the floor, clearly worse
  return [0, 0, 1]
}
const fakeEmbedder: EmbeddingProvider = { embed: async texts => texts.map(vec) }

const cli: MemoryAuthor = { source: 'cli', workspaceId: TEST_WORKSPACE_ID }
const written = (seq: number, n: object): EventRecord =>
  eventFixture({ seq, taskId: null, kind: EVENT_KIND.memory_written, payload: { note: n, author: cli }, ts: `2026-07-24T0${seq}:00:00Z` })
const accessed = (seq: number, id: string): EventRecord =>
  eventFixture({ seq, taskId: null, kind: EVENT_KIND.memory_accessed, payload: { id, scope: 'project', mode: 'read', author: cli }, ts: `2026-07-24T0${seq}:00:00Z` })

const drops: (() => Promise<void>)[] = []
// concurrent drops with a real hook budget — same fix and reason as surreal.test.ts's teardown:
// serial drops blow bun's default 5s hook budget as the file grows
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

// Teardown must be unconditional: a bare `await m.close()` after the assertions is skipped the
// moment an expect above it throws, and the leaked websocket outlives the test file. Registering
// close beside the database drop makes a FAILING test clean up too.
const openMemory = async (...args: Parameters<typeof SurrealMemory.open>) => {
  const m = await SurrealMemory.open(...args)
  drops.push(() => m.close())
  return m
}

describe('SurrealMemory semantic + hybrid search', () => {
  it('finds a note by MEANING when the query shares no tokens with it (keyword misses, semantic hits)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'alpha-note', title: 'Alpha subject', summary: 'the alpha thing', body: 'alpha' })))
    await m.applyEvent(written(2, noteFixture({ id: 'beta-note', title: 'Beta subject', summary: 'the beta thing', body: 'beta' })))
    // 'zeta' appears in NEITHER note → keyword returns nothing…
    expect(await m.search('zeta', {}, { mode: 'keyword' })).toEqual([])
    // …but it maps to alpha's vector, so semantic surfaces the alpha note first
    expect((await m.search('zeta', {}, { mode: 'semantic' }))[0]?.id).toBe('alpha-note')
  })

  it('semantic mode is exact by vector; hybrid fuses both arms', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'alpha-note', title: 'Alpha', summary: 'alpha', body: 'alpha' })))
    await m.applyEvent(written(2, noteFixture({ id: 'beta-note', title: 'Beta', summary: 'beta', body: 'beta' })))
    expect((await m.search('beta', {}, { mode: 'semantic' }))[0]?.id).toBe('beta-note')
    // 'alpha' matches alpha-note by BOTH keyword and vector → agreement ranks it first
    expect((await m.search('alpha', {}, { mode: 'hybrid' }))[0]?.id).toBe('alpha-note')
  })

  it('falls back to keyword when no embedder is configured, even if a semantic mode is requested', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t) // no embedder → degraded to keyword
    await m.applyEvent(written(1, noteFixture({ id: 'k', title: 'Tokens', summary: 'tokens rotate', body: 'x' })))
    expect((await m.search('tokens', {}, { mode: 'semantic' })).map(n => n.id)).toEqual(['k']) // keyword still serves
    expect(await m.search('zeta', {}, { mode: 'semantic' })).toEqual([]) // no vector path, no match
  })

  it('hybrid fusion is load-bearing: keyword agreement lifts a note above a hotter semantic-only one', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    // 'both' matches query 'alpha' by BOTH keyword (token 'alpha') and vector; left cold.
    await m.applyEvent(written(1, noteFixture({ id: 'both', title: 'Alpha', summary: 'alpha', body: 'alpha' })))
    // 'sem' matches ONLY by vector (body 'zeta' ≈ alpha, no 'alpha' token) and is read twice → hot,
    // so in the semantic arm alone it outranks 'both'. Only keyword agreement can flip the order.
    await m.applyEvent(written(2, noteFixture({ id: 'sem', title: 'S', summary: 'zeta', body: 'zeta' })))
    await m.applyEvent(accessed(3, 'sem'))
    await m.applyEvent(accessed(4, 'sem'))
    const ids = (await m.search('alpha', {}, { mode: 'hybrid' })).map(n => n.id)
    expect(ids[0]).toBe('both') // fails if only the semantic arm is returned (would give the hotter 'sem')
    expect(ids).toContain('sem') // the semantic-only note survives the (scope,id) fuse; fails if mis-keyed
  })

  // A corpus about one subject, queried about an unrelated one. Without a floor the ranker still
  // hands back its least-bad row, which is how a search for a subject the project has never touched
  // came back with three confident notes — see bench/probes.json category=negative. The paired
  // above-floor assertion is what stops a future "fix" from simply returning [] more often.
  it('returns nothing when every candidate is below the relevance floor', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'floor-a', title: 'Alpha subject', summary: 'the alpha thing', body: 'alpha' })))
    expect(await m.search('faint resemblance', {}, { mode: 'semantic' })).toEqual([])
    expect((await m.search('near resemblance', {}, { mode: 'semantic' })).map(n => n.id)).toEqual(['floor-a'])
  })

  // Heat must MODULATE the cosine, never overrule it. Measured on the live corpus: the hottest note
  // has 9 hits (heat 1.57), while the `+1` shift the ranker used to apply compressed the whole
  // observed cosine range 0.417..0.769 into 1.417..1.769 — a 1.25x spread facing a 1.57x modulator,
  // so the least relevant note in the corpus could outrank the most relevant one. `dim` is a
  // materially worse match than `alpha` (0.55 vs 1.0) but is read 9 times TODAY; the cold exact
  // match must still win. Fails against `(r.score + 1) * heat`, which scores dim 2.44 to alpha 2.00.
  it('a much hotter note does NOT outrank a much better cosine match (heat modulates, never overrules)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'cold-exact', title: 'Alpha subject', summary: 'alpha', body: 'alpha' })))
    await m.applyEvent(written(2, noteFixture({ id: 'hot-vague', title: 'Dim subject', summary: 'dim', body: 'dim' })))
    // ts = NOW, not a fixture date: activation decays against the real clock, so a fixed 2026-07-24
    // stamp would quietly decay to heat≈1 as time passes and leave a test that can no longer fail.
    for (let seq = 3; seq <= 11; seq += 1)
      await m.applyEvent(eventFixture({ seq, taskId: null, kind: EVENT_KIND.memory_accessed, ts: new Date().toISOString(),
        payload: { id: 'hot-vague', scope: 'project', mode: 'read', author: cli } }))
    expect((await m.search('alpha', {}, { mode: 'semantic' })).map(n => n.id)).toEqual(['cold-exact', 'hot-vague'])
  })

  // The re-rank scores `cosine * heat` with heat ≥ 1, so it orders correctly only for cosine ≥ 0:
  // increasing in heat above 0, flat at 0, INVERTED below it. A NEGATIVE floor would admit rows the
  // product ranks backwards. Zero is safe — `>=` still drops every negative cosine — it merely stops
  // being a useful floor, which the floor test above catches instead. Pin the sign, not more.
  // The WITHIN-QUERY margin rule, the half of the negative fix SEMANTIC_FLOOR's comment could not
  // buy: the five negatives left answering on the bench corpus are all above the floor, and what
  // distinguishes them is not their score but that NOTHING in the candidate set scores better —
  // the query pulled back a flat field. A scalar floor cannot see that; this can. Twelve
  // above-floor candidates are used because the rule abstains below one window (see meetsMargin).
  it('stays silent when the top cosine is level with its own candidate field (margin rule)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    // every note is the SAME mediocre match for 'alpha' (0.55, comfortably above the floor)
    for (let i = 1; i <= 12; i += 1)
      await m.applyEvent(written(i, noteFixture({ id: `dim-${i}`, title: `Dim ${i}`, summary: 'dim', body: 'dim' })))
    expect(await m.search('alpha', {}, { mode: 'semantic' })).toEqual([])
    // …and the paired assertion, so a future "fix" cannot just return [] more often: one note that
    // actually stands out (0.76) makes the arm answer, and answer with THAT note.
    await m.applyEvent(written(13, noteFixture({ id: 'stands-out', title: 'Near', summary: 'near', body: 'near' })))
    expect((await m.search('alpha', {}, { mode: 'semantic' }))[0]?.id).toBe('stands-out')
  }, 30_000)

  it('SEMANTIC_FLOOR stays non-negative, or cos × heat inverts on the rows it admits', () => {
    expect(SEMANTIC_FLOOR).toBeGreaterThanOrEqual(0)
  })

  it('a note that gets USED ranks above an equally-relevant cold note (activation heat)', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'alpha-hot', title: 'Alpha one', summary: 'alpha', body: 'alpha' })))
    await m.applyEvent(written(2, noteFixture({ id: 'alpha-cold', title: 'Alpha two', summary: 'alpha', body: 'alpha' })))
    // both map to the SAME vector (a cosine tie) — only read-heat can separate them
    await m.applyEvent(accessed(3, 'alpha-hot'))
    await m.applyEvent(accessed(4, 'alpha-hot'))
    expect((await m.search('alpha', {}, { mode: 'semantic' })).map(n => n.id)).toEqual(['alpha-hot', 'alpha-cold'])
  })
})

describe('tier on the retrieval surface', () => {
  // Regression: the cosine SELECT projected every summary field EXCEPT tier, so a vector hit on a
  // plan or episodic note came back labelled 'semantic' — the lane a reader uses to tell durable
  // knowledge from one run's trail was fabricated by shape inference over a row that carries none
  // of the columns inference reads.
  it('a vector hit reports the lane it actually came from, not an inferred one', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, { tier: 'plan', id: 'subplan', scope: 'plan-t1', title: 'Alpha subplan', body: 'alpha', rationale: 'why' }))
    await m.applyEvent(written(2, { tier: 'episodic', id: 'step-a', scope: 'plan-t1', title: 'Alpha step', body: 'alpha' }))
    await m.applyEvent(written(3, noteFixture({ id: 'claim', title: 'Alpha claim', body: 'alpha' })))
    const byId = new Map((await m.search('alpha', {}, { mode: 'semantic' })).map(n => [n.id, n.tier]))
    expect(byId.get('subplan')).toBe('plan')
    expect(byId.get('step-a')).toBe('episodic')
    expect(byId.get('claim')).toBe('semantic')
  })

  it('filters both retrieval arms and list() down to one lane', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, { tier: 'episodic', id: 'step-a', scope: 'plan-t1', title: 'Alpha step', body: 'alpha' }))
    await m.applyEvent(written(2, noteFixture({ id: 'claim', title: 'Alpha claim', body: 'alpha' })))
    for (const mode of ['keyword', 'semantic', 'hybrid'] as const)
      expect((await m.search('alpha', { tier: 'semantic' }, { mode })).map(n => n.id)).toEqual(['claim'])
    expect((await m.list({ tier: 'episodic' })).map(n => n.id)).toEqual(['step-a'])
  })
})

// The whole reason a claim carries its OWN vector: a note's embedding is title+summary+body, so a
// single statement buried in a long note is diluted to nothing. These are the claim-arm equivalents
// of the note tests above — same fake encoder, same synonym trick.
describe('SurrealMemory claim semantic + hybrid search', () => {

  it('finds a CLAIM by meaning when the query shares no token with it', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'na', title: 'A', claims: [claimFixture('the alpha invariant holds')] })))
    await m.applyEvent(written(2, noteFixture({ id: 'nb', title: 'B', claims: [claimFixture('the beta invariant holds')] })))
    // 'zeta' is in neither claim's text → the keyword arm cannot serve it…
    expect(await m.searchClaims('zeta', {}, { mode: 'keyword' })).toEqual([])
    // …but it maps to alpha's vector, so the claim arm surfaces the alpha STATEMENT
    const hits = await m.searchClaims('zeta', {}, { mode: 'semantic' })
    expect(hits[0]?.noteId).toBe('na')
    expect(hits[0]?.text).toBe('the alpha invariant holds')
  })

  it('embeds each claim separately — two claims on ONE note rank independently', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    // both statements live on the SAME note, so a note-level vector could not tell them apart
    await m.applyEvent(written(1, noteFixture({ id: 'n', title: 'N', claims: [claimFixture('alpha statement'), claimFixture('beta statement')] })))
    expect((await m.searchClaims('zeta', {}, { mode: 'semantic' }))[0]?.text).toBe('alpha statement')
    expect((await m.searchClaims('beta', {}, { mode: 'semantic' }))[0]?.text).toBe('beta statement')
  })

  it('hybrid fuses both claim arms; agreement between them wins', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    // 'both' matches 'alpha' by keyword AND vector; 'sem' only by vector (zeta ≈ alpha, no token)
    await m.applyEvent(written(1, noteFixture({ id: 'both', title: 'B', claims: [claimFixture('alpha holds here')] })))
    await m.applyEvent(written(2, noteFixture({ id: 'sem', title: 'S', claims: [claimFixture('zeta holds here')] })))
    const ids = (await m.searchClaims('alpha', {}, { mode: 'hybrid' })).map(h => h.noteId)
    expect(ids[0]).toBe('both')
    expect(ids).toContain('sem') // the semantic-only claim survives the fuse; fails if mis-keyed
  })

  it('claim search degrades to keyword when no embedder is configured', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t) // no embedder
    await m.applyEvent(written(1, noteFixture({ id: 'n', title: 'N', claims: [claimFixture('tokens rotate on use')] })))
    expect((await m.searchClaims('tokens', {}, { mode: 'semantic' })).map(h => h.text)).toEqual(['tokens rotate on use'])
    expect(await m.searchClaims('zeta', {}, { mode: 'semantic' })).toEqual([]) // no vector path, no match
  })

  // The claim arm is the hotter path (every memory_search and every step preload) and gets the SAME
  // floor. Without its own case, deleting the filter in semanticClaims leaves the note arm's test
  // green while the arm that actually answers agents keeps handing back its least-bad statement.
  it('the claim arm applies the same floor as the note arm', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'n', title: 'N', claims: [claimFixture('the alpha invariant holds')] })))
    expect(await m.searchClaims('faint resemblance', {}, { mode: 'semantic' })).toEqual([])
    expect((await m.searchClaims('near resemblance', {}, { mode: 'semantic' })).map(h => h.noteId)).toEqual(['n'])
  })

  it('a retired claim loses its vector too — semantic cannot resurrect it', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await openMemory(t, fakeEmbedder)
    await m.applyEvent(written(1, noteFixture({ id: 'n', title: 'N', claims: [claimFixture('alpha was true once')] })))
    expect(await m.searchClaims('zeta', {}, { mode: 'semantic' })).toHaveLength(1)
    await m.applyEvent(written(2, noteFixture({ id: 'n', title: 'N', claims: [] })))
    expect(await m.searchClaims('zeta', {}, { mode: 'semantic' })).toEqual([])
  })
})
