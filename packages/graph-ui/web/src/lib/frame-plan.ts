// The decision sse.ts carries out, apart from EventSource: a frame and the held seq in, a plan out
import type { OperatorState, Touch } from '@orc/ui-core/wire'
import type { Envelope, GraphPatch, LogRow, ProjectEntry } from './api/types'

export interface FramePlan {
  /** the chats-list push this frame carries, independent of seq/regression */
  projects: ProjectEntry[] | null
  /** the pushed operator value this frame carries — NEVER withheld by a regression */
  operator: OperatorState | null
  /** every touch this frame reports — NEVER withheld by a regression */
  touched: Touch[]
  // True when envSeq is BEHIND what is held: graph/ledger fields are withheld and the caller resyncs
  regression: boolean
  /** the seq to hold, or null when this frame names none (an id-less sync/projects-only push) */
  seq: number | null
  patch: GraphPatch | null
  summary: LogRow | null
  /** a patch with no summary means the narrative missed a window — the caller refills it */
  backfill: boolean
}

// The one spelling of "no real last-event-id yet"
export const ID_LESS_SEQ = 0

// A later id-less frame inherits the held last-event-id: no regression, and seq is a no-op
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
