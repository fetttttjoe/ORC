import { EVENT_KIND, LINK_KIND, MemoryAccessedPayload, MemoryScope, NOTE_KIND, PAYLOAD_SCHEMAS, RETENTION, planScope, slugId, type MemoryNote, type MemoryNoteDraft, type MemoryStore } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'

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

// Salience gate for AUTO consolidation: a finished task earns a durable note only if it did real
// work — it engaged existing project knowledge (has provenance to link) OR it was composed of several
// steps. Trivial single-lookups are skipped, so auto-capture grows memory without flooding it. One
// tunable predicate; the manual command bypasses it (force).
export function isSubstantive(input: { steps: StepOutcome[]; derivedFrom: string[] }): boolean {
  return input.derivedFrom.length >= 1 || input.steps.length >= 2
}

// What consolidateTask reads from — the memory read model and the event log, nothing from the
// execution kernel: memory-lifecycle work stays in the memory domain.
export interface ConsolidationDeps { log: EventLog; store: MemoryStore }

// The task's title, folded from its task_created event; null if the task is unknown to the log.
async function taskTitle(log: EventLog, taskId: string): Promise<string | null> {
  for (const e of await log.after(0, [EVENT_KIND.task_created])) {
    const p = PAYLOAD_SCHEMAS.task_created.safeParse(e.payload)
    if (p.success && p.data.task.id === taskId) return p.data.task.title
  }
  return null
}

// The DURABLE project note ids this task actually read (its provenance). memory_accessed carries the
// acting task in its envelope; parse the payload for the note id + scope, never cast.
async function accessedProjectIds(log: EventLog, taskId: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const e of await log.after(0, [EVENT_KIND.memory_accessed])) {
    if (e.taskId !== taskId) continue
    const p = MemoryAccessedPayload.safeParse(e.payload)
    if (p.success && p.data.scope === MemoryScope.project) ids.add(p.data.id)
  }
  return [...ids]
}

// Gather a finished task's transient step notes + provenance, gate on salience (unless forced), and
// promote them into ONE durable project note. Event-first + idempotent by taskId, so a redelivered
// completion never double-writes. Returns the note, or null when the task is unknown or the salience
// gate declines. Projection is the caller's concern (the runtime's live projector picks the write up;
// the CLI catches up explicitly) — this stays a pure write.
export async function consolidateTask(
  deps: ConsolidationDeps,
  taskId: string,
  opts: { force?: boolean } = {},
): Promise<MemoryNote | null> {
  const title = await taskTitle(deps.log, taskId)
  if (title === null) return null
  const steps = (await deps.store.list({ scope: planScope(taskId) })).map(n => ({ title: n.title, summary: n.summary }))
  const derivedFrom = await accessedProjectIds(deps.log, taskId)
  if (!opts.force && !isSubstantive({ steps, derivedFrom })) return null
  return deps.store.write(consolidatedNote({ taskTitle: title, steps, derivedFrom }), { source: 'cli' }, { idempotencyKey: `consolidate:${taskId}` })
}
