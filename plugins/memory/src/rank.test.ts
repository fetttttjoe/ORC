import { describe, expect, it } from 'bun:test'
import { rankNeighbors, DEFAULT_LINK_WEIGHTS, rrfFuse } from './rank'
import { must } from '@orc/contracts/fixtures'
import { LINK_KIND } from '@orc/contracts'

const edges = [
  { from: 'a', to: 'b', kind: LINK_KIND.supersedes }, // weight 1.0, depth 1 → 1.0
  { from: 'a', to: 'c', kind: LINK_KIND.relates_to }, // weight 0.5, depth 1 → 0.5
  { from: 'b', to: 'd', kind: LINK_KIND.refines },    // 1.0 × 0.9 × 0.6^1 = 0.54 — strong chain beats weak direct edge
]

describe('rankNeighbors', () => {
  it('ranks by best-score (Π edge-kind weight × decay^(depth-1)), excludes the seed', () => {
    const r = rankNeighbors(edges, ['a'], { depth: 3 })
    expect(r.map(n => n.id)).toEqual(['b', 'd', 'c']) // 1.0 > 0.54 > 0.5
    expect(r.find(n => n.id === 'a')).toBeUndefined()
    expect(r[0]).toMatchObject({ id: 'b', via: 'supersedes', depth: 1 })
    expect(r[1]).toMatchObject({ id: 'd', via: 'refines', depth: 2 })
    expect(r[1].score).toBeCloseTo(0.54)
  })

  it('is a pure function of the graph: edge-array order does not change the ranking, and direction is carried', () => {
    const shuffled = [must(edges[2], 'edges[2]'), must(edges[0], 'edges[0]'), must(edges[1], 'edges[1]')] // same graph, different fetch order (a rebuild reshuffles ids)
    expect(rankNeighbors(shuffled, ['a'], { depth: 3 }).map(n => n.id))
      .toEqual(rankNeighbors(edges, ['a'], { depth: 3 }).map(n => n.id))
    const dir = rankNeighbors([{ from: 'a', to: 'b', kind: LINK_KIND.supersedes, direction: 'in' as const }], ['a'])
    expect(dir[0]).toMatchObject({ id: 'b', via: 'supersedes', direction: 'in' })
  })

  it('breaks genuine score ties deterministically (final order by id, best-path via by kind)', () => {
    // two DIFFERENT nodes at equal score+depth → final order is id-asc regardless of edge-array order
    const twoNodes = [
      { from: 'a', to: 'c', kind: LINK_KIND.relates_to }, // 0.5
      { from: 'a', to: 'b', kind: LINK_KIND.relates_to }, // 0.5
    ]
    expect(rankNeighbors(twoNodes, ['a']).map(n => n.id)).toEqual(['b', 'c'])
    expect(rankNeighbors([...twoNodes].reverse(), ['a']).map(n => n.id)).toEqual(['b', 'c'])
    // two equal-score paths to ONE node via different kinds (1.0×0.5 == 0.5×1.0) → via tie-break
    // picks the lexicographically smaller kind, identical whichever edge is seen first
    const oneNode = [
      { from: 'a', to: 'd', kind: LINK_KIND.supersedes, confidence: 0.5 }, // 1.0 × 0.5 = 0.5
      { from: 'a', to: 'd', kind: LINK_KIND.relates_to, confidence: 1 },   // 0.5 × 1.0 = 0.5
    ]
    expect(rankNeighbors(oneNode, ['a'])[0]).toMatchObject({ id: 'd', via: 'relates_to' })
    expect(rankNeighbors([...oneNode].reverse(), ['a'])[0]).toMatchObject({ id: 'd', via: 'relates_to' })
  })

  it('carries the best-path predecessor as `from` — the seed at depth 1, the intermediate node at depth 2', () => {
    const r = rankNeighbors(edges, ['a'], { depth: 3 })
    expect(r.find(n => n.id === 'b')).toMatchObject({ from: 'a', depth: 1 }) // depth 1: predecessor is the seed
    expect(r.find(n => n.id === 'd')).toMatchObject({ from: 'b', depth: 2 }) // depth 2: predecessor is the intermediate hop
  })

  it('prunes below the floor', () => {
    expect(rankNeighbors(edges, ['a'], { depth: 3, floor: 0.6 }).map(n => n.id)).toEqual(['b'])
  })

  it('filters by kind, caps result count, and down-weights by confidence', () => {
    expect(rankNeighbors(edges, ['a'], { kinds: ['supersedes'] }).map(n => n.id)).toEqual(['b'])
    expect(rankNeighbors(edges, ['a'], { cap: 1 })).toHaveLength(1)
    const low = rankNeighbors([{ from: 'a', to: 'b', kind: LINK_KIND.supersedes, confidence: 0.1 }], ['a'])
    expect(low[0].score).toBeCloseTo(0.1) // 1.0 weight × 0.1 confidence, no decay at depth 1
    expect(DEFAULT_LINK_WEIGHTS.relates_to).toBe(0.5)
  })
})

describe('rrfFuse', () => {
  it('sums reciprocal rank across lists; equal totals break by id-asc', () => {
    // a: 1/60 + 1/61 ; b: 1/61 + 1/60 (equal to a) → id-asc puts a first; c,d: 1/62 each → c before d
    expect(rrfFuse([['a', 'b', 'c'], ['b', 'a', 'd']]).map(r => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('rewards agreement: an id present in BOTH lists can outrank one that tops only one list', () => {
    // x tops list 1 alone (1/60 ≈ 0.0167); y is rank-1 in both (2/61 ≈ 0.0328) → y wins
    expect(rrfFuse([['x', 'y'], ['z', 'y']])[0].id).toBe('y')
  })

  it('is a pure function of the lists — list order does not change the result; singletons are kept', () => {
    expect(rrfFuse([['a'], ['b']]).map(r => r.id)).toEqual(['a', 'b'])
    expect(rrfFuse([['b'], ['a']]).map(r => r.id)).toEqual(['a', 'b']) // swapping the two lists is identical
    expect(rrfFuse([['solo']]).map(r => r.id)).toEqual(['solo'])
    expect(rrfFuse([])).toEqual([])
  })
})
