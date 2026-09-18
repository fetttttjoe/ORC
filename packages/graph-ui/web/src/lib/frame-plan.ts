// The decision sse.ts's EventSource handler carries out, isolated from the EventSource itself: no
// connection, no query client, no store — a frame and the seq already held in, a plan of what to
// apply out. Not import-free (it takes the wire's own shapes, never a capability), the same
// deliberate choice open-questions.ts/feedback-open.ts make for the same reason: hand-spelling a
// field name off an untyped frame here would be exactly the kind of second spelling this repo's
// zod-everywhere rule exists to prevent.
import type { OperatorState, Touch } from '@orc/ui-core/wire'
import type { Envelope, GraphPatch, LogRow, ProjectEntry } from './api/types'

export interface FramePlan {
  /** the chats-list push this frame carries, independent of seq/regression */
  projects: ProjectEntry[] | null
  /** the pushed operator value this frame carries — NEVER withheld by a regression */
  operator: OperatorState | null
  /** every touch this frame reports — NEVER withheld by a regression */
  touched: Touch[]
  /**
   * True when `envSeq` names a point BEHIND what is already held — the log was reset out-of-band.
   * Everything below that describes the GRAPH/ledger (`seq`, `patch`, `summary`, `backfill`) is
   * withheld when this is true: each describes a moment the client has already moved past, and
   * applying it would show stale state as current. The caller resyncs from a fresh snapshot
   * instead of applying any of them.
   */
  regression: boolean
  /** the seq to hold, or null when this frame names none (an id-less sync/projects-only push) */
  seq: number | null
  patch: GraphPatch | null
  summary: LogRow | null
  /** a patch with no summary means the narrative missed a window — the caller refills it */
  backfill: boolean
}

// The one spelling of "no real last-event-id yet" — sse.ts's only caller of `planFrame` and this
// function's own formula below both compare against this, rather than each hand-spelling `0`.
export const ID_LESS_SEQ = 0

/**
 * `envSeq === ID_LESS_SEQ` is TRUE on the very first message of a fresh `EventSource` (a browser's
 * last-event-id buffer starts empty, and `Number('') || ID_LESS_SEQ` is `ID_LESS_SEQ`) — the
 * connect-time sync or the chats-list push, before any id-bearing frame has arrived.
 *
 * It is NOT how sse.ts tells an id-less frame apart from an id-bearing one in general: the SSE
 * spec's last-event-id buffer persists across id-less messages, updated only by an `id:` line
 * (even an empty one resets it) — server.ts's `sync` write deliberately sends no `id:` line at all
 * (its own comment: must never advance the browser's Last-Event-ID resume cursor), which also
 * means it never RESETS that buffer either. So a LATER id-less frame's `ev.lastEventId` instead
 * carries the last id-bearing frame's value, not `ID_LESS_SEQ` — sse.ts is never asked to tell the
 * two cases apart, and does not try to.
 *
 * Traced why that is still safe: by the time a later id-less frame arrives, `heldSeq` already
 * equals that same inherited value (this file's caller moved it there when the id-bearing frame
 * landed) — so `regression` reads false (`envSeq` equals, never trails, `heldSeq`) and `seq`
 * re-assigns the value already held, a no-op rather than a correctness dependency on `0`.
 */
export function planFrame(heldSeq: number, envSeq: number, env: Envelope): FramePlan {
  const regression = envSeq !== ID_LESS_SEQ && envSeq < heldSeq
  return {
    projects: env.projects ?? null,
    operator: env.operator,
    touched: env.touched,
    regression,
    seq: regression || envSeq === ID_LESS_SEQ ? null : envSeq,
    patch: regression ? null : (env.patch ?? null),
    summary: regression ? null : (env.summary ?? null),
    backfill: !regression && Boolean(env.patch) && !env.summary,
  }
}
