import { CHECKS_EXECUTOR_REF, CHECKS_STEP_ID, FINISH_STEP_ID, ISOLATION_TIER, ROLE_SKILL, STEP_ROLE, STRATEGY, type ChildPlanDraft, type PlanDraft, type PlanStep } from '@orc/contracts'

// The kernel-appended finish step, in ONE file with ONE import (contracts). Everything about "which
// plans end with it, and what it looks like" lives here: the two appenders (frozen pipeline and
// full draft), the strip, the predicate. Deliberately imports no capability — no event fold, no
// hashing, no store — so the rule can be read and tested without any of them, and the strategies
// file (which folds events and hashes graphs) imports THIS, never the other way round.

// The trailing step's fields, shared by both appenders below — one spelling, so the step a grounded
// pipeline ends with and the step a quick task ends with cannot drift into two different contracts.
// dependsOn EVERY sibling, for withCommitStep's reason: last-by-construction is what makes the
// reconciliation truthful — nothing the step summarizes can still be in flight behind it.
export function finishStepFields(dependsOn: string[]) {
  return {
    id: FINISH_STEP_ID, role: STEP_ROLE.finisher, title: 'Finish',
    instructions: `Reconcile this task's notes, record its decision if it made one, and present the summary; the '${ROLE_SKILL.finisher}' skill is your contract.`,
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

// Appended to EVERY frozen pipeline, autoCommit or not (freezePlan): the finish step is the human's
// one look at what the task did to the knowledge base, and when the commit step follows it the
// stamp pass sees reconciled notes rather than the mid-run ones.
export function withFinishStep(draft: ChildPlanDraft, opts: FinishStepOptions): ChildPlanDraft {
  assertNoKernelStepId(draft)
  const steps = [...draft.steps]
  if (opts.checks.length > 0) steps.push(checksStepFields(steps.map(s => s.id), opts.checks))
  return { steps: [...steps, finishStepFields(steps.map(s => s.id))] }
}

// The strategies whose ROOT plans do NOT end with a finish step, each for its own reason:
//   * groundedPlan — the [analyze, plan] scaffold is not a pipeline. Its frozen child IS one, and
//     gets the step at the freeze (freezePlan); a finish step here would ask the human to summarize
//     a task that has not run yet, one screen above the plan-approval gate.
//   * sweep — the auto-heal reactor's machine-drafted maintenance (cli/auto-heal.ts). Nobody
//     requested it, so there is nobody waiting on its summary: a finish step would park a
//     self-drafted task on a human indefinitely.
// Everything else that is a root plan gets one — the quick task and an operator's --file draft
// alike (measured: docs/kb-build-parallel.plan.json carries strategyRef 'file:kb-build-parallel',
// so keying on STRATEGY.single alone would have missed it).
export const FINISH_EXEMPT_STRATEGIES: readonly string[] = [STRATEGY.groundedPlan, STRATEGY.sweep]

// The ONE answer to "does this plan end with the kernel's finish step?", asked by both plan doors
// (proposePlan and editPlan) so a proposed plan and its edit can never disagree. Structural inputs,
// no kernel types: this file stays a pure algorithm.
// A SPLIT child (parentId !== null) is excluded by identity: a child's finish is its parent's job,
// or the human is asked once per child.
export function plansGetFinishStep(task: { parentId: string | null }, draft: { strategyRef: string }): boolean {
  return task.parentId === null && !FINISH_EXEMPT_STRATEGIES.includes(draft.strategyRef)
}

// Drops the step this module appended, and only that one: the LAST step, matching on BOTH terms
// (id and role) the way stepMayReconcile gates on both. A human edits the RENDERED plan, which
// already carries the appended step, so an edit door that only appended would either throw on its
// own output or double the step.
// A step merely NAMED finish under another role is left in place on purpose — it is a planner's,
// not the kernel's, and withFinishStepFull's guard then refuses the whole draft rather than
// quietly deleting a step the human is looking at. Same reason the match is TRAILING-only.
// Consequence worth knowing: the step is KERNEL-OWNED, so an operator who hand-edits its modelRef
// or instructions (orc edit --from-vault) gets them re-derived on the next edit without a word.
// Where "re-derived" comes FROM is two places, not one: the shared fields (id, role, title,
// instructions, skillRefs, zone, readOnlySource) come from finishStepFields above, while
// modelRef/executorRef/maxIterations are INHERITED from the plan's last step by withFinishStepFull
// — so editing finishStepFields cannot change which model the step runs on or what it may spend.
// CEILING: the finish step has no budget or model of its own, and a plan whose last step is a
// cheap one-iteration formality hands the reconciliation that same ceiling. The upgrade path is an
// operator setting in the shape memoryConsolidateModel already takes (a `finishModel` model ref,
// empty = inherit), read at the append; nothing needs it yet, so nothing exists.
const isKernelFinish = (s: PlanStep | undefined): boolean => s?.id === FINISH_STEP_ID && s.role === STEP_ROLE.finisher
const isKernelChecks = (s: PlanStep | undefined): boolean => s?.id === CHECKS_STEP_ID && s.executorRef === CHECKS_EXECUTOR_REF

export function withoutKernelFinishStep(draft: PlanDraft): PlanDraft {
  const withoutFinish = isKernelFinish(draft.steps.at(-1)) ? draft.steps.slice(0, -1) : draft.steps
  const steps = isKernelChecks(withoutFinish.at(-1)) ? withoutFinish.slice(0, -1) : withoutFinish
  return steps === draft.steps ? draft : { ...draft, steps }
}

// What both plan doors call. Idempotent by construction (strip, then append), so proposing a
// rendered plan and editing one behave identically.
// An exempt or child draft passes through UNTOUCHED rather than being stripped: a frozen child plan
// already ends with the finish step the freeze appended, and stripping there would delete a step
// nothing would put back.
// That also means a step FAKING the finish id/role rides through on a child or exempt plan. Not a
// hole: the model's door is proposeSplit, which refuses both terms outright (kernel.ts), and this
// path is the operator's own editPlan — a human writing the kernel's step by hand is describing
// what they want, not smuggling one past a gate.
// The same pass-through cuts the other way, also by design: an `orc edit --from-vault` of a FROZEN
// CHILD whose rendered plan the operator has deleted the finish step from is accepted as written —
// nothing re-appends it, because the re-append only runs for plans plansGetFinishStep answers true
// for, and a child is never one. A human removing a step they are looking at is making a decision,
// not making a mistake the kernel should quietly undo.
export function reconcileFinishStep(task: { parentId: string | null }, draft: PlanDraft, opts: FinishStepOptions): PlanDraft {
  if (!plansGetFinishStep(task, draft)) return draft
  return withFinishStepFull(withoutKernelFinishStep(draft), opts)
}

// The full-PlanDraft twin of withFinishStep (the frozen/ChildPlanDraft one). A plan that was never
// frozen — the operator's quick task and an `orc propose --file` draft — carries every ref on every
// step, so the appended step INHERITS executorRef/modelRef/maxIterations from the LAST step: the
// same rule proposeSplit applies when it expands a trimmed child draft (kernel.ts, the `expanded`
// literal), and the last step is the one whose output the finish step reconciles.
//
// Here rather than in the strategies file because that file is about the grounded freeze; this runs
// at proposePlan, for plans that never go through one. The step's fields come from finishStepFields
// so the two appends cannot drift into two different contracts.
export function withFinishStepFull(draft: PlanDraft, opts: FinishStepOptions): PlanDraft {
  assertNoKernelStepId(draft)
  const last = draft.steps.at(-1)
  // A step-less draft has nothing to inherit and nothing to reconcile. Refused rather than appended
  // to, for the reason instantiateFrozenPlan refuses a childless masterplan: a finish-only pipeline
  // reports done having done nothing, and the human is asked to summarize an empty task.
  if (last === undefined) throw new Error('a plan needs at least one step before the finish step can follow it')
  // never the last step's isolation: a worktree/docker tier would reconcile notes about a tree
  // the operator cannot see, and these steps write knowledge, not source
  const inherited = { modelRef: last.modelRef, maxIterations: last.maxIterations, isolation: ISOLATION_TIER.local }
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
