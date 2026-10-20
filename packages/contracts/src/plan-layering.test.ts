import { describe, expect, it } from 'bun:test'
import { layerSteps, stepRanks, type LayerableStep } from './plan-layering'

const chain: LayerableStep[] = [
  { id: 'a', dependsOn: [] },
  { id: 'b', dependsOn: ['a'] },
  { id: 'c', dependsOn: ['b'] },
]

describe('stepRanks', () => {
  it('ranks a chain one column per hop', () => {
    const { rank } = stepRanks(chain)
    expect([rank.get('a'), rank.get('b'), rank.get('c')]).toEqual([0, 1, 2])
  })

  it('shares a rank between steps that can run together — that rank IS the wave', () => {
    const { rank } = stepRanks([
      { id: 'root', dependsOn: [] },
      { id: 'x', dependsOn: ['root'] },
      { id: 'y', dependsOn: ['root'] },
    ])
    expect(rank.get('x')).toBe(rank.get('y'))
  })

  it('ranks past the LATEST dependency, not the earliest', () => {
    const { rank } = stepRanks([
      { id: 'root', dependsOn: [] },
      { id: 'mid', dependsOn: ['root'] },
      { id: 'late', dependsOn: ['root', 'mid'] },
    ])
    expect(rank.get('late')).toBe(2)
  })

  it('is not blocked by a dependency outside this plan — the freeze heals those', () => {
    const { rank, cyclic } = stepRanks([{ id: 'only', dependsOn: ['from-another-plan'] }])
    expect(rank.get('only')).toBe(0)
    expect(cyclic.size).toBe(0)
  })

  it('parks a cycle in a trailing rank and names it, rather than dropping the steps', () => {
    const { rank, cyclic } = stepRanks([
      { id: 'ok', dependsOn: [] },
      { id: 'x', dependsOn: ['y'] },
      { id: 'y', dependsOn: ['x'] },
    ])
    expect(rank.get('ok')).toBe(0)
    expect(rank.get('x')).toBe(1)
    expect(rank.get('y')).toBe(1)
    expect([...cyclic].sort()).toEqual(['x', 'y'])
  })

  it('terminates on a plan that is ENTIRELY a cycle', () => {
    const { rank, cyclic } = stepRanks([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }])
    expect(rank.get('x')).toBe(0)
    expect(cyclic.size).toBe(2)
  })

  it('ranks nothing for an empty plan', () => {
    expect(stepRanks([]).rank.size).toBe(0)
  })
})

describe('layerSteps', () => {
  it('numbers waves from 1, because every surface labels the first one "wave 1"', () => {
    expect(layerSteps(chain).layers.map(l => l.wave)).toEqual([1, 2, 3])
  })

  it('flags a wave holding more than one step as parallel', () => {
    const { layers } = layerSteps([
      { id: 'root', dependsOn: [] },
      { id: 'x', dependsOn: ['root'] },
      { id: 'y', dependsOn: ['root'] },
    ])
    expect(layers.map(l => l.parallel)).toEqual([false, true])
  })

  it('keeps declaration order inside a wave, so one plan always renders the same way', () => {
    const { layers } = layerSteps([
      { id: 'b', dependsOn: [] },
      { id: 'a', dependsOn: [] },
    ])
    expect(layers[0]?.steps.map(s => s.id)).toEqual(['b', 'a'])
  })

  it('numbers waves consecutively even when a parked cycle leaves a rank gap', () => {
    const { layers } = layerSteps([
      { id: 'a', dependsOn: [] },
      { id: 'x', dependsOn: ['y'] },
      { id: 'y', dependsOn: ['x'] },
    ])
    expect(layers.map(l => l.wave)).toEqual([1, 2])
  })
})
