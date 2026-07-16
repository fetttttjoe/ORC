import { describe, expect, it } from 'bun:test'
import { Plan, validatePlan, type PlanStep } from './plan'

const step = (id: string, dependsOn: string[] = []): PlanStep => ({
  id, role: 'worker', title: id, instructions: 'do the thing',
  executorRef: 'api-loop', modelRef: 'anthropic/claude-sonnet-5',
  skillRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn,
})

const plan = (steps: PlanStep[]) =>
  Plan.parse({ taskId: 't1', version: 1, strategyRef: 'template:single', costEstimateUSD: null, steps })

describe('validatePlan', () => {
  it('accepts a valid DAG', () => {
    expect(validatePlan(plan([step('a'), step('b', ['a'])]))).toEqual({ ok: true })
  })
  it('rejects duplicate step ids', () => {
    const r = validatePlan(plan([step('a'), step('a')]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('duplicate')
  })
  it('rejects unknown dependencies', () => {
    const r = validatePlan(plan([step('a', ['ghost'])]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('unknown')
  })
  it('rejects cycles', () => {
    const r = validatePlan(plan([step('a', ['b']), step('b', ['a'])]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('cycle')
  })
  it('rejects an empty plan at parse time', () => {
    expect(() => plan([])).toThrow()
  })
})
