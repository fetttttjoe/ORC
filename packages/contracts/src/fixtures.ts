// Shared test fixtures (import via '@orc/contracts/fixtures') — the single place a
// PlanStep/Plan/EventRecord shape change has to touch across every package's tests.
import type { EventRecord } from './events'
import { STRATEGY, type Plan, type PlanDraft, type PlanStep } from './plan'

export function eventFixture(over: Partial<EventRecord> = {}): EventRecord {
  return {
    seq: 1, projectId: 'p1', idempotencyKey: null,
    taskId: 't1', stepId: null, runToken: null,
    kind: 'task_created', payload: {}, usage: null, ts: '2026-07-18T00:00:00.000Z',
    ...over,
  }
}

export function stepFixture(over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 's1', role: 'worker', title: 's1', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], toolRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
    ...over,
  }
}

export function draftFixture(steps: PlanStep[] = [stepFixture()]): PlanDraft {
  return { strategyRef: STRATEGY.single, costEstimateUSD: null, steps }
}

export function planFixture(over: Partial<Plan> = {}): Plan {
  return { taskId: 't1', version: 1, ...draftFixture(), ...over }
}
