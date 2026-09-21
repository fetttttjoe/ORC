import { RunOutcome, type Plan, type PlanStep } from '@orc/contracts'

export function readySteps(
  plan: Plan,
  done: Set<string>,
  failed: Set<string>,
  started: Set<string>,
): PlanStep[] {
  return plan.steps.filter(
    s =>
      !done.has(s.id) &&
      !failed.has(s.id) &&
      !started.has(s.id) &&
      s.dependsOn.every(d => done.has(d)),
  )
}

export function runOutcomeOf(plan: Plan, done: Set<string>): RunOutcome {
  return plan.steps.every(s => done.has(s.id)) ? RunOutcome.done : RunOutcome.blocked
}
