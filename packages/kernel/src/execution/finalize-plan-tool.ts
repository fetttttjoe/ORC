import { randomUUID } from 'node:crypto'
import { APPROVAL_ANSWER, GROUNDED_APPROVAL_DOOR, MASTERPLAN_NOTE_ID, toolError, ApprovalPolicy, type ResolvedTool } from '@orc/contracts'
import { SPLIT_ORIGIN, type Kernel } from '../kernel'
import { freezePlan, planScope, PLAN_STEP_ROLE } from './strategies/grounded-plan'

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
  kernel: Pick<Kernel, 'proposeSplit' | 'listPlanNotes' | 'approvedPlanHash' | 'planNotesChangedSince' | 'nonHumanPlanApproval' | 'approvalDoors'>
  config: { maxDepth: number; autoCommit?: boolean }
  p: { taskId: string; stepId: string; runToken: string; role: string; executor: string; modelRef: string; maxIterations: number }
}): ResolvedTool {
  const { kernel, config, p } = opts
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
      .map(d => d === GROUNDED_APPROVAL_DOOR.cli ? '`orc reply <taskId> approve` in a terminal, or in the web UI' : `the '${d}' door`)
      .join(', or ')
  return {
    ref: 'kernel/finalize_plan', name: 'finalize_plan',
    description:
      // the word is interpolated, not typed: the description tells a model what to wait for, and a
      // description naming a word the gate no longer accepts sends the agent back to re-ask.
      `Freeze the approved plan-note graph into the executable plan and split it off. Call exactly once, after the human replies \`${APPROVAL_ANSWER}\` (or any equivalent assent). Derives the plan deterministically from the \`${MASTERPLAN_NOTE_ID}\` note and its decomposes_into subplans — do NOT hand-build the split; this can never drift from what the human approved.`,
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
          return { output: { error: `finalize_plan requires human approval for this plan run (accepted approval doors: ${acceptedDoors()}), and none is recorded — ask the human to approve via ${doorAdvice()}, then call finalize_plan again` }, isError: true }
        }
        // THE gate: nothing was written to this task's plan scope after the human approved. That is
        // equivalent to "the graph is unchanged" by construction — foldPlanNotes is a pure function
        // of exactly the events planNotesChangedSince counts, so an empty set means an identical
        // fold — and strictly stricter, because a write that restores the approved content re-gates.
        //
        // Deliberately NOT `approved.hash !== planGraphHash(notes)`. A content hash is a function of
        // the RUNNING BUILD's note schema as much as of the plan, and the two sides of this gate are
        // two processes that need not be the same build. Observed live on task b3a49133: the human
        // approved through the graph UI, whose server process had been running since before
        // `dependsOn` was added to PlanNoteInput — its MemoryNote.parse dropped that field, so it
        // stamped a hash the executor could not reproduce for the byte-identical notes. The gate was
        // then unsatisfiable (eight approvals, eight rejections) AND undiagnosable, because nothing
        // had in fact changed and so the message below had no note to name. The stamped hash stays
        // on the event as the marker approvedPlanHash uses to tell a plan approval from any other
        // 'approve', and as an audit record — but a record only the build that stamped it can
        // reproduce, so it attests THAT an approval happened over some graph, never that it was
        // THIS graph. Nothing may compare it against a freshly computed one.
        //
        // ponytail: one widening, taken deliberately. planNotesChangedSince cannot filter its
        // delete branch by tier — MemoryDeletedPayload carries no tier field. foldPlanNotes is
        // tier-blind there too, but for IT a delete of a non-plan id is a no-op, so deleting an
        // episodic note inside the plan scope leaves the fold identical while making the changed-set
        // non-empty: this gate re-asks where the old one passed. Unreachable by any agent or
        // automatic path (agents have no delete tool, the cancel GC does not touch a live task's
        // notes, staleNotes needs 30 days AND --apply), so it costs only a deliberate human delete
        // mid-approval, and it self-clears — re-approving moves approved.seq past the delete.
        // Upgrade path if that ever bites: diff foldPlanNotes at approved.seq against now, both
        // folds computed in ONE process, which stays build-independent.
        const changed = await kernel.planNotesChangedSince(p.taskId, approved.seq)
        if (changed.length > 0) {
          // Naming the notes is the difference between a gate the human can clear in a glance and
          // one they have to re-derive. Observed live: an agent retyped two link kinds after
          // approval and spent a full round-trip re-asking, with nothing to say about what moved.
          const what = changed.map(id => `'${id}'`).join(', ')
          return { output: { error: `the plan-note graph changed after approval (edited since: ${what}) — ask the human to approve it again, then call finalize_plan without editing in between` }, isError: true }
        }
        // autoCommit's tail rides the freeze, not the approval: kernel-owned like the role-skill refs the freeze appends
        const plan = freezePlan(MASTERPLAN_NOTE_ID, notes, { autoCommit: config.autoCommit })
        const r = await kernel.proposeSplit({
          parentTaskId: p.taskId, stepId: p.stepId, runToken: p.runToken,
          toolCallId: toolCallId ?? randomUUID(),
          title: master.title, spec: master.body || master.summary || master.title, plan,
          parentStep: { executorRef: p.executor, modelRef: p.modelRef, maxIterations: p.maxIterations },
          policy: AUTO_APPROVE, maxDepth: config.maxDepth,
          // the one caller allowed to carry the committer role — the plan is the kernel's own freeze
          origin: SPLIT_ORIGIN.freeze,
        })
        return { output: r, isError: false }
      } catch (e) {
        return toolError(e)
      }
    },
  }
}
