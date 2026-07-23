import { createHash } from 'node:crypto'
import { deriveNoteProvenance, EVENT_KIND, LINK_KIND, MemoryDeletedPayload, MemoryNote, MemoryWrittenPayload, VERIFY_STEP_ID, planScope, type ChildPlanDraft, type EventRecord } from '@orc/contracts'

// planScope moved to contracts (one format, one place); re-exported so kernel callers keep working
export { planScope }

// The grounded plan-authoring step's role. finalize_plan is only meaningful for THIS step, so both
// createGroundedTask (which stamps it) and finalize_plan's defensive gate reference this one source.
export const PLAN_STEP_ROLE = 'auditor'

// The grounded analyze step's role (agentAnalyzer.analysisStep stamps it; runtime maps it → the
// scout memory tier). report_coverage is only meaningful for THIS step, so its gate reads this one
// source rather than a scattered 'scout' literal.
export const ANALYZE_STEP_ROLE = 'scout'

// The auditor role's contract, appended to the verify step's instructions at the freeze so it is
// part of the plan-hash-approved artifact (not executor policy). Without it an auditor that finds
// defects can signal success with the defects buried in the summary — downstream only reads the
// outcome, so a defect-carrying success is indistinguishable from a clean pass.
export const AUDITOR_CONTRACT =
  "Auditor rule: if your audit finds ANY defect, signal outcome 'failure' and list every defect in the summary — never 'success' with defects noted inside it. Success means zero defects."

export function planGraphHash(notes: MemoryNote[]): string {
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
export function foldPlanNotes(events: EventRecord[], scope: string): MemoryNote[] {
  const byId = new Map<string, MemoryNote>()
  for (const e of events) {
    if (e.kind === EVENT_KIND.memory_written) {
      // lenient like the projector's fold contract: one unparseable/legacy payload (any scope, any
      // age) must skip its case, not throw out of every grounded task's plan freeze and approval.
      const parsed = MemoryWrittenPayload.safeParse(e.payload)
      if (!parsed.success) continue
      const { note, author } = parsed.data
      if (note.scope !== scope) continue
      const prev = byId.get(note.id)
      // shared derivation with the projector — this once forgot to stamp sources.retrievedAt and
      // threw MemoryNote.parse on every sourced plan note, blocking approval.
      byId.set(note.id, MemoryNote.parse({ ...note, ...deriveNoteProvenance(note, author, e.ts, prev) }))
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
export function instantiateFrozenPlan(masterId: string, notes: MemoryNote[]): ChildPlanDraft {
  const byId = new Map(notes.map(n => [n.id, n]))
  const kids = (byId.get(masterId)?.links ?? []).filter(l => l.kind === LINK_KIND.decomposes_into).map(l => l.id)
  return {
    steps: kids.map(id => {
      const n = byId.get(id)
      if (!n) throw new Error(`masterplan decomposes_into '${id}' but no such plan-note exists`)
      return {
        // role mapping at the freeze (P2): the verify subplan runs as auditor — memory tier
        // and prompt framing follow from the role automatically
        id, role: id === VERIFY_STEP_ID ? 'auditor' : 'implementer', title: n.title,
        instructions: (n.body || n.summary || n.title)
          + (id === VERIFY_STEP_ID ? `\n\n${AUDITOR_CONTRACT}` : ''),
        dependsOn: n.links.filter(l => l.kind === LINK_KIND.depends_on).map(l => l.id).filter(d => kids.includes(d)),
        // the note's declared write-globs become the step's zone — the executor fence makes
        // "parallel siblings must not write the same files" mechanical instead of prose
        zone: n.zone,
        skillRefs: [] as string[],
        toolRefs: [] as string[],
      }
    }),
  }
}
