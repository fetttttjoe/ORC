import { randomUUID } from 'node:crypto'
import { APPROVAL_ANSWER, GroundedApprovalDoor, MASTERPLAN_NOTE_ID, PlanNoteToolName, stepMayPlan, toolError, ApprovalPolicy, type Origin, type ResolvedTool, NO_INPUT_SCHEMA } from '@orc/contracts'
import { SPLIT_ORIGIN, type Kernel } from '../kernel'
import { freezePlan, noteText } from './strategies/grounded-plan'

// grounded-plan child policy: the human already approved conversationally (the ask_human loop),
// so the derived split auto-approves — this scaffold is not a second human gate.
const AUTO_APPROVE = ApprovalPolicy.parse({ default: 'auto' })

// finalize_plan (M5b): the plan-authoring agent calls this after the human replies `approve`.
// It reconstructs the task's plan notes FROM THE EVENT LOG (kernel.listPlanNotes), deterministically
// freezes them (instantiateFrozenPlan), and drives the SAME task_split path splitTool uses, so the
// executable plan can never drift from what the human approved. Mirrors splitTool's factory
// (kernel + step context injected).
// ponytail: one decomposition level per approve — a subplan that itself decomposes re-splits when
// its child runs; recurse only when a real 3-level plan needs it.
export function finalizePlanTool(opts: {
  kernel: Pick<Kernel, 'proposeSplit' | 'listPlanNotes' | 'approvedPlanHash' | 'planNotesChangedSince' | 'nonHumanPlanApproval' | 'approvalDoors'>
  config: { maxDepth: number; autoCommit?: boolean; finishChecks: readonly string[] }
  p: { taskId: string; stepId: string; runToken: string; role: string; executor: string; modelRef: string; maxIterations: number; origin: Origin }
}): ResolvedTool[] {
  const { kernel, config, p } = opts
  // M3: it force-auto-approves the derived split, so only the plan step is offered it, and no prompt names a task id
  if (!stepMayPlan(p)) return []
  // Both refusals below quote the SAME list the gate tests (kernel.approvalDoors), never a literal:
  // the previous message hardcoded the human doors, so an operator who widened the accepted set
  // would have been told to go type in a terminal by a gate that had already stopped requiring it.
  const acceptedDoors = (): string => kernel.approvalDoors.map(d => `'${d}'`).join(', ')
  // What a HUMAN can actually do, per accepted door. 'cli' names both human doors on purpose: a web
  // UI reply rides the actions layer's default and is recorded as 'cli' (contracts has no 'web'
  // door for exactly that reason). Any other door is named, not instructed — only the operator who
  // opened it knows how it is driven.
  const doorAdvice = (): string =>
    kernel.approvalDoors
      .map(d => d === GroundedApprovalDoor.cli ? '`orc reply <taskId> approve` in a terminal, or in the web UI' : `the '${d}' door`)
      .join(', or ')
  return [{
    ref: `kernel/${PlanNoteToolName.finalize}`, name: PlanNoteToolName.finalize,
    description:
      // the word is interpolated, not typed: the description tells a model what to wait for, and a
      // description naming a word the gate no longer accepts sends the agent back to re-ask.
      `Freeze the approved plan notes into the executable plan and split it off. Call exactly once, after the human replies \`${APPROVAL_ANSWER}\` (or any equivalent assent). Derives the plan deterministically from the \`${MASTERPLAN_NOTE_ID}\` note and the subplans it lists — do NOT hand-build the split; this can never drift from what the human approved.`,
    inputSchema: NO_INPUT_SCHEMA,
    // toolCallId threads through executeTool → the split is idempotent on a checkpoint replay
    // (same id → same splitId), exactly like splitTool.
    execute: async (_input, toolCallId) => {
      try {
        const notes = await kernel.listPlanNotes(p.taskId)
        const master = notes.find(n => n.id === MASTERPLAN_NOTE_ID)
        if (!master)
          return { output: { error: `no '${MASTERPLAN_NOTE_ID}' plan note yet — write it with ${PlanNoteToolName.write}, listing its subplans, first` }, isError: true }
        const approved = await kernel.approvedPlanHash(p.taskId, p.runToken)
        if (!approved) {
          // Two very different states reach here, and the old single message described only one of
          // them. Observed: an agent driving the MCP surface replied 'approve', the log recorded it
          // with a planHash and author.source 'mcp', approvedPlanHash (whose accepted door set the
          // operator owns, and which defaults to 'cli' alone) returned null, and the refusal said
          // "requires human approval" — indistinguishable from
          // nobody having approved. So the agent retried the one thing that cannot work.
          // nonHumanPlanApproval reads exactly the approval this gate discarded; the gate itself is
          // unchanged. `<taskId>` stays a LITERAL placeholder: the force-auto-approve above is safe
          // only while the real taskId never appears in a model prompt (see the M3 comment), and a
          // human reading the relayed message has their task id already.
          const other = await kernel.nonHumanPlanApproval(p.taskId, p.runToken)
          if (other)
            return { output: { error: `an approval for this plan run WAS recorded, but it arrived through the '${other.source}' door, which is not among this project's accepted approval doors (${acceptedDoors()}) — do not retry: ask the human to approve via ${doorAdvice()}` }, isError: true }
          return { output: { error: `${PlanNoteToolName.finalize} requires human approval for this plan run (accepted approval doors: ${acceptedDoors()}), and none is recorded — ask the human to approve via ${doorAdvice()}, then call ${PlanNoteToolName.finalize} again` }, isError: true }
        }
        // THE gate: no plan note written since the approval. Never a hash comparison — the stamped
        // hash is a function of the stamping build's schema as much as of the notes.
        const changed = await kernel.planNotesChangedSince(p.taskId, approved.seq)
        if (changed.length > 0) {
          // Naming the notes is the difference between a gate the human can clear in a glance and
          // one they have to re-derive.
          const what = changed.map(id => `'${id}'`).join(', ')
          return { output: { error: `the plan notes changed after approval (edited since: ${what}) — ask the human to approve them again, then call ${PlanNoteToolName.finalize} without editing in between` }, isError: true }
        }
        // autoCommit's tail rides the freeze, not the approval: kernel-owned like the role-skill refs the freeze appends
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
