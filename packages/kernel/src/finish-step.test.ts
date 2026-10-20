import { describe, expect, it } from 'bun:test'
import { CHECKS_EXECUTOR_REF, CHECKS_STEP_ID, ChildPlanDraft, FINISH_STEP_ID, IsolationTier, ROLE_SKILL, STEP_ROLE, STRATEGY } from '@orc/contracts'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { FINISH_EXEMPT_STRATEGIES, kernelStepExecutorRef, plansGetFinishStep, reconcileFinishStep, withFinishStepFull, withoutKernelFinishStep } from './finish-step'

const NO_CHECKS = { checks: [] }
const CHECKS = { checks: ['bun test a.test.ts', 'bun run typecheck'] }

describe('withFinishStepFull (full-PlanDraft plans)', () => {
  it('appends a full finish step inheriting executor, model and budget from the last step', () => {
    const draft = draftFixture([stepFixture({ id: 's1', modelRef: 'fake/big', maxIterations: 7 })])
    const out = withFinishStepFull(draft, NO_CHECKS)
    expect(out.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
    expect(out.steps[1]).toMatchObject({
      role: STEP_ROLE.finisher, executorRef: 'api-loop', modelRef: 'fake/big', maxIterations: 7,
      isolation: IsolationTier.local, zone: [], readOnlySource: true, skillRefs: [ROLE_SKILL.finisher], dependsOn: ['s1'],
    })
    expect(out.strategyRef).toBe(STRATEGY.single)
  })

  // the LAST step, not the first: a draft may raise model or budget for its tail
  it('waits on every step and inherits from the last one in a multi-step draft', () => {
    const out = withFinishStepFull(draftFixture([
      stepFixture({ id: 'a' }),
      stepFixture({ id: 'b', dependsOn: ['a'], modelRef: 'fake/tail', maxIterations: 3 }),
    ]), NO_CHECKS)
    expect(out.steps.map(s => s.id)).toEqual(['a', 'b', FINISH_STEP_ID])
    expect(out.steps[2]).toMatchObject({ dependsOn: ['a', 'b'], modelRef: 'fake/tail', maxIterations: 3 })
  })

  it('refuses a draft that already names finish', () => {
    expect(() => withFinishStepFull(draftFixture([stepFixture({ id: FINISH_STEP_ID })]), NO_CHECKS)).toThrow(/finish/)
  })

  it('refuses a draft that already names checks', () => {
    expect(() => withFinishStepFull(draftFixture([stepFixture({ id: CHECKS_STEP_ID })]), NO_CHECKS)).toThrow(/checks/)
  })

  it('refuses a draft with no steps at all', () => {
    expect(() => withFinishStepFull(draftFixture([]), NO_CHECKS)).toThrow(/at least one step/)
  })

  it('only the kernel checks step runs under the checks executor, and a split step cannot ask for it', () => {
    expect(kernelStepExecutorRef(CHECKS_STEP_ID, 'api-loop')).toBe(CHECKS_EXECUTOR_REF)
    expect(kernelStepExecutorRef('s1', 'api-loop')).toBe('api-loop')
    const asked = ChildPlanDraft.parse({ steps: [{ id: 's1', role: STEP_ROLE.worker, title: 't', instructions: 'i', skillRefs: [], dependsOn: [], executorRef: CHECKS_EXECUTOR_REF }] })
    expect(Object.keys(asked.steps[0] ?? {})).not.toContain('executorRef')
  })

  it('appends the checks step before finish, carrying the commands and the inherited refs', () => {
    const out = withFinishStepFull(draftFixture([
      stepFixture({ id: 'a' }),
      stepFixture({ id: 'b', dependsOn: ['a'], modelRef: 'fake/tail', maxIterations: 3 }),
    ]), CHECKS)
    expect(out.steps.map(s => s.id)).toEqual(['a', 'b', CHECKS_STEP_ID, FINISH_STEP_ID])
    expect(out.steps[2]).toMatchObject({
      role: STEP_ROLE.worker, executorRef: CHECKS_EXECUTOR_REF, instructions: JSON.stringify(CHECKS.checks),
      dependsOn: ['a', 'b'], zone: [], readOnlySource: true, skillRefs: [], toolRefs: [],
      modelRef: 'fake/tail', maxIterations: 3, isolation: IsolationTier.local,
    })
    expect(out.steps[3]).toMatchObject({ role: STEP_ROLE.finisher, dependsOn: ['a', 'b', CHECKS_STEP_ID] })
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

  // an exact set: a third member would silently stop asking the human on a class of tasks
  it('FINISH_EXEMPT_STRATEGIES is exactly the grounded bootstrap and the sweep', () => {
    expect([...FINISH_EXEMPT_STRATEGIES]).toEqual([STRATEGY.groundedPlan, STRATEGY.sweep])
  })
})

describe('withoutKernelFinishStep', () => {
  const kernelFinish = () => withFinishStepFull(draftFixture([stepFixture({ id: 's1' })]), NO_CHECKS)

  it('strips the trailing kernel-shaped step — both terms, id AND role', () => {
    expect(withoutKernelFinishStep(kernelFinish()).steps.map(s => s.id)).toEqual(['s1'])
  })

  it('strips the checks step under the finish step', () => {
    const checked = withFinishStepFull(draftFixture([stepFixture({ id: 's1' })]), CHECKS)
    expect(withoutKernelFinishStep(checked).steps.map(s => s.id)).toEqual(['s1'])
  })

  it('leaves a step named checks under another executor in place', () => {
    const faked = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: CHECKS_STEP_ID, dependsOn: ['s1'] })])
    expect(withoutKernelFinishStep(faked).steps.map(s => s.id)).toEqual(['s1', CHECKS_STEP_ID])
  })

  it('leaves a draft that never had one byte-identical', () => {
    const plain = draftFixture([stepFixture({ id: 's1' })])
    expect(withoutKernelFinishStep(plain)).toEqual(plain)
  })

  it('leaves a step named finish under another role in place', () => {
    const faked = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.worker, dependsOn: ['s1'] })])
    expect(withoutKernelFinishStep(faked).steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
  })

  // TRAILING only: dropping a mid-plan kernel-shaped step would rewrite the human's plan
  it('leaves a kernel-shaped step that is not last', () => {
    const middle = draftFixture([stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.finisher }), stepFixture({ id: 's2' })])
    expect(withoutKernelFinishStep(middle).steps.map(s => s.id)).toEqual([FINISH_STEP_ID, 's2'])
  })
})

describe('reconcileFinishStep (the ONE rule both plan doors apply)', () => {
  const root = { parentId: null }

  it('appends to a root pipeline that lacks the step', () => {
    const out = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]), NO_CHECKS)
    expect(out.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
  })

  it('is idempotent with checks configured', () => {
    const rendered = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]), CHECKS)
    expect(rendered.steps.map(s => s.id)).toEqual(['s1', CHECKS_STEP_ID, FINISH_STEP_ID])
    expect(reconcileFinishStep(root, rendered, CHECKS)).toEqual(rendered)
  })

  it('drops the rendered checks step once checks are unconfigured', () => {
    const rendered = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]), CHECKS)
    expect(reconcileFinishStep(root, rendered, NO_CHECKS).steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
  })

  // a human edits the RENDERED plan: re-appending would throw or double the step
  it('is idempotent on the rendered plan: exactly one finish step, still last', () => {
    const rendered = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]), NO_CHECKS)
    const again = reconcileFinishStep(root, rendered, NO_CHECKS)
    expect(again.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
    expect(again).toEqual(rendered)
  })

  it('re-derives the step after an edit that appended a new last step', () => {
    const rendered = reconcileFinishStep(root, draftFixture([stepFixture({ id: 's1' })]), NO_CHECKS)
    const edited = { ...rendered, steps: [must(rendered.steps[0], 'first step in rendered'), stepFixture({ id: 's2', modelRef: 'fake/tail' }), must(rendered.steps[1], 'second step in rendered')] }
    const out = reconcileFinishStep(root, edited, NO_CHECKS)
    expect(out.steps.map(s => s.id)).toEqual(['s1', 's2', FINISH_STEP_ID])
    expect(out.steps[2]).toMatchObject({ dependsOn: ['s1', 's2'], modelRef: 'fake/tail' })
  })

  // a frozen child already ends with the finish step; an exempt plan never had one
  it('passes an exempt or child draft through untouched, finish step and all', () => {
    const frozenChild = reconcileFinishStep(root, draftFixture([stepFixture({ id: 'db' })]), NO_CHECKS)
    expect(reconcileFinishStep({ parentId: 'parent-1' }, frozenChild, NO_CHECKS)).toEqual(frozenChild)
    const sweep = { ...draftFixture([stepFixture({ id: 's1' })]), strategyRef: STRATEGY.sweep }
    expect(reconcileFinishStep(root, sweep, NO_CHECKS)).toEqual(sweep)
  })

  it('refuses a draft carrying a step named finish under another role', () => {
    const faked = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.worker, dependsOn: ['s1'] })])
    expect(() => reconcileFinishStep(root, faked, NO_CHECKS)).toThrow(/finish/)
  })

  it('refuses a draft carrying a planner-authored step named checks', () => {
    const faked = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: CHECKS_STEP_ID, dependsOn: ['s1'] })])
    expect(() => reconcileFinishStep(root, faked, NO_CHECKS)).toThrow(/checks/)
  })
})
