// a leaf (contracts only): the actions layer and runtime's auto-heal reactor both need it
import { IsolationTier, STEP_ROLE, STRATEGY, type PlanDraft } from '@orc/contracts'
import { DEFAULT_MAX_ITERATIONS } from '@orc/kernel'

export const DEFAULT_TEMPLATE_MODEL = 'anthropic/claude-sonnet-5'

// strategyRef is a parameter: the auto-heal sweep must be exempt from the appended finish step
export function singleStepDraft(task: { title: string; spec: string }, modelRef: string, skillRefs: string[] = [], maxIterations = DEFAULT_MAX_ITERATIONS, strategyRef: string = STRATEGY.single, role: string = STEP_ROLE.worker): PlanDraft {
  return {
    strategyRef,
    costEstimateUSD: null,
    steps: [{
      id: 's1',
      role,
      title: task.title,
      instructions: task.spec === '' ? task.title : task.spec,
      executorRef: 'api-loop',
      modelRef,
      skillRefs,
      toolRefs: [],
      isolation: IsolationTier.local, // the only implemented tier — worktree/docker come with sandbox plugins
      zone: [],
      maxIterations,
      dependsOn: [],
    }],
  }
}
