import { describe, expect, it } from 'bun:test'
import { rankNeighbors, DEFAULT_LINK_WEIGHTS } from './rank'

const edges = [
  { from: 'a', to: 'b', kind: 'supersedes' as const }, // weight 1.0, depth 1 → 1.0
  { from: 'a', to: 'c', kind: 'relates_to' as const }, // weight 0.5, depth 1 → 0.5
  { from: 'b', to: 'd', kind: 'refines' as const },    // 1.0 × 0.9 × 0.6^1 = 0.54 — strong chain beats weak direct edge
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

  it('prunes below the floor', () => {
    expect(rankNeighbors(edges, ['a'], { depth: 3, floor: 0.6 }).map(n => n.id)).toEqual(['b'])
  })

  it('filters by kind, caps result count, and down-weights by confidence', () => {
    expect(rankNeighbors(edges, ['a'], { kinds: ['supersedes'] }).map(n => n.id)).toEqual(['b'])
    expect(rankNeighbors(edges, ['a'], { cap: 1 })).toHaveLength(1)
    const low = rankNeighbors([{ from: 'a', to: 'b', kind: 'supersedes', confidence: 0.1 }], ['a'])
    expect(low[0].score).toBeCloseTo(0.1) // 1.0 weight × 0.1 confidence, no decay at depth 1
    expect(DEFAULT_LINK_WEIGHTS.relates_to).toBe(0.5)
  })
})
