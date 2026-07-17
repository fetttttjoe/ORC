// Shared test fixtures (import via '@orc/contracts/fixtures') — the single place a
// PlanStep/Plan shape change has to touch across every package's tests.
import type { Plan, PlanDraft, PlanStep } from './plan'

export function stepFixture(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 's1', role: 'worker', title: 's1', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], toolRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
    ...over,
  }
}

export function draftFixture(steps: PlanStep[] = [stepFixture()]): PlanDraft {
  return { strategyRef: 'template:single', costEstimateUSD: null, steps }
}

export function planFixture(over: Partial<Plan> = {}): Plan {
  return { taskId: 't1', version: 1, ...draftFixture(), ...over }
}
