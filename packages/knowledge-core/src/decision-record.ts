import { DECISION_REFUSAL, DecisionStatus, type Decision, type DecisionDraft, type DecisionRef, type DecisionWriteResult } from '@orc/contracts'

export interface DecisionPlan { writes: Decision[]; result: DecisionWriteResult }

const refOf = (d: Decision): DecisionRef => ({ id: d.id, location: d.location })
const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, i) => item === b[i])
const markedBy = (old: Decision, newer: string): Decision => ({ ...old, status: DecisionStatus.superseded, supersededBy: newer })

const sameDecision = (held: Decision, draft: DecisionDraft): boolean =>
  held.title === draft.title && held.context === draft.context && held.decision === draft.decision
  && held.consequences === draft.consequences && held.supersedes === draft.supersedes
  && sameList(held.tags, draft.tags) && sameList(held.considered, draft.considered)
  && (held.status === draft.status || held.status === DecisionStatus.superseded)

const planOf = (recorded: Decision, old: Decision | null, writes: Decision[]): DecisionPlan => ({
  writes,
  result: {
    recorded: refOf(recorded), superseded: old === null ? null : refOf(old), status: recorded.status,
    files: [recorded, ...(old === null ? [] : [old])].map(d => d.location), warnings: [],
  },
})

const isMarkedBy = (old: Decision, newer: string): boolean => old.status === DecisionStatus.superseded && old.supersededBy === newer
const takenByAnother = (old: Decision, newer: string): boolean => old.supersededBy !== null && old.supersededBy !== newer

function replayOf(existing: Decision, held: ReadonlyMap<string, Decision>): DecisionPlan {
  const old = existing.supersedes === null ? null : held.get(existing.supersedes) ?? null
  const completes = old === null || isMarkedBy(old, existing.id) || takenByAnother(old, existing.id) ? [] : [markedBy(old, existing.id)]
  return planOf(existing, old, completes)
}

export function planDecisionRecord(opts: {
  held: ReadonlyMap<string, Decision>
  claimed: ReadonlySet<string>
  draft: DecisionDraft
  locationOf: (draft: DecisionDraft) => string
}): DecisionPlan {
  const { held, claimed, draft } = opts
  const existing = held.get(draft.id)
  if (existing && sameDecision(existing, draft)) return replayOf(existing, held)
  if (existing || claimed.has(draft.id)) throw new Error(DECISION_REFUSAL.exists(draft.id))
  const old = draft.supersedes === null ? null : held.get(draft.supersedes) ?? null
  if (draft.supersedes !== null && old === null) throw new Error(DECISION_REFUSAL.noSuchDecision(draft.supersedes))
  if (old !== null && old.status === DecisionStatus.superseded) throw new Error(DECISION_REFUSAL.alreadySuperseded(old.id))
  const recorded: Decision = { ...draft, supersededBy: null, location: opts.locationOf(draft) }
  return planOf(recorded, old, [recorded, ...(old === null ? [] : [markedBy(old, draft.id)])])
}
