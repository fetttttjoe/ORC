import { z } from 'zod'
import { EVENT_KIND, FS_WRITE_TOOL_NAME, LINK_KIND, MemoryAccessedPayload, MemoryScope, NOTE_KIND, NOTE_TIER, PAYLOAD_SCHEMAS, RETENTION, STEP_ID, TASK_STATUS, planScope, slugId, type MemoryAuthor, type MemoryNote, type MemoryNoteDraft, type MemoryStore } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'

// One transient step outcome — the (title, summary) of a plan-scoped ambient note a task left behind.
export interface StepOutcome { title: string; summary: string }

// What consolidation needs, all gathered by the caller from the log: the task's identity, its step
// outcomes, the ids of the DURABLE project notes the task actually read (its provenance), and the
// paths the task itself wrote — what anchors the outcome to the tree so drift can vouch for it.
export interface ConsolidationInput {
  taskId: string
  taskTitle: string
  steps: StepOutcome[]
  derivedFrom: string[]
  // The task's own written paths (fs_write/fs_edit/fs_delete), folded from its tool_call events.
  // Without them every outcome note was uncheckable forever: 51 of 91 semantic notes carried no
  // paths, and one kept asserting a fix in a directory deleted weeks earlier with nothing able to
  // flag it [measured 2026-08-03]. Empty for a read-only task — nothing to cite is the honest state.
  paths: string[]
  // Descendants that never reached done. A grounded parent finishes as soon as its plan is authored
  // and split, so its step summaries describe INTENDED work — and a distiller handed only those
  // renders them as accomplished ("implemented, tested and verified" for a run whose test step
  // crashed and whose verify step never started). The outcome has to travel with the summaries.
  unfinished: string[]
}

// Marks a note as a task-consolidation output — one place, so search/filters agree on the spelling.
export const CONSOLIDATED_TAG = 'consolidated'

// The area a root-level file folds into — `README.md` as its own area would fragment the split.
export const AREA_ROOT = '.'
// The monorepo namespaces whose second segment IS the unit of work. Everything else groups by
// its first segment. A heuristic and labelled as one: it mirrors how this repo's area-* notes
// and typecheck projects are already cut, not a universal truth.
const AREA_NAMESPACES = new Set(['packages', 'plugins'])

/** `packages/cli/src/main.ts` → `packages/cli`; `docs/x.md` → `docs`; `README.md` → AREA_ROOT */
export function areaOf(path: string): string {
  const segs = path.split('/').filter(s => s !== '')
  if (segs.length <= 1) return AREA_ROOT
  const head = segs[0] ?? AREA_ROOT
  return AREA_NAMESPACES.has(head) && segs.length >= 3 ? `${head}/${segs[1]}` : head
}

// A grounded task's planning child (`<parent>.plan.<callId>`) never consolidates: its outcome IS
// the plan, already durable as plan-tier notes — a second "execution plan frozen" project note
// per task was exactly the near-duplicate pair the corpus analysis found [measured 2026-08-03].
// STEP_ID.plan is the one spelling of that step id (contracts), the same one the kernel scaffolds.
export const isPlanChild = (taskId: string): boolean => taskId.split('.').includes(STEP_ID.plan)

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
    // Keyed on the task ID, distilled or not — stable + idempotent. NOT the title: two tasks may
    // carry the same one (a re-run, a recurring chore), and keying on it made the second silently
    // OVERWRITE the first task's outcome, since the idempotency key is per-task so both writes land.
    // The human-readable handle is `title` below; an id is only a handle.
    // ponytail: slugId truncates at 64 chars, so a split child (`<uuid>.<step>.<callId>`) keeps only
    // the head of its call id — hash the tail if ids that long ever collide in practice.
    id: slugId(`outcome ${input.taskId}`),
    // promotion is the whole point: an episodic per-task trail becomes ONE semantic project claim
    tier: NOTE_TIER.semantic,
    scope: MemoryScope.project,
    // OUTCOME, not decision: this records what a task did, which is a different question from what
    // the project chose — see the NOTE_KINDS comment for the 42-notes measurement that separated them.
    kind: NOTE_KIND.outcome,
    title: (distilled?.title ?? `Outcome: ${input.taskTitle}`).slice(0, 200),
    summary: (distilled?.summary ?? withSummary[0]?.summary ?? input.taskTitle).slice(0, 500),
    body,
    tags: [CONSOLIDATED_TAG],
    links,
    retention: RETENTION.durable,
  }
}

/**
 * The area-split builder consolidateTask actually uses. One task, one durable outcome — unless
 * its written paths span areas, in which case each area gets its own note anchored to its own
 * paths, cross-linked `relates_to`, sharing body and provenance. DECIDED 2026-08-03: one note
 * citing every touched subsystem is arch-overview's disease — a degree-81 hub that re-drifts on
 * every commit anywhere; the split keeps each note's drift tied to its own area's churn.
 * Single-area tasks keep the legacy taskId-keyed id, so the common case needs no migration.
 */
export function consolidatedNotes(input: ConsolidationInput, distilled?: DistilledText): MemoryNoteDraft[] {
  const byArea = new Map<string, string[]>()
  for (const p of [...new Set(input.paths)].sort()) {
    const area = areaOf(p)
    const bucket = byArea.get(area)
    if (bucket) bucket.push(p)
    else byArea.set(area, [p])
  }
  const base = consolidatedNote(input, distilled)
  if (byArea.size <= 1) {
    const paths = [...byArea.values()][0] ?? []
    // paths stays OMITTED (not []) for a read-only task: an optional field set to undefined is
    // not the same as an empty list at the store boundary, and omission is the honest shape
    return [paths.length > 0 ? { ...base, paths } : base]
  }
  const areas = [...byArea.keys()].sort()
  const idOf = (area: string): string => slugId(`outcome ${input.taskId} ${area}`)
  return areas.map(area => ({
    ...base,
    id: idOf(area),
    title: `${base.title ?? input.taskTitle} — ${area}`.slice(0, 200),
    paths: byArea.get(area) ?? [],
    links: [
      ...(base.links ?? []),
      ...areas.filter(a => a !== area).map(a => ({ id: idOf(a), kind: LINK_KIND.relates_to })),
    ],
  }))
}

// Salience gate for AUTO consolidation: a finished task earns a durable note only if it did real
// work — it engaged existing project knowledge (has provenance to link) OR it was composed of several
// steps. Trivial single-lookups are skipped, so auto-capture grows memory without flooding it. One
// tunable predicate; the manual command bypasses it (force).
export function isSubstantive(input: { steps: StepOutcome[]; derivedFrom: string[] }): boolean {
  return input.derivedFrom.length >= 1 || input.steps.length >= 2
}

// The `executor` a consolidation author names. composeAuthor renders it verbatim as the note's
// createdBy, and TWO composition roots build that author — the lifecycle subscriber in the serve
// runtime and `orc memory consolidate --force` — so a bare literal spelled twice would eventually
// show one operation under two writer names in the vault.
export const CONSOLIDATE_EXECUTOR = 'consolidate'

// What consolidateTask reads from — the memory read model and the event log, nothing from the
// execution kernel: memory-lifecycle work stays in the memory domain. `distill` is the optional LLM
// upgrade, injected by the composition root; absent → extractive.
// `author` is a PARAMETER, not a literal built here: the plugin never invents an author, because
// MemoryAuthor.workspaceId can only be answered by the composition root that knows which checkout
// this process speaks for. It still names the writer through `executor` — see the write below.
export interface ConsolidationDeps { log: EventLog; store: MemoryStore; author: MemoryAuthor; distill?: ConsolidationDistiller }

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

// The one field this fold reads off a write-tool's input — parsed, never cast; extra keys pass.
const FsToolInput = z.object({ path: z.string().min(1) }).loose()
const FS_WRITE_NAMES = new Set<string>(Object.values(FS_WRITE_TOOL_NAME))

// The paths this task itself wrote (fs_write/fs_edit/fs_delete), folded from its own tool_call
// events — the same truth scoped_changes reads, derived here from the log because consolidation
// deliberately owns no kernel dependency. Deletions count: an outcome explaining a removal cites
// the removed path, which restamps clean after the commit and can never drift again.
async function touchedPaths(log: EventLog, taskId: string): Promise<string[]> {
  const out = new Set<string>()
  for (const e of await log.after(0, [EVENT_KIND.tool_call])) {
    if (e.taskId !== taskId) continue
    const p = PAYLOAD_SCHEMAS.tool_call.safeParse(e.payload)
    if (!p.success || !FS_WRITE_NAMES.has(p.data.toolName)) continue
    const input = FsToolInput.safeParse(p.data.input)
    if (input.success) out.add(input.data.path)
  }
  return [...out].sort()
}

// Descendants of `taskId` (child ids are `<parent>.<step>.<callId>`) whose latest status is not
// `done`. Folded from the log rather than a projection: consolidation runs off the same events.
async function unfinishedDescendants(log: EventLog, taskId: string): Promise<string[]> {
  const status = new Map<string, string>()
  for (const e of await log.after(0, [EVENT_KIND.task_status_changed])) {
    const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(e.payload)
    if (p.success && p.data.taskId.startsWith(`${taskId}.`)) status.set(p.data.taskId, p.data.to)
  }
  return [...status.entries()].filter(([, s]) => s !== TASK_STATUS.done).map(([id]) => id)
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
): Promise<MemoryNote[] | null> {
  // the planning child's outcome IS the plan — see isPlanChild; force does not override, because
  // the duplicate it would write is wrong however explicitly it is requested
  if (isPlanChild(taskId)) return null
  const title = await taskTitle(deps.log, taskId)
  if (title === null) return null
  const steps = (await deps.store.list({ scope: planScope(taskId) })).map(n => ({ title: n.title, summary: n.summary }))
  const derivedFrom = await accessedProjectIds(deps.log, taskId)
  if (!opts.force && !isSubstantive({ steps, derivedFrom })) return null
  const input: ConsolidationInput = {
    taskId, taskTitle: title, steps, derivedFrom,
    paths: await touchedPaths(deps.log, taskId),
    unfinished: await unfinishedDescendants(deps.log, taskId),
  }
  // distillation is best-effort — a model hiccup falls back to the extractive note rather than
  // dropping the capture entirely.
  const distilled = deps.distill ? await deps.distill(input).catch(() => null) : null
  const written: MemoryNote[] = []
  for (const draft of consolidatedNotes(input, distilled ?? undefined)) {
    // force (an explicit manual request) always REWRITES; the auto path keys by draft id — the
    // taskId for a single-area note, taskId+area for the split — so a redelivered completion
    // converges on the same events instead of appending duplicates.
    const writeOpts = opts.force ? {} : { idempotencyKey: `consolidate:${taskId}:${draft.id}` }
    // NOT `{source:'cli'}`. 'cli' means a human at a terminal — it is what every packages/cli
    // memory command passes — and claiming it made every outcome note in the vault read
    // `createdBy: cli`, indistinguishable from a note somebody actually typed. Naming the writer
    // through `executor` is the shape mcp-serve.ts already uses for its own door, and composeAuthor
    // renders it as 'consolidate'. Note this only fixes attribution GOING FORWARD: createdBy is
    // sticky across rewrites (deriveNoteProvenance), so notes written before this keep saying 'cli'.
    // The composition root supplies both halves (CONSOLIDATE_EXECUTOR + the workspace) — see
    // ConsolidationDeps.
    written.push(await deps.store.write(draft, deps.author, writeOpts))
  }
  return written
}
