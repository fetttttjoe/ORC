import { describe, expect, it } from 'bun:test'
import { FINISH_STEP_ID, ISOLATION_TIER, ROLE_SKILL, STEP_ROLE, STRATEGY } from '@orc/contracts'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { FINISH_EXEMPT_STRATEGIES, plansGetFinishStep, reconcileFinishStep, withFinishStepFull, withoutKernelFinishStep } from './finish-step'

describe('withFinishStepFull (full-PlanDraft plans)', () => {
  it('appends a full finish step inheriting executor, model and budget from the last step', () => {
    const draft = draftFixture([stepFixture({ id: 's1', modelRef: 'fake/big', maxIterations: 7 })])
    const out = withFinishStepFull(draft)
    expect(out.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
    expect(out.steps[1]).toMatchObject({
      role: STEP_ROLE.finisher, executorRef: 'api-loop', modelRef: 'fake/big', maxIterations: 7,
      isolation: ISOLATION_TIER.local, zone: [], readOnlySource: true, skillRefs: [ROLE_SKILL.finisher], dependsOn: ['s1'],
    })
    expect(out.strategyRef).toBe(STRATEGY.single)
  })

  // the LAST step, not the first: a multi-step operator draft (orc propose --file) may raise the
  // model or the loop budget for its tail, and the finish step reads what that tail produced
  it('waits on every step and inherits from the last one in a multi-step draft', () => {
    const out = withFinishStepFull(draftFixture([
      stepFixture({ id: 'a' }),
      stepFixture({ id: 'b', dependsOn: ['a'], modelRef: 'fake/tail', maxIterations: 3 }),
    ]))
    expect(out.steps.map(s => s.id)).toEqual(['a', 'b', FINISH_STEP_ID])
    expect(out.steps[2]).toMatchObject({ dependsOn: ['a', 'b'], modelRef: 'fake/tail', maxIterations: 3 })
  })

  it('refuses a draft that already names finish', () => {
    expect(() => withFinishStepFull(draftFixture([stepFixture({ id: FINISH_STEP_ID })]))).toThrow(/finish/)
  })

  // a step-less draft has nothing to inherit from and nothing to reconcile: refuse rather than
  // mint a finish-only plan (the blank-plan shape instantiateFrozenPlan refuses at the freeze)
  it('refuses a draft with no steps at all', () => {
    expect(() => withFinishStepFull(draftFixture([]))).toThrow(/at least one step/)
  })
})

describe('plansGetFinishStep (which plans get one)', () => {
  const root = { parentId: null }
  const child = { parentId: 'parent-1' }

  it('pins the whole table: root pipelines yes, the two exempt strategies and every child no', () => {
    expect(plansGetFinishStep(root, { strategyRef: STRATEGY.single })).toBe(true)       // the quick task
    expect(plansGetFinishStep(root, { strategyRef: 'file:kb-build' })).toBe(true)       // orc propose --file
    expect(plansGetFinishStep(root, { strategyRef: STRATEGY.groundedPlan })).toBe(false) // the [analyze, plan] scaffold
    expect(plansGetFinishStep(root, { strategyRef: STRATEGY.sweep })).toBe(false)        // machine-drafted maintenance
    expect(plansGetFinishStep(child, { strategyRef: STRATEGY.single })).toBe(false)      // a child's finish is its parent's job
    expect(plansGetFinishStep(child, { strategyRef: STRATEGY.split })).toBe(false)
  })

  // an exact set, not a membership check: a third member would silently stop asking the human on a
  // whole class of tasks, which is the one failure nothing else in the system reports
  it('FINISH_EXEMPT_STRATEGIES is exactly the grounded bootstrap and the sweep', () => {
    expect([...FINISH_EXEMPT_STRATEGIES]).toEqual([STRATEGY.groundedPlan, STRATEGY.sweep])
  })
})

describe('withoutKernelFinishStep', () => {
  const kernelFinish = () => withFinishStepFull(draftFixture([stepFixture({ id: 's1' })]))

  it('strips the trailing kernel-shaped step — both terms, id AND role', () => {
    expect(withoutKernelFinishStep(kernelFinish()).steps.map(s => s.id)).toEqual(['s1'])
  })

  it('leaves a draft that never had one byte-identical', () => {
    const plain = draftFixture([stepFixture({ id: 's1' })])
    expect(withoutKernelFinishStep(plain)).toEqual(plain)
  })

  // the planner-fake case: a step that merely NAMES itself finish is not the kernel's, so it
  // survives the strip and the appender's guard then refuses the whole draft
  it('leaves a step named finish under another role in place', () => {
    const faked = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.worker, dependsOn: ['s1'] })])
    expect(withoutKernelFinishStep(faked).steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
  })

  // TRAILING only: a kernel-shaped step in the middle is not what the kernel appended, and dropping
  // it would silently rewrite a plan the human is looking at
  it('leaves a kernel-shaped step that is not last', () => {
    const middle = draftFixture([stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.finisher }), stepFixture({ id: 's2' })])
    expect(withoutKernelFinishStep(middle).steps.map(s => s.id)).toEqual([FINISH_STEP_ID, 's2'])
  })
})

describe('reconcileFinishStep (the ONE rule both plan doors apply)', () => {
  const root = { parentId: null }

  it('appends to a root pipeline that lacks the step', () => {
    const out = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]))
    expect(out.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
  })

  // the edit door's whole reason: a human edits the RENDERED plan, which already ends with the
  // kernel's step — re-appending onto it would either throw or double it
  it('is idempotent on the rendered plan: exactly one finish step, still last', () => {
    const rendered = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]))
    const again = reconcileFinishStep(root, rendered)
    expect(again.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
    expect(again).toEqual(rendered)
  })

  it('re-derives the step after an edit that appended a new last step', () => {
    const rendered = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]))
    const edited = { ...rendered, steps: [must(rendered.steps[0], 'first step in rendered'), stepFixture({ id: 's2', modelRef: 'fake/tail' }), must(rendered.steps[1], 'second step in rendered')] }
    const out = reconcileFinishStep(root, edited)
    expect(out.steps.map(s => s.id)).toEqual(['s1', 's2', FINISH_STEP_ID])
    expect(out.steps[2]).toMatchObject({ dependsOn: ['s1', 's2'], modelRef: 'fake/tail' })
  })

  // A frozen child plan ALREADY ends with the kernel's finish step (freezePlan appends it), and an
  // exempt plan never had one. Passing the draft through untouched is what keeps an edit of either
  // from stripping a step nothing would put back.
  it('passes an exempt or child draft through untouched, finish step and all', () => {
    const frozenChild = reconcileFinishStep(root, draftFixture([stepFixture({ id: 'db' })]))
    expect(reconcileFinishStep({ parentId: 'parent-1' }, frozenChild)).toEqual(frozenChild)
    const sweep = { ...draftFixture([stepFixture({ id: 's1' })]), strategyRef: STRATEGY.sweep }
    expect(reconcileFinishStep(root, sweep)).toEqual(sweep)
  })

  it('refuses a draft carrying a step named finish under another role', () => {
    const faked = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.worker, dependsOn: ['s1'] })])
    expect(() => reconcileFinishStep(root, faked)).toThrow(/finish/)
  })
})
