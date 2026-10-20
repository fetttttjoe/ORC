import { describe, expect, it } from 'bun:test'

import { todoWaves } from './diagram'
import { must } from '@orc/contracts/fixtures'

// diamond: a → (b ∥ c) → d
const diamond = [
  { id: 'a', title: 'start', dependsOn: [] },
  { id: 'b', title: 'left', dependsOn: ['a'] },
  { id: 'c', title: 'right', dependsOn: ['a'] },
  { id: 'd', title: 'join', dependsOn: ['b', 'c'] },
]

describe('todoWaves', () => {
  it('layers a diamond into 3 waves with the middle parallel', () => {
    const states = new Map([['a', { status: 'completed' }], ['b', { status: 'running' }]])
    const waves = todoWaves(diamond, states)
    expect(waves.map(w => w.steps.map(s => s.id))).toEqual([['a'], ['b', 'c'], ['d']])
    expect(waves.map(w => w.parallel)).toEqual([false, true, false])
    expect(must(must(waves[0], 'waves[0]').steps[0], 'waves[0].steps[0]').status).toBe('completed')
    expect(must(must(waves[1], 'waves[1]').steps[1], 'waves[1].steps[1]').status).toBe('pending')
  })
  it('parks a cycle in a trailing wave rather than dropping its steps', () => {
    const waves = todoWaves([{ id: 'x', title: 'x', dependsOn: ['y'] }, { id: 'y', title: 'y', dependsOn: ['x'] }])
    expect(waves.flatMap(w => w.steps.map(s => s.id)).sort()).toEqual(['x', 'y'])
  })

  it('terminates on a cycle instead of looping forever', () => {
    expect(todoWaves([{ id: 'x', title: 'x', dependsOn: ['y'] }, { id: 'y', title: 'y', dependsOn: ['x'] }]).length).toBe(1)
  })
})
