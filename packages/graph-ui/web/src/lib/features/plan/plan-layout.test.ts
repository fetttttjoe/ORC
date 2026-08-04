import { describe, expect, it } from 'bun:test'
import { planLayout } from './plan-layout'

const rankOf = (out: ReturnType<typeof planLayout>, id: string): number | undefined =>
  out.steps.find(s => s.id === id)?.rank

describe('planLayout (columns are the wave the executor would run)', () => {
  it('ranks a chain one column per hop', () => {
    const out = planLayout([
      { id: 'analyze', dependsOn: [] },
      { id: 'plan', dependsOn: ['analyze'] },
      { id: 'verify', dependsOn: ['plan'] },
    ])
    expect([rankOf(out, 'analyze'), rankOf(out, 'plan'), rankOf(out, 'verify')]).toEqual([0, 1, 2])
  })

  it('puts steps that can run together in ONE column — that column is the wave', () => {
    const out = planLayout([
      { id: 'root', dependsOn: [] },
      { id: 'a', dependsOn: ['root'] },
      { id: 'b', dependsOn: ['root'] },
    ])
    expect(rankOf(out, 'a')).toBe(1)
    expect(rankOf(out, 'b')).toBe(1)
    expect(out.steps.filter(s => s.rank === 1).map(s => s.lane)).toEqual([0, 1])
  })

  /**
   * The reason rank is a LONGEST path. `late` waits on both `root` (rank 0) and `mid` (rank 1);
   * shortest-path ranking would draw it at 1, i.e. beside a step it actually waits for, so the
   * picture would contradict the wave board about what gates what.
   */
  it('draws a step to the right of its LATEST dependency, not its earliest', () => {
    const out = planLayout([
      { id: 'root', dependsOn: [] },
      { id: 'mid', dependsOn: ['root'] },
      { id: 'late', dependsOn: ['root', 'mid'] },
    ])
    expect(rankOf(out, 'late')).toBe(2)
  })

  it('is not blocked by a dependency that is not a step of this plan', () => {
    const out = planLayout([{ id: 'only', dependsOn: ['a-step-from-another-plan'] }])
    expect(rankOf(out, 'only')).toBe(0)
    expect(out.edges).toEqual([]) // and it draws no edge into thin air
  })

  it('parks a cycle in a trailing column instead of dropping it — an undrawable plan is worse', () => {
    const out = planLayout([
      { id: 'ok', dependsOn: [] },
      { id: 'x', dependsOn: ['y'] },
      { id: 'y', dependsOn: ['x'] },
    ])
    expect(out.steps.map(s => s.id).sort()).toEqual(['ok', 'x', 'y'])
    expect(rankOf(out, 'x')).toBe(1)
    expect(rankOf(out, 'y')).toBe(1)
  })

  it('lanes follow declaration order, so the same plan always draws the same way', () => {
    const out = planLayout([
      { id: 'b', dependsOn: [] },
      { id: 'a', dependsOn: [] },
    ])
    expect(out.steps.map(s => [s.id, s.lane])).toEqual([['b', 0], ['a', 1]])
  })

  it('emits one edge per in-plan dependency, pointing dependency → dependent', () => {
    const out = planLayout([
      { id: 'build', dependsOn: [] },
      { id: 'verify', dependsOn: ['build'] },
    ])
    expect(out.edges).toEqual([{ from: 'build', to: 'verify' }])
  })

  it('handles an empty plan without inventing a column', () => {
    expect(planLayout([])).toEqual({ steps: [], edges: [], cyclic: new Set() })
  })

  it('names the steps it could not order, so a caller can say so instead of drawing a silent lie', () => {
    const out = planLayout([
      { id: 'ok', dependsOn: [] },
      { id: 'x', dependsOn: ['y'] },
      { id: 'y', dependsOn: ['x'] },
    ])
    expect([...out.cyclic].sort()).toEqual(['x', 'y'])
  })
})
