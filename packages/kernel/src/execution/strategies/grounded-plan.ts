import { createHash } from 'node:crypto'
import { composeAuthor, EVENT_KIND, LINK_KIND, MemoryDeletedPayload, MemoryNote, MemoryWrittenPayload, type ChildPlanDraft, type EventRecord } from '@orc/contracts'

// The per-task plan-note scope. The authoring agent (told this string in its step instructions)
// and finalize_plan both derive it from the taskId, so they read/write the same graph.
export const planScope = (taskId: string): string => `plan-${taskId}`

// The grounded plan-authoring step's role. finalize_plan is only meaningful for THIS step, so both
// createGroundedTask (which stamps it) and finalize_plan's defensive gate reference this one source.
export const PLAN_STEP_ROLE = 'auditor'

// The grounded analyze step's role (agentAnalyzer.analysisStep stamps it; runtime maps it → the
// scout memory tier). report_coverage is only meaningful for THIS step, so its gate reads this one
// source rather than a scattered 'scout' literal.
export const ANALYZE_STEP_ROLE = 'scout'

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
      const { note, author } = MemoryWrittenPayload.parse(e.payload)
      if (note.scope !== scope) continue
      const prev = byId.get(note.id)
      const by = composeAuthor(author)
      byId.set(note.id, MemoryNote.parse({
        ...note,
        createdAt: prev?.createdAt ?? e.ts, createdBy: prev?.createdBy ?? by,
        updatedAt: e.ts, updatedBy: by, revision: (prev?.revision ?? 0) + 1,
      }))
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const del = MemoryDeletedPayload.parse(e.payload)
      if (del.scope === scope) byId.delete(del.id)
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
        id, role: 'implementer', title: n.title,
        instructions: n.body || n.summary || n.title,
        dependsOn: n.links.filter(l => l.kind === LINK_KIND.depends_on).map(l => l.id).filter(d => kids.includes(d)),
        skillRefs: [] as string[],
        toolRefs: [] as string[],
      }
    }),
  }
}
