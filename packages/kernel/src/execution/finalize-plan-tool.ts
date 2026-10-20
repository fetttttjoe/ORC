import { randomUUID } from 'node:crypto'
import { APPROVAL_ANSWER, GroundedApprovalDoor, MASTERPLAN_NOTE_ID, PlanNoteToolName, stepMayPlan, toolError, ApprovalPolicy, type Origin, type ResolvedTool, NO_INPUT_SCHEMA } from '@orc/contracts'
import { SPLIT_ORIGIN, type Kernel } from '../kernel'
import { freezePlan, noteText } from './strategies/grounded-plan'

// The human already approved conversationally, so the derived split auto-approves.
const AUTO_APPROVE = ApprovalPolicy.parse({ default: 'auto' })

// one decomposition level per approve; a subplan that decomposes re-splits when its child runs
export function finalizePlanTool(opts: {
  kernel: Pick<Kernel, 'proposeSplit' | 'listPlanNotes' | 'approvedPlanHash' | 'planNotesChangedSince' | 'nonHumanPlanApproval' | 'approvalDoors'>
  config: { maxDepth: number; autoCommit?: boolean; finishChecks: readonly string[] }
  p: { taskId: string; stepId: string; runToken: string; role: string; executor: string; modelRef: string; maxIterations: number; origin: Origin }
}): ResolvedTool[] {
  const { kernel, config, p } = opts
  // Force-auto-approves the split: only the plan step gets it, and no prompt names a task id
  if (!stepMayPlan(p)) return []
  // Both refusals quote kernel.approvalDoors, the list the gate tests, never a literal.
  const acceptedDoors = (): string => kernel.approvalDoors.map(d => `'${d}'`).join(', ')
  // 'cli' covers the web UI too (a web reply is recorded as 'cli'); other doors are only named.
  const doorAdvice = (): string =>
    kernel.approvalDoors
      .map(d => d === GroundedApprovalDoor.cli ? '`orc reply <taskId> approve` in a terminal, or in the web UI' : `the '${d}' door`)
      .join(', or ')
  return [{
    ref: `kernel/${PlanNoteToolName.finalize}`, name: PlanNoteToolName.finalize,
    description:
      // the word is interpolated so the description never names an answer the gate rejects
      `Freeze the approved plan notes into the executable plan and split it off. Call exactly once, after the human replies \`${APPROVAL_ANSWER}\` (or any equivalent assent). Derives the plan deterministically from the \`${MASTERPLAN_NOTE_ID}\` note and the subplans it lists — do NOT hand-build the split; this can never drift from what the human approved.`,
    inputSchema: NO_INPUT_SCHEMA,
    // toolCallId makes the split idempotent on checkpoint replay, as in splitTool.
    execute: async (_input, toolCallId) => {
      try {
        const notes = await kernel.listPlanNotes(p.taskId)
        const master = notes.find(n => n.id === MASTERPLAN_NOTE_ID)
        if (!master)
          return { output: { error: `no '${MASTERPLAN_NOTE_ID}' plan note yet — write it with ${PlanNoteToolName.write}, listing its subplans, first` }, isError: true }
        const approved = await kernel.approvedPlanHash(p.taskId, p.runToken)
        if (!approved) {
          // A recorded non-human approval differs from none; <taskId> stays literal (never in a prompt).
          const other = await kernel.nonHumanPlanApproval(p.taskId, p.runToken)
          if (other)
            return { output: { error: `an approval for this plan run WAS recorded, but it arrived through the '${other.source}' door, which is not among this project's accepted approval doors (${acceptedDoors()}) — do not retry: ask the human to approve via ${doorAdvice()}` }, isError: true }
          return { output: { error: `${PlanNoteToolName.finalize} requires human approval for this plan run (accepted approval doors: ${acceptedDoors()}), and none is recorded — ask the human to approve via ${doorAdvice()}, then call ${PlanNoteToolName.finalize} again` }, isError: true }
        }
        // The gate: no plan note written since approval; a stored hash depends on the build's schema.
        const changed = await kernel.planNotesChangedSince(p.taskId, approved.seq)
        if (changed.length > 0) {
          const what = changed.map(id => `'${id}'`).join(', ')
          return { output: { error: `the plan notes changed after approval (edited since: ${what}) — ask the human to approve them again, then call ${PlanNoteToolName.finalize} without editing in between` }, isError: true }
        }
        // autoCommit's tail rides the freeze, not the approval: it is kernel-owned
        const plan = freezePlan(MASTERPLAN_NOTE_ID, notes, { autoCommit: config.autoCommit, checks: config.finishChecks })
        const r = await kernel.proposeSplit({
          parentTaskId: p.taskId, stepId: p.stepId, runToken: p.runToken,
          toolCallId: toolCallId ?? randomUUID(),
          title: master.title, spec: noteText(master), plan,
          parentStep: { executorRef: p.executor, modelRef: p.modelRef, maxIterations: p.maxIterations },
          policy: AUTO_APPROVE, maxDepth: config.maxDepth,
          // the one caller allowed to carry the committer role — the plan is the kernel's own freeze
          authoredBy: SPLIT_ORIGIN.freeze,
        }, p.origin)
        return { output: r, isError: false }
      } catch (e) {
        return toolError(e)
      }
    },
  }]
}
