import { afterAll, describe, expect, it } from 'bun:test'
import { claimId, MEMORY_LIMITS, PROJECT_NAME_NOTE_ID, type EmbeddingProvider, type EventRecord, type MemoryAuthor, EVENT_KIND } from '@orc/contracts'
import { Surreal } from 'surrealdb'
import { authorFixture, claimFixture, eventFixture } from '@orc/contracts/fixtures'
import { topicLabel } from './cluster'
import { SurrealMemory } from './surreal'
import { createTestSurreal, noteFixture } from './test-helpers'

// Same fake encoder shape as semantic-search.test.ts: 'zeta' maps to alpha's vector while sharing no
// token with it, so grouping is proven by MEANING rather than by shared words.
const vec = (text: string): number[] => {
  const t = text.toLowerCase()
  if (t.includes('alpha') || t.includes('zeta')) return [1, 0, 0]
  if (t.includes('beta')) return [0, 1, 0]
  return [0, 0, 1]
}
const fakeEmbedder: EmbeddingProvider = { embed: async texts => texts.map(vec) }

const cli: MemoryAuthor = authorFixture()
const written = (seq: number, n: object): EventRecord =>
  eventFixture({ seq, taskId: null, kind: EVENT_KIND.memory_written, payload: { note: n, author: cli }, ts: `2026-07-26T0${seq}:00:00Z` })

const drops: (() => Promise<void>)[] = []
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

// close is registered beside the drop, not awaited at the end of each test: a bare trailing
// `await m.close()` is skipped the moment an expect throws, leaking the websocket past the file
const open = async () => {
  const t = await createTestSurreal(); drops.push(t.drop)
  const m = await SurrealMemory.open(t, fakeEmbedder)
  drops.push(() => m.close())
  return m
}

describe('SurrealMemory topic projection', () => {
  it('groups claims that mean the same thing and separates ones that do not', async () => {
    const m = await open()
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds')] })))
    await m.applyEvent(written(2, noteFixture({ id: 'n2', claims: [claimFixture('zeta holds')] })))
    await m.applyEvent(written(3, noteFixture({ id: 'n3', claims: [claimFixture('beta holds')] })))
    await m.refreshTopics(0.75)
    const topics = await m.topics()
    expect(topics).toHaveLength(2)
    const big = topics.find(t => t.size === 2)
    // the label is the DERIVED one (cluster.ts topicLabel), which for a claim shorter than the cap
    // is the claim itself — the medoid is one of the two grouped statements
    expect(big?.label).toMatch(/alpha holds|zeta holds/)
  })

  // The case the two-word fixtures above cannot reach: a medoid longer than the label cap. A
  // bounded label is derived from the medoid, never its full text: a real 300-char claim as the
  // label became the whole CLI row and most of an agent's memory_topics budget. refreshTopics is
  // the ONE place that is decided.
  it('derives a bounded label from a medoid longer than the cap, and keeps the full text in topicClaims', async () => {
    const m = await open()
    const long = `alpha holds ${'and so does everything else about alpha '.repeat(20)}`.trim()
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture(long)] })))
    await m.refreshTopics(0.75)
    const [topic] = await m.topics()
    expect(long.length).toBeGreaterThan(MEMORY_LIMITS.topicLabelChars)
    expect(topic?.label).toBe(topicLabel(long, MEMORY_LIMITS.topicLabelChars))
    expect((topic?.label ?? '').length).toBeLessThanOrEqual(MEMORY_LIMITS.topicLabelChars)
    // detail is not lost, it moved: one call reaches the whole sentence verbatim
    expect((await m.topicClaims(topic?.topicKey ?? '')).map(c => c.text)).toEqual([long])
  })

  // Deleting a project used to CLEAR its knowledge database, which empties the rows and leaves the
  // database object behind — one per deleted project, collected by nothing. Four abandoned projects
  // left four such shells in a namespace with no listing to notice them. drop() removes the object.
  //
  // Asserted through a namespace-level INFO, the same shape test-helpers' own cleanup uses: whether
  // a DATABASE exists is not a question any store scoped INSIDE that database can answer.
  it('drop() removes the database itself, not just its rows', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t, fakeEmbedder)
    drops.push(() => m.close())
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toHaveLength(1)

    const listDatabases = async (): Promise<string[]> => {
      const s = new Surreal()
      try {
        await s.connect(t.url)
        await s.signin({ username: t.username, password: t.password })
        await s.use({ namespace: t.ns })
        const [info] = await s.query<[{ databases: Record<string, unknown> }]>('INFO FOR NS;')
        return Object.keys(info?.databases ?? {})
      } finally {
        await s.close()
      }
    }

    expect(await listDatabases()).toContain(t.db)
    await m.drop()
    expect(await listDatabases()).not.toContain(t.db)
  })

  it('a refresh replaces the table wholesale and is idempotent on unchanged claims', async () => {
    const m = await open()
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds')] })))
    await m.refreshTopics(0.75)
    const first = await m.topics()
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual(first)
  })

  it('drops a topic whose claims were retired', async () => {
    const m = await open()
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toHaveLength(1)
    await m.applyEvent(written(2, noteFixture({ id: 'n1', claims: [] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual([])
  })

  it('clusters the project scope only — a plan-scope claim is not grouped', async () => {
    const m = await open()
    await m.applyEvent(written(1, noteFixture({ id: 'p', scope: 'plan-t1', claims: [claimFixture('alpha holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual([])
  })

  it('returns a topic’s claims, and nothing for a key from an older partition', async () => {
    const m = await open()
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds'), claimFixture('zeta holds')] })))
    await m.refreshTopics(0.75)
    const key = (await m.topics())[0]?.topicKey ?? ''
    expect((await m.topicClaims(key)).map(c => c.text).sort()).toEqual(['alpha holds', 'zeta holds'])
    expect(await m.topicClaims('deadbeef0000')).toEqual([])
  })

  // A claim ROW is keyed (scope, noteId, claimId), so one statement asserted on two notes is two
  // rows — but a topic groups STATEMENTS and `size` counts the id once. The list used to return both
  // rows under a size that said one, and `Claim` carries no noteId, so it read as two independent
  // corroborations of the same fact.
  it('a statement asserted on two notes is ONE claim in its topic, matching the topic’s size', async () => {
    const m = await open()
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds')] })))
    await m.applyEvent(written(2, noteFixture({ id: 'n2', claims: [claimFixture('alpha holds')] })))
    await m.refreshTopics(0.75)
    const [topic] = await m.topics()
    expect(topic?.size).toBe(1)
    const claims = await m.topicClaims(topic?.topicKey ?? '')
    expect(claims).toHaveLength(1)
    // the earliest sighting of the STATEMENT, not whichever row the select happened to return first
    expect(claims[0]?.validFrom).toBe('2026-07-26T01:00:00Z')
  })

  // `embedding: map.get(id)` named the key unconditionally, and surqlize emits an assignment for
  // every named key — so an absent vector became `SET embedding = NONE`, which REMOVES the column.
  // embedClaims returns an EMPTY map on any embedder failure, so one Ollama blip while projecting a
  // later write to the note erased the vectors of every claim already on it, silently and for good.
  it('an embedder blip on a later write leaves the surviving claims’ vectors intact', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    let up = true
    const flaky: EmbeddingProvider = {
      embed: async texts => { if (!up) throw new Error('embedder down (simulated)'); return texts.map(vec) },
    }
    const m = await SurrealMemory.open(t, flaky)
    drops.push(() => m.close())
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds'), claimFixture('beta holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toHaveLength(2)

    up = false
    await m.applyEvent(written(2, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds'), claimFixture('beta holds'), claimFixture('gamma holds')] })))
    await m.refreshTopics(0.75)
    // the two already-embedded claims keep their vectors and their topics; only the NEW claim is
    // left unembedded, so it is keyword-only until the next write or a rebuild with the embedder up
    expect(await m.topics()).toHaveLength(2)
  })

  // A topic is a retrieval surface, so the same exclusion search() and the claim arm apply holds
  // here: without it a claim on a ui-metadata note becomes a topic member and comes back from
  // memory_topics while the note itself stays hidden.
  it('excludes claims on ui-metadata notes from the partition', async () => {
    const m = await open()
    await m.applyEvent(written(1, noteFixture({ id: PROJECT_NAME_NOTE_ID, claims: [claimFixture('alpha holds')] })))
    expect(await m.topics()).toEqual([])
    await m.applyEvent(written(2, noteFixture({ id: 'n2', claims: [claimFixture('beta holds')] })))
    await m.refreshTopics(0.75)
    const claims = await m.topicClaims((await m.topics())[0]?.topicKey ?? '')
    expect(claims.map(c => c.text)).toEqual(['beta holds'])
  })

  it('with no embedder there are no vectors, so no topics — claims stay findable', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t) // no embedder
    drops.push(() => m.close())
    await m.applyEvent(written(1, noteFixture({ id: 'n1', claims: [claimFixture('alpha holds')] })))
    await m.refreshTopics(0.75)
    expect(await m.topics()).toEqual([])
    expect(await m.searchClaims('alpha')).toHaveLength(1)
  })
})
