// The authored single-step plan template — a LEAF (contracts only), because both sides of the
// composition need it: actions/main build operator-proposed templates, and runtime's auto-heal
// reactor drafts the sweep plan. It lived in actions.ts until the reactor needed it too, and
// actions already imports runtime — reaching back would have been a cycle.
import { IsolationTier, STEP_ROLE, STRATEGY, type PlanDraft } from '@orc/contracts'
import { DEFAULT_MAX_ITERATIONS } from '@orc/kernel'

// ONE spelling of the template's default model — it was the same literal in two commander
// `--model` defaults, one edit away from proposing with different models per door.
export const DEFAULT_TEMPLATE_MODEL = 'anthropic/claude-sonnet-5'

// `strategyRef` is a PARAMETER with the operator's own template as its default: the auto-heal
// reactor drafts the same one-step shape but must be exempt from the kernel's appended finish step
// (FINISH_EXEMPT_STRATEGIES) — a plan nobody requested must not park on a human — and the strategy
// is the only thing in this draft that can say so.
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
