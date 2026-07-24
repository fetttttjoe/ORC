import { LINK_KIND, MemoryScope, NOTE_KIND, RETENTION, slugId, type MemoryNoteDraft } from '@orc/contracts'

// One transient step outcome — the (title, summary) of a plan-scoped ambient note a task left behind.
export interface StepOutcome { title: string; summary: string }

// What consolidation needs, all gathered by the caller from the log: the task's identity, its step
// outcomes, and the ids of the DURABLE project notes the task actually read (its provenance).
export interface ConsolidationInput {
  taskTitle: string
  steps: StepOutcome[]
  derivedFrom: string[]
}

// Marks a note as a task-consolidation output — one place, so search/filters agree on the spelling.
export const CONSOLIDATED_TAG = 'consolidated'

// Distill a task's transient plan-scoped step notes into ONE durable, project-scoped note, linked
// `derived_from` the project knowledge the task built on. Extractive by design: the step summaries
// already ARE the model's distillation, so this spends no model call — it PROMOTES and interconnects
// them, it does not re-summarise (which would risk the over-summarisation failure mode the memory
// research warns of; the event log stays the verbatim anchor). Pure: same input → same draft.
export function consolidatedNote(input: ConsolidationInput): MemoryNoteDraft {
  const withSummary = input.steps.filter(s => s.summary.trim() !== '')
  const body = withSummary.map(s => `- ${s.title}: ${s.summary}`).join('\n')
  const links = [...new Set(input.derivedFrom)].map(id => ({ id, kind: LINK_KIND.derived_from }))
  return {
    id: slugId(`outcome ${input.taskTitle}`),
    scope: MemoryScope.project, // durable knowledge — the whole point is promotion OUT of plan scope
    kind: NOTE_KIND.decision,
    title: `Outcome: ${input.taskTitle}`.slice(0, 200),
    summary: (withSummary[0]?.summary ?? input.taskTitle).slice(0, 500),
    body,
    tags: [CONSOLIDATED_TAG],
    links,
    retention: RETENTION.durable,
  }
}
