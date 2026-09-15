// How long ago a stamp was, for a human reading a table. Pure — `now` is a PARAMETER, so the
// rendering is testable without freezing a clock, and two rows of one listing can never straddle a
// tick and disagree about "today".
//
// Its own file because it is the only clock-shaped thing on the CLI's read path and nothing else in
// ws-commands.ts has a reason to know about milliseconds. There was no relative-time helper in the
// CLI before this; if a second surface needs one, this is the one to extend rather than re-spell.

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// What an age we cannot compute prints as. NOT '0m ago', which would claim the thing just happened.
export const AGE_UNKNOWN = '-'

/**
 * `3d ago` / `2h ago` / `58m ago` — the coarsest unit that is not zero, floored.
 *
 * Coarse on purpose: this is read next to a workspace's state, where the question is "has anyone
 * touched this checkout lately", not "how many seconds". No threshold is applied anywhere — the age
 * is printed and the human decides what is stale.
 */
export function relativeAge(iso: string, now: Date): string {
  const then = Date.parse(iso)
  // A stamp we cannot read must not print 'NaNd ago' — the event log's own stamps always parse, so
  // this is a hand-edited or foreign record and the honest answer is that we do not know.
  if (Number.isNaN(then)) return AGE_UNKNOWN
  // Clamped at zero: a stamp in the future is clock skew between the machine that wrote the event
  // and the one printing it, and '-3h ago' reads as a corrupted record rather than as two clocks
  // disagreeing.
  const ms = Math.max(0, now.getTime() - then)
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d ago`
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h ago`
  return `${Math.floor(ms / MINUTE_MS)}m ago`
}
