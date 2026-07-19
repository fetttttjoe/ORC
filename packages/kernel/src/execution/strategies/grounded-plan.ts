import { LINK_KIND, type ChildPlanDraft, type MemoryNote } from '@orc/contracts'

// The per-task plan-note scope. The authoring agent (told this string in its step instructions)
// and finalize_plan both derive it from the taskId, so they read/write the same graph.
export const planScope = (taskId: string): string => `plan-${taskId}`

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
