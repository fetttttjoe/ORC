import { EVENT_KIND, PAYLOAD_SCHEMAS, TASK_STATUS, errorMessage, type EventRecord } from '@orc/contracts'
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
  } catch (err) {
    console.warn(`memory lifecycle: consolidate '${taskId}' failed:`, errorMessage(err))
  }
}

export function createMemoryLifecycle(deps: LifecycleDeps): MemoryLifecycle {
  let unsub: (() => Promise<void>) | null = null
  let inflight: Promise<void> = Promise.resolve()
  // subscribe delivers events losslessly and awaits the handler (the cursor advances only on
  // success), so consolidating INLINE serializes naturally. `inflight` is tracked so close() drains
  // a consolidation still running at shutdown.
  const handle = async (e: EventRecord): Promise<void> => {
    inflight = consolidateOnCompletion(deps, e)
    await inflight
  }
  return {
    // fromSeq defaults to the latest seq → react only to LIVE completions, never re-consolidate the
    // backlog on every startup (the manual `orc memory consolidate` covers historical tasks).
    start: async () => { unsub = await deps.log.subscribe({}, handle) },
    close: async () => { if (unsub) { await unsub(); unsub = null } await inflight },
  }
}
