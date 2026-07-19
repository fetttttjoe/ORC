import { randomUUID } from 'node:crypto'
import { ApprovalPolicy, type MemoryNote, type MemoryStore, type ResolvedTool } from '@orc/contracts'
import type { Kernel } from '../kernel'
import { instantiateFrozenPlan, planScope } from './strategies/grounded-plan'

// grounded-plan child policy: the human already approved conversationally (the ask_human loop),
// so the derived split auto-approves — this scaffold is not a second human gate.
const AUTO_APPROVE = ApprovalPolicy.parse({ default: 'auto' })

// finalize_plan (M5b): the plan-authoring agent calls this after the human replies `approve`.
// It reads the task's plan-note graph, deterministically freezes it (instantiateFrozenPlan),
// and drives the SAME task_split path splitTool uses. Mirrors splitTool's factory (kernel +
// step context injected) but sources its draft from the notes, not the model — so the executable
// plan can never drift from what the human approved.
// ponytail: one decomposition level per approve — a subplan that itself decomposes re-splits when
// its child runs; recurse only when a real 3-level plan needs it.
export function finalizePlanTool(opts: {
  store: MemoryStore
  kernel: Pick<Kernel, 'proposeSplit'>
  config: { maxDepth: number }
  p: { taskId: string; stepId: string; runToken: string; executor: string; modelRef: string; maxIterations: number }
}): ResolvedTool {
  const { store, kernel, config, p } = opts
  const scope = planScope(p.taskId)
  return {
    ref: 'kernel/finalize_plan', name: 'finalize_plan',
    description:
      "Freeze the approved plan-note graph into the executable plan and split it off. Call exactly once, after the human replies `approve`. Derives the plan deterministically from the `masterplan` note and its decomposes_into subplans — do NOT hand-build the split; this can never drift from what the human approved.",
    inputSchema: { type: 'object', properties: {} },
    // toolCallId threads through executeTool → the split is idempotent on a checkpoint replay
    // (same id → same splitId), exactly like splitTool.
    execute: async (_input, toolCallId) => {
      try {
        const ids = await store.list({ scope })
        const notes = (await Promise.all(ids.map(s => store.get(s.id, scope)))).filter((n): n is MemoryNote => n !== null)
        if (!notes.some(n => n.id === 'masterplan'))
          return { output: { error: `no 'masterplan' note in scope '${scope}' — author the plan-note graph first` }, isError: true }
        const plan = instantiateFrozenPlan('masterplan', notes)
        const master = notes.find(n => n.id === 'masterplan')!
        const r = await kernel.proposeSplit({
          parentTaskId: p.taskId, stepId: p.stepId, runToken: p.runToken,
          toolCallId: toolCallId ?? randomUUID(),
          title: master.title, spec: master.body || master.summary || master.title, plan,
          parentStep: { executorRef: p.executor, modelRef: p.modelRef, maxIterations: p.maxIterations },
          policy: AUTO_APPROVE, maxDepth: config.maxDepth,
        })
        return { output: r, isError: false }
      } catch (e) {
        return { output: { error: e instanceof Error ? e.message : String(e) }, isError: true }
      }
    },
  }
}
