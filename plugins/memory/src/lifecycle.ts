import { EVENT_KIND, NOTE_TIER, PAYLOAD_SCHEMAS, TASK_STATUS, errorMessage, planScope, type EventRecord } from '@orc/contracts'
import { consolidateTask, type ConsolidationDeps } from './consolidate'

// The memory-lifecycle seam — a subscriber PEER to the projector that runs out-of-band, post-task
// memory maintenance, decoupled from the execution kernel. Its FIRST operation is auto-consolidation
// on task completion; decay/sweep, re-embedding and LLM distillation are future operations that plug
// into the same seam. Consolidation is salience-gated (isSubstantive) so it grows memory, not noise.
export interface MemoryLifecycle { start(): Promise<void>; close(): Promise<void> }

// The task a terminal completion event names, or null for anything else — a pure event classifier,
// so the trigger rule is unit-testable without a live log. Only `done` promotes a task's work to
// durable memory; blocked/failed/cancelled leave their negative knowledge in the failure notes.
export function taskCompletedId(e: EventRecord): string | null {
  if (e.kind !== EVENT_KIND.task_status_changed) return null
  const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(e.payload)
  return p.success && p.data.to === TASK_STATUS.done ? p.data.taskId : null
}

// `catchUp` flushes the read-model projection before a consolidation reads it — consolidateTask
// gathers a task's step notes from the projected note table, which a SEPARATE async projector fills;
// without catching up first, a still-unprojected step note yields a partial note or a wrongly-failed
// salience gate that never re-fires. Optional, so the pure deps stay minimal.
export type LifecycleDeps = ConsolidationDeps & { catchUp?: () => Promise<void> }

// The per-completion action, exported for DETERMINISTIC testing (no live subscription needed): on a
// terminal completion event, catch the projection up, then consolidate. Errors are SWALLOWED
// (logged) so one bad task never wedges the subscription stream, and the write is idempotent so an
// at-least-once redelivery is safe. A non-completion event is a no-op.
export async function consolidateOnCompletion(deps: LifecycleDeps, e: EventRecord): Promise<void> {
  const taskId = taskCompletedId(e)
  if (taskId === null) return
  try {
    await deps.catchUp?.()
    await consolidateTask(deps, taskId)
    // AFTER consolidation, and the order is the guarantee — not the timing. consolidateTask reads
    // this task's step notes out of the projected note table, and archiving deletes those rows.
    // Today a flipped order still happens to work, because setArchivedAll is event-first and the
    // projector has not drained by the time consolidation reads: measured, reversing these two
    // changes nothing observable. That is an accident of projection lag, not a design. One catchUp
    // added between them, or a synchronous projector, and the flipped order silently distils an
    // empty corpus into a note about nothing.
    await retireStepTrail(deps, taskId)
  } catch (err) {
    console.warn(`memory lifecycle: consolidate '${taskId}' failed:`, errorMessage(err))
  }
}

/**
 * Retire the EPISODIC step trail of a task that just finished — and nothing else.
 *
 * Deliberately narrower than what `orc memory recheck --apply` will retire. That door rules on
 * evidence and treats both task-bound tiers alike (archive.ts's TASK_BOUND = plan + episodic); an
 * operator choosing it is making a judgement. This fires on its own, so it may only take what is
 * unambiguously spent: measured on this corpus, the 23 live episodic notes carry ZERO body
 * characters, no rationale and no uncertainty — they are one run's trail, and consolidation has
 * just distilled whatever they were worth into a durable note.
 *
 * The 18 plan-tier notes in the same scopes carry 42,596 characters of body, 12 rationales and 11
 * uncertainty lists — the record of WHY each decomposition looked the way it did, which
 * `orc plan-notes` still reads for a settled task. Automatic housekeeping must not delete a design
 * record to reclaim empty rows, and it costs nothing to keep them: a step's search is confined to
 * its own lane plus project (taskLaneScopes), so another task's plan notes are already invisible.
 *
 * Reversible either way — archiving leaves every revision in the log, and `orc memory restore`
 * brings a note back.
 */
async function retireStepTrail(deps: LifecycleDeps, taskId: string): Promise<void> {
  const scope = planScope(taskId)
  const spent = (await deps.store.list({ scope })).filter(n => n.tier === NOTE_TIER.episodic)
  if (spent.length === 0) return
  // one pass over the log for the whole trail, not one per note. The author is the consolidation
  // author the composition root supplied (ConsolidationDeps) — retiring a trail is the same
  // operation's second half, and this plugin invents no author of its own.
  await deps.store.setArchivedAll(spent.map(n => ({ id: n.id, scope: n.scope })), true, deps.author)
}

// Every task the log says is finished, newest status wins — a pure fold, so "which tasks are done"
// never depends on a projection being caught up.
function completedTaskIds(events: EventRecord[]): string[] {
  const done = new Set<string>()
  for (const e of events) {
    const p = PAYLOAD_SCHEMAS.task_status_changed.safeParse(e.payload)
    if (e.kind !== EVENT_KIND.task_status_changed || !p.success) continue
    if (p.data.to === TASK_STATUS.done) done.add(p.data.taskId)
    else done.delete(p.data.taskId) // re-opened (retry): not finished after all
  }
  return [...done]
}

// Consolidate finished tasks that nobody consolidated. A subscription only sees completions that
// land while it is attached, and there is no supervisor: a run driven by a CLI process that exits
// as the task finishes had its completion observed by nobody, and the consolidation was lost with
// no trace. Catching up on start makes the outcome a function of the log rather than of who
// happened to be listening. Safe to repeat: consolidateTask keys its write by task, so a task that
// already has its note appends nothing.
// ponytail: rescans every finished task at startup — fine for a project's worth of tasks; give the
// lifecycle a persisted cursor if a long history ever makes this slow.
// Not exported: only createMemoryLifecycle's start() below calls it — see memory/src/index.ts's rule
// that a re-export nobody imports is compatibility debt for no consumer.
async function consolidateBacklog(deps: LifecycleDeps): Promise<void> {
  await deps.catchUp?.()
  for (const taskId of completedTaskIds(await deps.log.after(0, [EVENT_KIND.task_status_changed]))) {
    try {
      await consolidateTask(deps, taskId)
    } catch (err) {
      console.warn(`memory lifecycle: backlog consolidate '${taskId}' failed:`, errorMessage(err))
    }
  }
}

/**
 * Tracks every promise handed to it so ONE await drains them all.
 *
 * A single `inflight` slot is not enough: it holds only the most recent work, and the lifecycle has
 * two producers — the backlog pass and the live subscription — that overlap between `subscribe()`
 * returning and the backlog being assigned. A completion arriving in that window had its promise
 * overwritten, so close() returned while its write was still in flight and the store was torn out
 * from under it. Settlement is all the chain records; failures stay the caller's to surface, since
 * the subscriber must still see them to hold its cursor.
 */
export function createDrain(): { track: <T>(work: Promise<T>) => Promise<T>; drain: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve()
  return {
    track: work => {
      chain = chain.then(() => work.then(() => {}, () => {}))
      return work
    },
    drain: () => chain,
  }
}

export function createMemoryLifecycle(deps: LifecycleDeps): MemoryLifecycle {
  let unsub: (() => Promise<void>) | null = null
  const { track, drain } = createDrain()
  // subscribe delivers events losslessly and awaits the handler (the cursor advances only on
  // success), so consolidating INLINE serializes naturally. Every consolidation is tracked so
  // close() drains any still running at shutdown — see createDrain for why one slot was not enough.
  const handle = async (e: EventRecord): Promise<void> => {
    await track(consolidateOnCompletion(deps, e))
  }
  return {
    // Subscribe FIRST, then catch up: a completion landing between the two is seen by the
    // subscription, and one landing before it is caught by the backlog pass — the pair has no gap.
    // fromSeq defaults to the latest seq, so the subscription itself only carries live completions.
    start: async () => {
      unsub = await deps.log.subscribe({}, handle)
      await track(consolidateBacklog(deps))
    },
    close: async () => { if (unsub) { await unsub(); unsub = null } await drain() },
  }
}
