import { describe, expect, it } from 'bun:test'
import { MEMORY_LIMITS } from '@orc/contracts'
import { cosine, medoidOf, partition, topicLabel } from './cluster'

// Hand-written vectors, no embedder: 'a*' point one way, 'b*' the other, 'z' sits alone.
const v = (id: string, x: number, y: number, z: number) => ({ id, vector: [x, y, z] })
const A1 = v('aaaaaaaaaaa1', 1, 0, 0)
const A2 = v('aaaaaaaaaaa2', 0.98, 0.2, 0)   // ~0.985 cosine with A1
const B1 = v('bbbbbbbbbbb1', 0, 1, 0)
const Z1 = v('cccccccccccc', 0, 0, 1)
// medoidClaimId rides along in the key so a non-deterministic medoid can't slip through order checks
const keysOf = (cs: ReturnType<typeof partition>) =>
  cs.map(c => `${c.key}[${[...c.members].sort().join(',')}]:${c.medoidClaimId}`).sort()

describe('cosine', () => {
  it('is 1 for identical direction, 0 for orthogonal', () => {
    expect(cosine([1, 0, 0], [2, 0, 0])).toBeCloseTo(1)
    expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0)
  })
  // a degenerate embedding must not poison every comparison it takes part in
  it('is 0 against a zero vector rather than NaN', () => {
    expect(cosine([0, 0, 0], [1, 0, 0])).toBe(0)
  })
})

describe('partition', () => {
  it('groups similar claims and leaves dissimilar ones apart', () => {
    const out = partition([A1, A2, B1], 0.75)
    expect(out).toHaveLength(2)
    expect(keysOf(out)).toEqual([
      'aaaaaaaaaaa1[aaaaaaaaaaa1,aaaaaaaaaaa2]:aaaaaaaaaaa1',
      'bbbbbbbbbbb1[bbbbbbbbbbb1]:bbbbbbbbbbb1',
    ])
  })

  it('keys a topic by its LOWEST member id, so the key is reproducible from the member set', () => {
    expect(partition([A2, A1], 0.75)[0]?.key).toBe('aaaaaaaaaaa1')
  })

  // THE property the algorithm was chosen for. A leader/threshold-join cannot satisfy it, which is
  // why average-link agglomerative is used: the globally-best pair is merged each round, not the
  // first acceptable one, so arrival order cannot change the outcome.
  it('yields an identical partition for every input order', () => {
    const assertOrderInvariant = (orders: ReturnType<typeof v>[][]) => {
      const results = orders.map(o => keysOf(partition(o, 0.75)))
      expect(results[1]).toEqual(results[0])
      expect(results[2]).toEqual(results[0])
    }

    // A1/A2 are the only pair above threshold here, so there is only one merge decision to make —
    // this alone would pass under a leader/threshold-join algorithm too and cannot rule it out.
    assertOrderInvariant([
      [A1, A2, B1, Z1],
      [Z1, B1, A2, A1],
      [B1, A1, Z1, A2],
    ])

    // The case that DOES rule leader/threshold-join out: a chain X-Y-Z where X-Y and Y-Z both clear
    // the threshold (cos 36 deg ~= 0.809) but X-Z does not (cos 72 deg ~= 0.309). A leader algorithm
    // joins whichever group it meets first, so its result depends on which point arrives first —
    // starting from X merges {X,Y} leaving Z alone, from Y merges all three, from Z merges {Y,Z}
    // leaving X alone: three different partitions. Average-link merges the globally best pair
    // first regardless of arrival order, so every starting point below gives the same partition.
    const X = v('ddddddddddd1', 1, 0, 0)
    const Y = v('ddddddddddd2', 0.809, 0.588, 0)
    const Z = v('ddddddddddd3', 0.309, 0.951, 0)
    assertOrderInvariant([
      [X, Y, Z],
      [Y, Z, X],
      [Z, X, Y],
    ])
  })

  // The one case the order-invariance test above cannot reach: the SAME id arriving with DIFFERENT
  // vectors, which happens after an embedding-model change without a rebuild. The dedupe used to be
  // `new Map(claims.map(…))` — last occurrence wins — so the partition depended on which row
  // SurrealDB returned last. Keeping the FIRST would be just as positional; the pick is by vector
  // content, so every arrangement of the same three rows lands on the same answer.
  it('resolves a duplicate id carrying conflicting vectors the same way in every input order', () => {
    const conflictA = { id: 'eeeeeeeeeee1', vector: [0, 1, 0] }
    const conflictB = { id: 'eeeeeeeeeee1', vector: [1, 0, 0] }
    const other = { id: 'eeeeeeeeeee2', vector: [0, 1, 0] }
    const expected = keysOf(partition([conflictA, conflictB, other], 0.75))
    for (const order of [[conflictB, conflictA, other], [other, conflictA, conflictB], [other, conflictB, conflictA]])
      expect(keysOf(partition(order, 0.75))).toEqual(expected)
  })

  it('keeps a lone claim as its own topic — a curated fact is never dropped as an outlier', () => {
    const out = partition([A1, B1, Z1], 0.75)
    expect(out).toHaveLength(3)
    expect(out.every(c => c.members.length === 1)).toBe(true)
  })

  it('is empty for no claims', () => {
    expect(partition([], 0.75)).toEqual([])
  })

  it('a threshold of 0 collapses everything into one topic', () => {
    expect(partition([A1, B1, Z1], 0)).toHaveLength(1)
  })

  it('adding a claim whose id does not sort lowest leaves the key unchanged', () => {
    const before = partition([A1, A2], 0.75)[0]?.key
    const A3 = v('aaaaaaaaaaa3', 0.97, 0.24, 0)
    expect(partition([A1, A2, A3], 0.75)[0]?.key).toBe(before)
  })
})

// Real claim texts, copied verbatim out of this project's own corpus (memory_search over the
// project scope) — the label has to be judged on what agents actually write, not on lorem ipsum.
const REAL_CLAIMS = [
  'plugins/memory/src/tools.ts memory_topics listing budgets the inventory with applyBudget over `t => `${t.topicKey}${t.label}`` at limit MEMORY_LIMITS.labelItems (50) and the shared Budget schema (default 1500, max MEMORY_LIMITS.budgetTokens), so long labels both burn the agent\'s budget and truncate the listing.',
  'plugins/memory/src/surreal.ts refreshTopics() recomputes the whole project-scope partition outside the event transaction and replaces the `topic` table.',
  'docs/superpowers/specs/2026-07-26-claim-grouping-design.md pre-registers BOTH label upgrades under the single trigger "The inventory reads badly as sentences".',
  'packages/contracts/src/memory.ts\'s `MemoryStore` interface declares write/remove/get/list/search/searchClaims/claimsFor/neighbors/recordAccess/topics/topicClaims as the single-writer gateway contract every memory backend implements.',
  'kernel.ts Kernel.proposeSplit() computes budgetUSD via subtreeUsage(state, input.parentTaskId) and clamps to the parent\'s remaining budget.',
]

describe('topicLabel', () => {
  const CAP = MEMORY_LIMITS.topicLabelChars

  it('returns a short claim unchanged — a label that fits IS the whole fact', () => {
    expect(topicLabel('alpha holds', CAP)).toBe('alpha holds')
  })

  // The cap is the whole point: the row it renders into already carries a 12-char topicKey and a
  // size column, so a label past this cannot be scanned on an 80-column terminal.
  it('never emits a label longer than the cap, for any real claim', () => {
    for (const c of REAL_CLAIMS) expect(topicLabel(c, CAP).length).toBeLessThanOrEqual(CAP)
  })

  it('cuts at a word boundary, never mid-word, and marks the elision', () => {
    const long = 'plugins/memory/src/surreal.ts refreshTopics() recomputes the whole project-scope partition outside the event transaction'
    const label = topicLabel(long, CAP)
    expect(label.endsWith('…')).toBe(true)
    const head = label.slice(0, -1)
    // the label is a VERBATIM prefix of the claim — that is what makes "the full sentence is one
    // memory_topics <topicKey> call away" an honest promise rather than a paraphrase
    expect(long.startsWith(head)).toBe(true)
    // the character the cut fell on is whitespace: the last word survives whole
    expect(long[head.length]).toBe(' ')
  })

  // Stage 3 is recomputed wholesale, so a rebuild must reproduce the inventory byte-for-byte:
  // no clock, no locale, no arrival order can reach this function.
  it('is deterministic — same claim in, same label out', () => {
    for (const c of REAL_CLAIMS) expect(topicLabel(c, CAP)).toBe(topicLabel(c, CAP))
  })

  it('never returns empty for a non-empty claim', () => {
    for (const c of [...REAL_CLAIMS, 'x', '   spaced   ']) expect(topicLabel(c, CAP).length).toBeGreaterThan(0)
  })

  it('collapses newlines and runs of spaces — a label is one terminal row', () => {
    expect(topicLabel('alpha\n\nholds   twice', CAP)).toBe('alpha holds twice')
  })

  // The one case where a word boundary does not exist: a single token longer than the cap (a URL,
  // a long path). Bounded still wins over whole-word.
  it('bounds a single over-long word rather than overflowing the row', () => {
    const label = topicLabel('a'.repeat(CAP * 2), CAP)
    expect(label.length).toBe(CAP)
    expect(label.endsWith('…')).toBe(true)
  })

  it('distinguishes the project\'s real claims from one another', () => {
    const labels = REAL_CLAIMS.map(c => topicLabel(c, CAP))
    expect(new Set(labels).size).toBe(REAL_CLAIMS.length)
  })
})

// A mixed-model corpus is reachable without doing anything wrong: change memoryEmbedModel and skip
// the rebuild. Zero-padding returned a plausible number that was not a similarity, so the partition
// split along the MODEL boundary and looked merely under-clustered.
describe('cosine dimension mismatch', () => {
  it('throws rather than scoring vectors from two embedding models', () => {
    expect(() => cosine([1, 0, 0], [1, 0, 0, 0])).toThrow(/384d|3d vs 4d|embedding models/)
  })

  it('names the rebuild that fixes it', () => {
    expect(() => cosine(new Array(384).fill(1), new Array(1024).fill(1))).toThrow(/orc memory rebuild/)
  })

  it('still returns 0 for a degenerate vector of the SAME width', () => {
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0)
  })
})

describe('medoidOf', () => {
  it('picks the member most similar to the rest', () => {
    // A2 sits between A1 and A3, so it is the most representative of the three
    const A3 = v('aaaaaaaaaaa3', 0.9, 0.44, 0)
    expect(medoidOf([A1, A2, A3])).toBe('aaaaaaaaaaa2')
  })
  it('resolves a two-member tie on the lowest id, never on iteration order', () => {
    expect(medoidOf([A2, A1])).toBe('aaaaaaaaaaa1')
    expect(medoidOf([A1, A2])).toBe('aaaaaaaaaaa1')
  })
  it('returns the only member of a singleton', () => {
    expect(medoidOf([A1])).toBe('aaaaaaaaaaa1')
  })
})
