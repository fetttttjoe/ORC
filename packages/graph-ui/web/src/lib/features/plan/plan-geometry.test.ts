import { describe, expect, it } from 'bun:test'
import { DEFAULT_GEOMETRY, groupIdFor, planGeometry } from './plan-geometry'
import { must } from '@orc/contracts/fixtures'

const spec = { nodeW: 100, nodeH: 20, gapX: 40, gapY: 10, padX: 10, padTop: 20, padBottom: 10 }

describe('planGeometry', () => {
  it('makes one container per rank, laid out left to right on a uniform pitch', () => {
    const g = planGeometry([{ id: 'a', rank: 0, lane: 0 }, { id: 'b', rank: 1, lane: 0 }], spec)
    expect(g.groups.map(x => x.id)).toEqual([groupIdFor(0), groupIdFor(1)])
    expect(g.groups.map(x => x.x)).toEqual([0, 160]) // 100 + 2*10 padding = 120, + 40 gap
  })

  /**
   * Svelte Flow places a node carrying parentId RELATIVE to that parent. Absolute coordinates here
   * stack every child in the container's top-left corner, which reads as a single node.
   */
  it('positions steps relative to their container, never absolutely', () => {
    const g = planGeometry([{ id: 'a', rank: 2, lane: 0 }], spec)
    expect(g.groups[0]?.x).toBe(320)
    expect(g.steps[0]?.x).toBe(spec.padX) // NOT 320 + padX
    expect(g.steps[0]?.groupId).toBe(groupIdFor(2))
  })

  it('stacks the steps of one wave without overlapping them', () => {
    const g = planGeometry([{ id: 'a', rank: 0, lane: 0 }, { id: 'b', rank: 0, lane: 1 }], spec)
    const ys = g.steps.map(s => s.y).sort((p, q) => p - q)
    expect(must(ys[1], 'ys[1]') - must(ys[0], 'ys[0]')).toBe(spec.nodeH + spec.gapY)
  })

  it('gives every container the height of the FULLEST wave, so the row reads as one band', () => {
    const g = planGeometry([
      { id: 'a', rank: 0, lane: 0 },
      { id: 'b', rank: 1, lane: 0 },
      { id: 'c', rank: 1, lane: 1 },
    ], spec)
    expect(new Set(g.groups.map(x => x.height)).size).toBe(1)
  })

  it('centres a short wave inside its container rather than pinning it to the top', () => {
    const g = planGeometry([
      { id: 'a', rank: 0, lane: 0 },
      { id: 'b', rank: 1, lane: 0 },
      { id: 'c', rank: 1, lane: 1 },
    ], spec)
    const lonely = g.steps.find(s => s.id === 'a')
    const firstOfPair = g.steps.find(s => s.id === 'b')
    expect(must(lonely, 'lonely').y).toBeGreaterThan(must(firstOfPair, 'firstOfPair').y)
  })

  it('reports a canvas size that covers every container', () => {
    const g = planGeometry([{ id: 'a', rank: 0, lane: 0 }, { id: 'b', rank: 1, lane: 0 }], spec)
    expect(g.width).toBe(280) // two 120-wide containers + one 40 gap
    expect(g.height).toBe(must(g.groups[0], 'groups[0]').height)
  })

  it('handles an empty plan without inventing a container', () => {
    expect(planGeometry([], spec)).toEqual({ groups: [], steps: [], width: 0, height: 0 })
  })

  it('ships a default spec so a caller need not invent pixel sizes', () => {
    expect(planGeometry([{ id: 'a', rank: 0, lane: 0 }]).steps).toHaveLength(1)
    expect(DEFAULT_GEOMETRY.nodeW).toBeGreaterThan(0)
  })
})
