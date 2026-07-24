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

// The text of a consolidated note — what an optional distiller returns to replace the extractive
// default (title/summary/body only; scope, id, kind, links stay owned by consolidatedNote).
export interface DistilledText { title: string; summary: string; body: string }

// A distiller turns a task's raw step outcomes into ONE coherent note's text — the LLM upgrade over
// the extractive default. Optional and injected by the composition root (which owns the model), so
// the memory plugin stays model-free and deterministic; a null return falls back to extractive.
export type ConsolidationDistiller = (input: ConsolidationInput) => Promise<DistilledText | null>

// Build a task's durable, project-scoped consolidation note, linked `derived_from` the project
// knowledge it used. Without `distilled` it is EXTRACTIVE: the step summaries already ARE the model's
// distillation, so it PROMOTES and interconnects them with no model call, keeping the event log as
// the verbatim anchor. With `distilled` (an out-of-band LLM pass) the text is a coherent synthesis
// instead of glued bullets — id/scope/links are unchanged, so the two are interchangeable. Pure.
export function consolidatedNote(input: ConsolidationInput, distilled?: DistilledText): MemoryNoteDraft {
  const withSummary = input.steps.filter(s => s.summary.trim() !== '')
  const body = distilled?.body ?? withSummary.map(s => `- ${s.title}: ${s.summary}`).join('\n')
  const links = [...new Set(input.derivedFrom)].map(id => ({ id, kind: LINK_KIND.derived_from }))
  return {
    id: slugId(`outcome ${input.taskTitle}`), // keyed on the task, distilled or not — stable + idempotent
    scope: MemoryScope.project, // durable knowledge — the whole point is promotion OUT of plan scope
    kind: NOTE_KIND.decision,
    title: (distilled?.title ?? `Outcome: ${input.taskTitle}`).slice(0, 200),
    summary: (distilled?.summary ?? withSummary[0]?.summary ?? input.taskTitle).slice(0, 500),
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
// execution kernel: memory-lifecycle work stays in the memory domain. `distill` is the optional LLM
// upgrade, injected by the composition root; absent → extractive.
export interface ConsolidationDeps { log: EventLog; store: MemoryStore; distill?: ConsolidationDistiller }

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
  const input: ConsolidationInput = { taskTitle: title, steps, derivedFrom }
  // distillation is best-effort — a model hiccup falls back to the extractive note rather than
  // dropping the capture entirely.
  const distilled = deps.distill ? await deps.distill(input).catch(() => null) : null
  // force (an explicit manual request) always REWRITES; the auto path keys by task so a redelivered
  // completion converges on one event instead of appending a duplicate memory_written.
  const writeOpts = opts.force ? {} : { idempotencyKey: `consolidate:${taskId}` }
  return deps.store.write(consolidatedNote(input, distilled ?? undefined), { source: 'cli' }, writeOpts)
}
