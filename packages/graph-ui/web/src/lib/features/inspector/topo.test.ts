import { describe, expect, it } from 'bun:test'
import { topoOrder } from './topo'

const ids = (steps: { id: string }[]): string[] => steps.map(s => s.id)

describe('topoOrder (dependencies first, declaration order for ties)', () => {
  it('places a dependency before the step that waits on it', () => {
    const out = topoOrder([
      { id: 'verify', dependsOn: ['build'] },
      { id: 'build', dependsOn: [] },
    ])
    expect(ids(out)).toEqual(['build', 'verify'])
  })

  it('keeps declaration order among independent steps', () => {
    expect(ids(topoOrder([{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }, { id: 'c', dependsOn: [] }]))).toEqual(['a', 'b', 'c'])
  })

  it('ignores dependencies on steps that are not in this plan', () => {
    expect(ids(topoOrder([{ id: 'only', dependsOn: ['a-step-from-another-plan'] }]))).toEqual(['only'])
  })

  it('still returns every step when a cycle makes ordering impossible', () => {
    const out = topoOrder([
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'free', dependsOn: [] },
    ])
    expect(ids(out).sort()).toEqual(['a', 'b', 'free'])
    expect(ids(out)[0]).toBe('free') // what CAN be ordered still is
  })
})
