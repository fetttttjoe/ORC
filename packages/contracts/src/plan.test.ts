import { describe, expect, it } from 'bun:test'
import { Plan, PlanStep, validatePlan } from './plan'
import { planFixture, stepFixture } from './fixtures'

const step = (id: string, dependsOn: string[] = []): PlanStep => stepFixture({ id, title: id, dependsOn })

const plan = (steps: PlanStep[]) => Plan.parse(planFixture({ steps }))

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
  it('rejects path-unsafe step ids', () => {
    expect(() => plan([step('../x')])).toThrow()
  })

  it('toolRefs defaults to [] and validates ref shape', () => {
    const s = PlanStep.parse({
      id: 's1', role: 'r', title: 't', instructions: 'i', executorRef: 'api-loop',
      modelRef: 'fake/m', skillRefs: [], isolation: 'local', zone: [],
      maxIterations: 1, dependsOn: [],
    })
    expect(s.toolRefs).toEqual([])
    expect(() => PlanStep.parse({ ...s, toolRefs: ['files/read_file'] })).not.toThrow()
    expect(() => PlanStep.parse({ ...s, toolRefs: ['noslash'] })).toThrow()
  })
})
