import { createHash } from 'node:crypto'
import { deriveNoteProvenance, EVENT_KIND, LINK_KIND, MemoryDeletedPayload, MemoryNote, MemoryWrittenPayload, MASTERPLAN_NOTE_ID, NOTE_TIER, PAYLOAD_SCHEMAS, STEP_ID, STEP_ROLE, STRATEGY, VERIFY_STEP_ID, planScope, type ChildPlanDraft, type EventRecord, type PlanNote } from '@orc/contracts'

// planScope moved to contracts (one format, one place); re-exported so kernel callers keep working
export { planScope }

// The grounded plan-authoring step's role. finalize_plan is only meaningful for THIS step, so both
// createGroundedTask (which stamps it) and finalize_plan's defensive gate reference this one source.
export const PLAN_STEP_ROLE = STEP_ROLE.auditor

// Its step id, stamped by createGroundedTask — one source, so the step that must produce a plan and
// the check that it did cannot drift apart.
export const PLAN_STEP_ID = STEP_ID.plan

// A grounded plan step's whole job is to PRODUCE a plan: a decomposition the human approved, which
// finalize_plan freezes into a split. Signalling success without one means the agent did the work
// itself, or merely narrated it — and the run then reports success while the entire point of the
// strategy, splitting into executable steps, silently did not happen. Observed live on a real run:
// a plan step wrote two unlinked notes, never called finalize_plan, and passed.
//
// Returns the reason to REFUSE the success, or null when this is not a grounded plan step or it did
// produce its split. Pure: the caller supplies the task's events.
export function groundedPlanOmission(events: EventRecord[], stepId: string, runToken: string): string | null {
  if (stepId !== PLAN_STEP_ID) return null
  const isGrounded = events.some(e => {
    if (e.kind !== EVENT_KIND.plan_proposed) return false
    const p = PAYLOAD_SCHEMAS.plan_proposed.safeParse(e.payload)
    return p.success && p.data.plan.strategyRef === STRATEGY.groundedPlan
  })
  if (!isGrounded) return null
  const split = events.some(e => {
    if (e.kind !== EVENT_KIND.split_proposed) return false
    const p = PAYLOAD_SCHEMAS.split_proposed.safeParse(e.payload)
    return p.success && p.data.runToken === runToken
  })
  return split
    ? null
    : 'the plan step signalled success without calling finalize_plan — author the plan-note graph '
      + `in scope '${planScope(events[0]?.taskId ?? '')}' (root note '${MASTERPLAN_NOTE_ID}', each subplan linked `
      + 'decomposes_into), get the human to approve it, then call finalize_plan. Doing the work '
      + 'yourself instead of decomposing it defeats the grounded-plan strategy.'
}

// The grounded analyze step's role (agentAnalyzer.analysisStep stamps it; runtime maps it → the
// scout memory tier). report_coverage is only meaningful for THIS step, so its gate reads this one
// source rather than a scattered 'scout' literal.
export const ANALYZE_STEP_ROLE = STEP_ROLE.scout

// The auditor role's contract, appended to the verify step's instructions at the freeze so it is
// part of the plan-hash-approved artifact (not executor policy). Without it an auditor that finds
// defects can signal success with the defects buried in the summary — downstream only reads the
// outcome, so a defect-carrying success is indistinguishable from a clean pass.
export const AUDITOR_CONTRACT =
  "Auditor rule: if your audit finds ANY defect, signal outcome 'failure' and list every defect in the summary — never 'success' with defects noted inside it. Success means zero defects."

export function planGraphHash(notes: PlanNote[]): string {
  const canonical = [...notes]
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id))
    .map(note => MemoryNote.parse(note))
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

// FixE: reconstruct the task's plan-note graph from the EVENT LOG (the source of truth) rather than
// the async SurrealDB projection — the log is synchronously durable the instant finalize runs, so the
// frozen executable plan can never be built from a stale read model. Folds memory_written/deleted in
// seq order to the latest note per id (a later memory_deleted drops it), mirroring the projector's
// provenance derivation (surreal.applyEvent) so the note shape matches what instantiateFrozenPlan
// expects. Pure: the caller supplies the already-read events (scoped to the memory kinds).
// ponytail: caller hands the full memory-event history; add a scope-indexed read if it ever costs.
// PLAN TIER ONLY: a task's plan scope also holds the episodic notes its own planning step left
// behind (ambient capture writes one per step, into the same scope). Those are not part of the
// decomposition, and including them would let a step note the human never reviewed change the
// plan hash between approval and freeze.
export function foldPlanNotes(events: EventRecord[], scope: string): PlanNote[] {
  const byId = new Map<string, PlanNote>()
  for (const e of events) {
    if (e.kind === EVENT_KIND.memory_written) {
      // lenient like the projector's fold contract: one unparseable/legacy payload (any scope, any
      // age) must skip its case, not throw out of every grounded task's plan freeze and approval.
      const parsed = MemoryWrittenPayload.safeParse(e.payload)
      if (!parsed.success) continue
      const { note, author } = parsed.data
      if (note.scope !== scope || note.tier !== NOTE_TIER.plan) continue
      const prev = byId.get(note.id)
      // shared derivation with the projector — this once forgot to stamp sources.retrievedAt and
      // threw MemoryNote.parse on every sourced plan note, blocking approval.
      const full = MemoryNote.parse({ ...note, ...deriveNoteProvenance(note, author, e.ts, prev) })
      if (full.tier === NOTE_TIER.plan) byId.set(note.id, full)
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const del = MemoryDeletedPayload.safeParse(e.payload)
      if (del.success && del.data.scope === scope) byId.delete(del.data.id)
    }
  }
  return [...byId.values()]
}

// The deterministic freeze (S1): the executable plan is a PURE function of the approved
// plan-notes — no clock/random/IO — so it can never drift from what the human approved.
// master's decomposes_into children → steps; each child's depends_on links → dependsOn.
// ponytail: one decomposition level per approve — a subplan that itself decomposes re-splits
// when its child runs; recurse only when a real 3-level plan needs it.
export function instantiateFrozenPlan(masterId: string, notes: PlanNote[]): ChildPlanDraft {
  const byId = new Map(notes.map(n => [n.id, n]))
  const kids = (byId.get(masterId)?.links ?? []).filter(l => l.kind === LINK_KIND.decomposes_into).map(l => l.id)
  return {
    steps: kids.map(id => {
      const n = byId.get(id)
      if (!n) throw new Error(`masterplan decomposes_into '${id}' but no such plan-note exists`)
      return {
        // role mapping at the freeze (P2): the verify subplan runs as auditor — memory tier
        // and prompt framing follow from the role automatically
        id, role: id === VERIFY_STEP_ID ? STEP_ROLE.auditor : STEP_ROLE.implementer, title: n.title,
        instructions: (n.body || n.summary || n.title)
          + (id === VERIFY_STEP_ID ? `\n\n${AUDITOR_CONTRACT}` : ''),
        dependsOn: n.links.filter(l => l.kind === LINK_KIND.depends_on).map(l => l.id).filter(d => kids.includes(d)),
        // the note's declared write-globs become the step's zone — the executor fence makes
        // "parallel siblings must not write the same files" mechanical instead of prose
        zone: n.zone,
        // the planner decides what each subplan needs; the operator decided what exists at all
        skillRefs: n.skillRefs,
        toolRefs: n.toolRefs,
        // '' means the planner expressed no preference — omit the key so the expansion inherits
        ...(n.modelRef ? { modelRef: n.modelRef } : {}),
      }
    }),
  }
}
