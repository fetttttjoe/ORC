import { z } from 'zod'
import { MEMORY_ID_RE } from './ids'
import { MEMORY_LIMITS } from './limits'

// The ADR lifecycle vocabulary — MATCHED VALUES like NOTE_KIND/LINK_KIND, because a status is
// filtered on (`orc adr ls --status`) and a typo there would read as "no such decisions".
//   proposed   — recorded, not yet in force (opt-in: a recorded decision is presumed in force)
//   accepted   — in force. The reading a decision gets when it names no status at all.
//   superseded — replaced by a newer decision that links to it with kind 'supersedes'
//   deprecated — withdrawn with no successor
export enum DecisionStatus {
  proposed = 'proposed',
  accepted = 'accepted',
  superseded = 'superseded',
  deprecated = 'deprecated',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const DECISION_STATUS = DecisionStatus

// The ONE place "no status" becomes a status. A schema default would be wrong here: the store
// merges on omit, so a defaulted field flips every partial update of a decision back to accepted
// (the exact trap memory_write's `summary` fell into). Readers derive; the lifecycle ops stamp
// explicitly through this same function so the two cannot disagree.
export const decisionStatusOf = (status: DecisionStatus | undefined): DecisionStatus =>
  status ?? DECISION_STATUS.accepted

// What a decision-recording door accepts — the terminal (`orc adr new`) and the MCP/copilot tool
// (`record_decision`) parse the SAME shape, so neither can drift on a field name or a cap. The
// sections are the ADR body, which the decision renderer emits under fixed headings; `tags` and
// `supersedes` are the two note fields a human decides at recording time. `supersedes` names an
// existing decision by id; the lifecycle module refuses one that is not a live decision.
export const DecisionInput = z.object({
  title: z.string().min(1).max(MEMORY_LIMITS.titleChars),
  context: z.string().min(1),
  decision: z.string().min(1),
  consequences: z.string().min(1),
  // the alternatives weighed, rendered into the ADR body — the note carries no second copy
  considered: z.array(z.string().min(1)).max(MEMORY_LIMITS.detailItems).default([]),
  status: z.enum(DecisionStatus).optional(),
  tags: z.array(z.string().max(MEMORY_LIMITS.labelChars)).max(MEMORY_LIMITS.labelItems).default([]),
  supersedes: z.string().regex(MEMORY_ID_RE).optional(),
})
export type DecisionInput = z.infer<typeof DecisionInput>
