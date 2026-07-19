import { ISOLATION_TIER, type Analyzer, type PlanStep } from '@orc/contracts'

export function agentAnalyzer(): Analyzer {
  return {
    id: 'agent-analyzer',
    // Amendment A: the analyze phase is a normal scout step running the codebase-analysis skill.
    // ast-analyzer (deferred) returns a different step (or structural routine) behind this seam.
    analysisStep: ({ modelRef }): PlanStep => ({
      id: 'analyze', role: 'scout', title: 'Analyze the codebase',
      instructions: 'Ground the plan per the codebase-analysis skill.',
      executorRef: 'api-loop', modelRef, skillRefs: ['codebase-analysis'], toolRefs: [],
      isolation: ISOLATION_TIER.local, zone: [], maxIterations: 15, dependsOn: [],
    }),
  }
}
