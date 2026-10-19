import { describe, expect, it } from 'bun:test'
import { ChildPlanStep, Plan, PlanStep, ROLE_SKILL, STEP_ROLE, stepMayPlan, stepMayReconcile, stepMayVerify, validatePlan } from './plan'
import { FINISH_STEP_ID, STEP_ID } from './step-ids'
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

  // Pin: validatePlan's zone sweep now routes through planFieldViolations (the shared rule table
  // in plan-rules.ts) instead of calling zoneEntryMisuse directly. The wording is unchanged, so this
  // is a message-parity pin, not a new-behavior test — it passes against the pre-sweep code too.
  it('a malformed zone entry is refused with the step id and the pinned wording', () => {
    const r = check([step('x', { zone: ['a/**\nb.ts'] })])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const joined = r.errors.join(' ')
      expect(joined).toContain("step 'x':")
      expect(joined).toContain('one glob per array entry')
    }
  })
})

describe('the finish step predicate', () => {
  it('arms only the kernel-appended finish step with the finisher role — both terms, like the commit gate', () => {
    expect(stepMayReconcile({ stepId: FINISH_STEP_ID, role: STEP_ROLE.finisher })).toBe(true)
    expect(stepMayReconcile({ stepId: FINISH_STEP_ID, role: STEP_ROLE.worker })).toBe(false)   // a planner step named finish
    expect(stepMayReconcile({ stepId: 'wrap-up', role: STEP_ROLE.finisher })).toBe(false)     // role claimed elsewhere
    // the two predicates never overlap: an auditor verify step is not a finish step and vice versa
    expect(stepMayVerify({ stepId: FINISH_STEP_ID, role: STEP_ROLE.finisher })).toBe(false)
  })
  it('stepMayPlan: the plan step run as auditor, and nothing else', () => {
    expect(stepMayPlan({ stepId: STEP_ID.plan, role: STEP_ROLE.auditor })).toBe(true)
    expect(stepMayPlan({ stepId: STEP_ID.plan, role: STEP_ROLE.worker })).toBe(false)
    expect(stepMayPlan({ stepId: STEP_ID.verify, role: STEP_ROLE.auditor })).toBe(false)
  })
  it('names the skill the freeze appends', () => {
    expect(ROLE_SKILL.finisher).toBe('role-finisher')
    expect(STEP_ID.finish).toBe('finish')
  })
})
