import { describe, expect, it } from 'bun:test'
import type { Plan, PlanStep } from '@orc/contracts'
import { planFixture, stepFixture } from '@orc/contracts/fixtures'
import { readySteps, runOutcomeOf } from './interpreter'

const step = (id: string, dependsOn: string[] = []): PlanStep => stepFixture({ id, title: id, dependsOn })
const plan = (steps: PlanStep[]): Plan => planFixture({ steps })

const ids = (steps: PlanStep[]) => steps.map(s => s.id)

describe('readySteps (diamond: a → b,c → d)', () => {
  const diamond = plan([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])])

  it('only roots are ready initially', () => {
    expect(ids(readySteps(diamond, new Set(), new Set(), new Set()))).toEqual(['a'])
  })
  it('parallel middle wave', () => {
    expect(ids(readySteps(diamond, new Set(['a']), new Set(), new Set(['a'])))).toEqual(['b', 'c'])
  })
  it('join waits for both parents', () => {
    expect(ids(readySteps(diamond, new Set(['a', 'b']), new Set(), new Set(['a', 'b', 'c'])))).toEqual([])
  })
  it('failure blocks downstream, independent branch continues', () => {
    // b failed → d never ready; c still runs
    expect(ids(readySteps(diamond, new Set(['a']), new Set(['b']), new Set(['a', 'b'])))).toEqual(['c'])
  })
  it('already-started steps are not re-issued', () => {
    expect(ids(readySteps(diamond, new Set(['a']), new Set(), new Set(['a', 'b', 'c'])))).toEqual([])
  })
})

describe('runOutcomeOf', () => {
  const p = plan([step('a'), step('b', ['a'])])
  it('done when every step completed', () => {
    expect(runOutcomeOf(p, new Set(['a', 'b']))).toBe('done')
  })
  it('blocked when anything failed or unreachable', () => {
    expect(runOutcomeOf(p, new Set(['a']))).toBe('blocked')
    expect(runOutcomeOf(p, new Set())).toBe('blocked') // b unreachable
  })
})
