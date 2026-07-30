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
  // Was: an all-parallel plan was accepted whenever a step named 'verify' existed. That exemption
  // is only reachable when the verify step is itself unordered — which is the defect, reproduced
  // live on 2026-07-26. A verify step earns the plan nothing unless it DEPENDS on the work.
  it('an unordered verify step does not rescue an all-parallel plan', () => {
    const r = validatePlan(plan([step('a'), step('b'), step('verify')]))
    expect(r.ok).toBe(false)
  })
  it('accepts a verify step that depends on the work it checks', () => {
    expect(validatePlan(plan([step('a'), step('b'), step('verify', ['a', 'b'])]))).toEqual({ ok: true })
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

describe('ChildPlanStep.modelRef', () => {
  const base = { id: 's1', role: 'r', title: 't', instructions: 'i', skillRefs: [], dependsOn: [] }

  it('is optional, so an existing subplan still inherits the parent model', () => {
    expect(ChildPlanStep.parse(base).modelRef).toBeUndefined()
  })

  it('carries an explicit override and rejects an empty one', () => {
    expect(ChildPlanStep.parse({ ...base, modelRef: 'anthropic/claude-opus-5' }).modelRef).toBe('anthropic/claude-opus-5')
    expect(() => ChildPlanStep.parse({ ...base, modelRef: '' })).toThrow()
  })
})


// Reproduced live 2026-07-26: a grounded plan froze `draft` and `verify` with no dependency and the
// SAME zone. They ran in one wave, verify audited a file draft had not written yet, and the run
// reported done. The all-parallel guard already existed but exempted any plan containing a step
// named 'verify' — an exemption only reachable when that verify step is itself unordered.
describe('plan shape defects that cause races', () => {
  const step = (id: string, over: Partial<PlanStep> = {}): PlanStep =>
    stepFixture({ id, title: id, instructions: 'x', dependsOn: [], zone: [], ...over })
  const check = (steps: PlanStep[]) => validatePlan({ taskId: 't', version: 1, strategyRef: 'split', costEstimateUSD: null, steps })

  it('an unordered verify step no longer exempts an all-parallel plan', () => {
    const r = check([step('draft'), step('verify')])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/all parallel/)
  })

  it('two concurrent steps writing the same zone are refused', () => {
    const r = check([
      step('draft', { zone: ['docs/page.md'] }),
      step('other', { dependsOn: ['draft'] }),
      step('verify', { zone: ['docs/page.md'] }),
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/docs\/page\.md/)
  })

  it('the same zone is fine once one step depends on the other', () => {
    expect(check([
      step('draft', { zone: ['docs/page.md'] }),
      step('verify', { zone: ['docs/page.md'], dependsOn: ['draft'] }),
    ]).ok).toBe(true)
  })

  // A planner joined several globs with newlines into ONE zone entry (`["a/**\nb.ts"]`). It passed
  // every gate, the frozen fence then matched no real path, and two steps were refused every write
  // to their own files with no repair path — the slice's pipeline was cancelled.
  it('refuses a step whose zone entry is several globs joined into one string', () => {
    const r = check([
      step('draft', { zone: ['packages/a/**\npackages/b.ts'] }),
      step('verify', { dependsOn: ['draft'] }),
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const joined = r.errors.join(' ')
      expect(joined).toContain("step 'draft'")
      expect(joined).toContain('packages/a/**\\npackages/b.ts') // rendered with visible escapes
      expect(joined).toContain('one glob per array entry')
    }
  })

  it('refuses a whitespace-only zone entry, which fences a step out of every file', () => {
    const r = check([step('draft', { zone: ['   '] }), step('verify', { dependsOn: ['draft'] })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('one glob per array entry')
  })
})
