import { STEP_ID, STEP_ROLE, IsolationTier, type Analyzer, type PlanStep } from '@orc/contracts'

export function agentAnalyzer(): Analyzer {
  return {
    id: 'agent-analyzer',
    // analyze is a scout step running the codebase-analysis skill; another analyzer swaps in here
    analysisStep: ({ modelRef }): PlanStep => ({
      id: STEP_ID.analyze, role: STEP_ROLE.scout, title: 'Analyze the codebase',
      instructions: 'Ground the plan per the codebase-analysis skill.',
      executorRef: 'api-loop', modelRef, skillRefs: ['codebase-analysis'], toolRefs: [],
      isolation: IsolationTier.local, zone: [], maxIterations: 30, dependsOn: [],
    }),
  }
}
