import { describe, expect, it } from 'bun:test'
import { cosine, medoidOf, partition } from './cluster'

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
