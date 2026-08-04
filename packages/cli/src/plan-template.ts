// The authored single-step plan template — a LEAF (contracts only), because both sides of the
// composition need it: actions/main build operator-proposed templates, and runtime's auto-heal
// reactor drafts the sweep plan. It lived in actions.ts until the reactor needed it too, and
// actions already imports runtime — reaching back would have been a cycle.
import { ISOLATION_TIER, STEP_ROLE, STRATEGY, type PlanDraft } from '@orc/contracts'
import { DEFAULT_MAX_ITERATIONS } from '@orc/kernel'

// ONE spelling of the template's default model — it was the same literal in two commander
// `--model` defaults, one edit away from proposing with different models per door.
export const DEFAULT_TEMPLATE_MODEL = 'anthropic/claude-sonnet-5'

export function singleStepDraft(task: { title: string; spec: string }, modelRef: string, skillRefs: string[] = [], maxIterations = DEFAULT_MAX_ITERATIONS): PlanDraft {
  return {
    strategyRef: STRATEGY.single,
    costEstimateUSD: null,
    steps: [{
      id: 's1',
      role: STEP_ROLE.worker,
      title: task.title,
      instructions: task.spec === '' ? task.title : task.spec,
      executorRef: 'api-loop',
      modelRef,
      skillRefs,
      toolRefs: [],
      isolation: ISOLATION_TIER.local, // the only implemented tier — worktree/docker come with sandbox plugins
      zone: [],
      maxIterations,
      dependsOn: [],
    }],
  }
}
