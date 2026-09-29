import { DecisionInput, stepMayReconcile, toolError, type MemoryAuthor, type ResolvedTool } from '@orc/contracts'
import { recordDecision, type DecisionDoor } from './decisions'

// The finish step's tool. This file REGISTERS and DELEGATES to decisions.ts's recordDecision — the
// same op `orc adr new` goes through, so the terminal and the step can never disagree about what
// recording a decision means.
//
// `record_decision` is deliberately the SAME model-facing verb the copilot/MCP door offers
// (ui-core/src/copilot.ts, over OrcActions.recordDecision) — one name for one act, whichever door
// performs it. That door spells the name as its own object key, so the two spellings are not yet
// pinned to each other; a shared constant belongs in contracts beside MEMORY_TOOL_NAME if a third
// door ever appears.
export const FINISH_TOOL_NAME = { recordDecision: 'record_decision' } as const

const RECORD_DECISION_DESCRIPTION =
  'Record the ONE architectural decision this task made, AFTER the human approved its wording in your '
  + 'summary. Title + Context / Decision / Consequences, plus the alternatives you considered. Refused if a decision with that title exists — '
  + 'then it is a supersession, which is a human act: report it in your summary instead.'

// Advertised separately from the tool literal so the coverage guard below has something to compare
// DecisionInput's keys against — the same shape tools.ts's WRITE_PROPERTIES/WriteSchemaCoversInput
// pair takes, and for the same reason: a field the parser accepts but the schema never names is
// invisible to the model, which then reaches for whatever IS advertised.
const RECORD_DECISION_PROPERTIES = {
  title: { type: 'string', description: 'the decision in one line — it becomes the note id, so a later supersession names it' },
  context: { type: 'string', description: 'the forces in play: what made this a decision rather than an obvious step' },
  decision: { type: 'string', description: 'what was decided, stated so a later decision could supersede it' },
  consequences: { type: 'string', description: 'what this commits the project to, and what it rules out' },
  considered: { type: 'array', items: { type: 'string' }, description: 'the alternatives weighed and not taken, one per item — a later reader must not re-argue them' },
  tags: { type: 'array', items: { type: 'string' } },
}

// The two deliberate omissions, and why each is NOT a gap:
//  • `supersedes` — replacing a live decision is a HUMAN act (the finisher's skill contract says so
//    too): the step reports the collision in its summary and a person records the supersession.
//    Advertising it would let a step retire a decision nobody asked it to retire.
//  • `status` — this door only ever writes `accepted`. The wording was already approved by the human
//    in the feedback loop before the call, so `proposed` (which means "recorded, not yet in force")
//    would be a lie about a decision that IS in force, and nothing else in this flow uses it.
// Both stay parseable by DecisionInput: `orc adr new` needs them, and one schema for both doors is
// the point. They are simply not offered HERE.
type UnadvertisedByDesign = 'supersedes' | 'status'
type RecordSchemaCoversInput =
  Exclude<keyof typeof DecisionInput.shape, keyof typeof RECORD_DECISION_PROPERTIES | UnadvertisedByDesign> extends never ? true : never
const recordSchemaCoversInput: RecordSchemaCoversInput = true
void recordSchemaCoversInput

// Said, not hidden. A tool that VANISHES when the read model is down reads to the model as "this
// task has no decision to record"; one that answers "unavailable" reads as what it is, and the
// finisher can put the gap in its summary. Same posture as unavailableMemoryTools.
const MEMORY_DOWN = 'memory unavailable: the read model is down — the decision was NOT recorded; say so in your summary'

/**
 * The finish step's tool, registration-gated on `stepMayReconcile` — BOTH terms, the same shape
 * commit-tool.ts uses: a worker step a planner named 'finish', or a split step claiming the finisher
 * role, gets neither. A registration gate rather than an execute-time refusal because a visible tool
 * that can only ever error gets called anyway, one wasted iteration per attempt (report_coverage
 * learned that live).
 *
 * `door: null` means memory is degraded — see MEMORY_DOWN.
 */
export function finishTools(deps: {
  door: DecisionDoor | null
  author: MemoryAuthor
  p: { taskId: string; stepId: string; role: string }
}): ResolvedTool[] {
  if (!stepMayReconcile(deps.p)) return []
  return [
    {
      ref: `memory/${FINISH_TOOL_NAME.recordDecision}`, name: FINISH_TOOL_NAME.recordDecision,
      description: RECORD_DECISION_DESCRIPTION,
      inputSchema: {
        type: 'object',
        required: ['title', 'context', 'decision', 'consequences'],
        properties: RECORD_DECISION_PROPERTIES,
      },
      execute: async input => {
        if (deps.door === null) return { output: { error: MEMORY_DOWN }, isError: true }
        try {
          // The STEP's author, so the note's createdBy names the finisher rather than the door —
          // and DecisionInput.parse at the boundary, so the refusals the model reads are the
          // schema's own, not a hand-rolled check that could drift from `orc adr new`.
          const r = await recordDecision(deps.door, deps.author, DecisionInput.parse(input))
          return { output: { id: r.note.id, status: r.status }, isError: false }
        } catch (err) { return toolError(err) }
      },
    },
  ]
}
