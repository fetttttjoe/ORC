import { randomUUID } from 'node:crypto'
import { MASTERPLAN_NOTE_ID, errorMessage, ApprovalPolicy, type ResolvedTool } from '@orc/contracts'
import type { Kernel } from '../kernel'
import { instantiateFrozenPlan, planGraphHash, planScope, PLAN_STEP_ROLE } from './strategies/grounded-plan'

// grounded-plan child policy: the human already approved conversationally (the ask_human loop),
// so the derived split auto-approves — this scaffold is not a second human gate.
const AUTO_APPROVE = ApprovalPolicy.parse({ default: 'auto' })

// finalize_plan (M5b): the plan-authoring agent calls this after the human replies `approve`.
// It reconstructs the task's plan-note graph FROM THE EVENT LOG (kernel.listPlanNotes — the source
// of truth, synchronously durable), deterministically freezes it (instantiateFrozenPlan), and drives
// the SAME task_split path splitTool uses. Sourcing its draft from the log (not the async projection,
// not the model) means the executable plan can never drift from what the human approved, and never
// races the SurrealDB read model. Mirrors splitTool's factory (kernel + step context injected).
// ponytail: one decomposition level per approve — a subplan that itself decomposes re-splits when
// its child runs; recurse only when a real 3-level plan needs it.
export function finalizePlanTool(opts: {
  kernel: Pick<Kernel, 'proposeSplit' | 'listPlanNotes' | 'approvedPlanHash' | 'planNotesChangedSince'>
  config: { maxDepth: number }
  p: { taskId: string; stepId: string; runToken: string; role: string; executor: string; modelRef: string; maxIterations: number }
}): ResolvedTool {
  const { kernel, config, p } = opts
  return {
    ref: 'kernel/finalize_plan', name: 'finalize_plan',
    description:
      "Freeze the approved plan-note graph into the executable plan and split it off. Call exactly once, after the human replies `approve`. Derives the plan deterministically from the `masterplan` note and its decomposes_into subplans — do NOT hand-build the split; this can never drift from what the human approved.",
    inputSchema: { type: 'object', properties: {} },
    // toolCallId threads through executeTool → the split is idempotent on a checkpoint replay
    // (same id → same splitId), exactly like splitTool.
    execute: async (_input, toolCallId) => {
      // M3 defense-in-depth: finalize_plan force-auto-approves the derived split, unlike splitTool
      // which honours the project's approvalPolicy. It's safe today only because taskId never appears
      // in a model prompt, so only the grounded auditor step can meaningfully call it. Gate to that
      // role so a future change exposing taskId can't silently open an auto-approve bypass. Adds a
      // restriction only.
      if (p.role !== PLAN_STEP_ROLE)
        return { output: { error: `finalize_plan is only valid for a grounded-plan's '${PLAN_STEP_ROLE}' step` }, isError: true }
      try {
        const notes = await kernel.listPlanNotes(p.taskId)
        const master = notes.find(n => n.id === MASTERPLAN_NOTE_ID)
        if (!master)
          return { output: { error: `no '${MASTERPLAN_NOTE_ID}' note in scope '${planScope(p.taskId)}' — author the plan-note graph first` }, isError: true }
        const currentHash = planGraphHash(notes)
        const approved = await kernel.approvedPlanHash(p.taskId, p.runToken)
        if (!approved)
          return { output: { error: 'finalize_plan requires human approval for this plan run' }, isError: true }
        if (approved.hash !== currentHash) {
          // Naming the notes is the difference between a gate the human can clear in a glance and
          // one they have to re-derive. Observed live: an agent retyped two link kinds after
          // approval and spent a full round-trip re-asking, with nothing to say about what moved.
          const changed = await kernel.planNotesChangedSince(p.taskId, approved.seq)
          const what = changed.length > 0 ? ` (edited since: ${changed.map(id => `'${id}'`).join(', ')})` : ''
          return { output: { error: `the plan-note graph changed after approval${what} — ask the human to approve it again, then call finalize_plan without editing in between` }, isError: true }
        }
        const plan = instantiateFrozenPlan(MASTERPLAN_NOTE_ID, notes)
        const r = await kernel.proposeSplit({
          parentTaskId: p.taskId, stepId: p.stepId, runToken: p.runToken,
          toolCallId: toolCallId ?? randomUUID(),
          title: master.title, spec: master.body || master.summary || master.title, plan,
          parentStep: { executorRef: p.executor, modelRef: p.modelRef, maxIterations: p.maxIterations },
          policy: AUTO_APPROVE, maxDepth: config.maxDepth,
        })
        return { output: r, isError: false }
      } catch (e) {
        return { output: { error: errorMessage(e) }, isError: true }
      }
    },
  }
}
