import { LINK_KIND } from './memory'

// ONE spelling of the plan-ordering rule, for the two moments that enforce it: memory_write warns
// the instant the note is authored, and the grounded freeze refuses the graph at the approval gate.
// A validation rule spelled twice drifts worse than a literal does — the two would disagree about
// what is wrong while both claim to describe it.
//
// THE RULE: ordering is the `dependsOn` FIELD. A `depends_on` LINK is knowledge ("this subplan
// builds on that finding") and never schedules — a link is a durable statement about how facts
// relate, and ordering stops meaning anything the moment the plan is frozen into steps.
//
// Observed TWICE, in two independent runs of the same task on the same model: the plan-authoring
// agent gave its 'verify' subplan a depends_on LINK to a sibling ('synthesize-map' in one run,
// 'generate-doc' in the other) where scheduling reads the field. Both writes succeeded and the
// mistake only surfaced at finalize_plan, costing a rejection, a re-read and a rewrite each —
// iterations charged against maxIterations in a grounded run. Not model noise: same mistake, two
// different sibling names, so the authoring path leads there.
//
// Pure and IO-free. The CALLER decides who the siblings are — the freeze reads the masterplan's
// decomposes_into children, memory_write resolves each link target inside the plan scope — and this
// decides whether the edge is the misuse and says so in wording neither side restates.
// Returns null when the note is fine, so the caller picks the severity: a warning where the write is
// still worth keeping, a throw where the plan is about to be frozen wrong.
export function siblingOrderingMisuse(
  noteId: string,
  links: ReadonlyArray<{ id: string; kind: string }>,
  siblings: readonly string[],
): string | null {
  for (const l of links)
    if (l.kind === LINK_KIND.depends_on && siblings.includes(l.id))
      return `plan-note '${noteId}' links depends_on '${l.id}', which is a sibling — ordering is the \`dependsOn\` FIELD, not a link. Write dependsOn: ["${l.id}"] on '${noteId}' and remove the link (a depends_on link means knowledge, and never affects scheduling).`
  return null
}
