import { CHECKS_EXECUTOR_REF, CHECKS_STEP_ID, FINISH_STEP_ID, IsolationTier, ROLE_SKILL, STEP_ROLE, STRATEGY, type ChildPlanDraft, type PlanDraft, type PlanStep } from '@orc/contracts'

// pure: no event fold, hashing or store; the strategies file imports this, never the reverse

// one spelling for both appenders; dependsOn every sibling so nothing is in flight behind it
export function finishStepFields(dependsOn: string[]) {
  return {
    id: FINISH_STEP_ID, role: STEP_ROLE.finisher, title: 'Finish',
    instructions: `Reconcile the claims this task recorded, record its decision if it made one, and present the summary; the '${ROLE_SKILL.finisher}' skill is your contract.`,
    dependsOn, skillRefs: [ROLE_SKILL.finisher], toolRefs: [], zone: [],
    // it reads what the task produced and writes only knowledge — no source edits after verify
    readOnlySource: true,
  }
}

export function checksStepFields(dependsOn: string[], checks: readonly string[]) {
  return {
    id: CHECKS_STEP_ID, role: STEP_ROLE.worker, title: 'Checks',
    instructions: JSON.stringify(checks),
    dependsOn, skillRefs: [], toolRefs: [], zone: [],
    readOnlySource: true,
  }
}

export const kernelStepExecutorRef = (stepId: string, inherited: string): string =>
  stepId === CHECKS_STEP_ID ? CHECKS_EXECUTOR_REF : inherited

export interface FinishStepOptions { checks: readonly string[] }

function assertNoKernelStepId(draft: { steps: { id: string }[] }): void {
  for (const id of [CHECKS_STEP_ID, FINISH_STEP_ID])
    if (draft.steps.some(s => s.id === id))
      throw new Error(`the plan already carries a step named '${id}' — that id belongs to a kernel-appended step; rename it`)
}

// appended to every frozen pipeline, autoCommit or not
export function withFinishStep(draft: ChildPlanDraft, opts: FinishStepOptions): ChildPlanDraft {
  assertNoKernelStepId(draft)
  const steps = [...draft.steps]
  if (opts.checks.length > 0) steps.push(checksStepFields(steps.map(s => s.id), opts.checks))
  return { steps: [...steps, finishStepFields(steps.map(s => s.id))] }
}

// no finish step on root plans of groundedPlan (its child gets one at the freeze) and sweep
export const FINISH_EXEMPT_STRATEGIES: readonly string[] = [STRATEGY.groundedPlan, STRATEGY.sweep]

// a split child (parentId !== null) is excluded: its finish is the parent's job
export function plansGetFinishStep(task: { parentId: string | null }, draft: { strategyRef: string }): boolean {
  return task.parentId === null && !FINISH_EXEMPT_STRATEGIES.includes(draft.strategyRef)
}

// strips only the LAST step matching id AND role: a planner's step named finish is left alone
const isKernelFinish = (s: PlanStep | undefined): boolean => s?.id === FINISH_STEP_ID && s.role === STEP_ROLE.finisher
const isKernelChecks = (s: PlanStep | undefined): boolean => s?.id === CHECKS_STEP_ID && s.executorRef === CHECKS_EXECUTOR_REF

// kernel-owned: a hand-edited finish modelRef or instructions are re-derived on the next edit
export function withoutKernelFinishStep(draft: PlanDraft): PlanDraft {
  const withoutFinish = isKernelFinish(draft.steps.at(-1)) ? draft.steps.slice(0, -1) : draft.steps
  const steps = isKernelChecks(withoutFinish.at(-1)) ? withoutFinish.slice(0, -1) : withoutFinish
  return steps === draft.steps ? draft : { ...draft, steps }
}

// idempotent; exempt and child drafts pass through, keeping a deleted or faked finish step
export function reconcileFinishStep(task: { parentId: string | null }, draft: PlanDraft, opts: FinishStepOptions): PlanDraft {
  if (!plansGetFinishStep(task, draft)) return draft
  return withFinishStepFull(withoutKernelFinishStep(draft), opts)
}

// inherits executorRef, modelRef and maxIterations from the LAST step, as proposeSplit does
export function withFinishStepFull(draft: PlanDraft, opts: FinishStepOptions): PlanDraft {
  assertNoKernelStepId(draft)
  const last = draft.steps.at(-1)
  // a step-less draft is refused: a finish-only pipeline reports done having done nothing
  if (last === undefined) throw new Error('a plan needs at least one step before the finish step can follow it')
  // never the last step's isolation: a worktree or docker tier would act on an unseen tree
  const inherited = { modelRef: last.modelRef, maxIterations: last.maxIterations, isolation: IsolationTier.local }
  const steps = [...draft.steps]
  if (opts.checks.length > 0)
    steps.push({ ...checksStepFields(steps.map(s => s.id), opts.checks), executorRef: CHECKS_EXECUTOR_REF, ...inherited })
  return {
    ...draft,
    steps: [...steps, {
      ...finishStepFields(steps.map(s => s.id)),
      executorRef: last.executorRef, ...inherited,
    }],
  }
}
