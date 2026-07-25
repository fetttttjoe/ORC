import { describe, expect, it } from 'bun:test'
import { ChildPlanStep, Plan, PlanStep, planScope, validatePlan } from './plan'
import { MEMORY_ID_RE } from './ids'
import { MemoryNoteInput } from './memory'
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
  it('rejects the malformed shape: multi-step, all parallel, no verify', () => {
    const r = validatePlan(plan([step('a'), step('b'), step('c')]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('malformed plan shape')
  })
  it('accepts multi-step when any dependency exists', () => {
    expect(validatePlan(plan([step('a'), step('b', ['a'])]))).toEqual({ ok: true })
  })
  it('accepts all-parallel steps when a verify step exists', () => {
    expect(validatePlan(plan([step('a'), step('b'), step('verify')]))).toEqual({ ok: true })
  })
  it('accepts a single dependency-free step', () => {
    expect(validatePlan(plan([step('only')]))).toEqual({ ok: true })
  })
  it('rejects an empty plan at parse time', () => {
    expect(() => plan([])).toThrow()
  })
  it('rejects path-unsafe step ids', () => {
    expect(() => plan([step('../x')])).toThrow()
  })

  it('ChildPlanStep: zone is the child\u2019s own declaration, defaulting to unfenced', () => {
    const base = { id: 's1', role: 'r', title: 't', instructions: 'i', skillRefs: [], toolRefs: [], dependsOn: [] }
    expect(ChildPlanStep.parse(base).zone).toEqual([])
    expect(ChildPlanStep.parse({ ...base, zone: ['docs/**'] }).zone).toEqual(['docs/**'])
    expect(() => ChildPlanStep.parse({ ...base, zone: [''] })).toThrow() // empty glob is a typo, not a fence
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

describe('planScope', () => {
  // The bug this pins: a split child's task id carries dots, an underscore and mixed case, so the
  // raw `plan-${taskId}` was not a legal scope — every ambient step note and the whole
  // consolidation input for a child task were rejected at the schema boundary, silently.
  const child = 'e07a0095-744a-4dee-a6e5-39a79c2e1689.plan.toolu_01Ajfz33bBkdmSoKah7qnxTH'

  it('always yields a scope the memory schema accepts', () => {
    expect(planScope(child)).toMatch(MEMORY_ID_RE)
    expect(() => MemoryNoteInput.parse({ id: 'step-x', scope: planScope(child), title: 't' })).not.toThrow()
  })

  it('is identity-shaped for a root task id and stays collision-free per task', () => {
    const root = 'e07a0095-744a-4dee-a6e5-39a79c2e1689'
    expect(planScope(root)).toBe(`plan-${root}`)
    expect(planScope(child)).not.toBe(planScope(root))
  })
})
