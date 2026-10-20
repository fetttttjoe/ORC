// pure: `now` is a parameter, so rendering is testable and rows of one listing agree on today

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

// What an age we cannot compute prints as. NOT '0m ago', which would claim the thing just happened.
export const AGE_UNKNOWN = '-'

/** `3d ago` / `2h ago` / `58m ago`: the coarsest non-zero unit, floored; no staleness threshold. */
export function relativeAge(iso: string, now: Date): string {
  const then = Date.parse(iso)
  // an unreadable timestamp prints as unknown, never 'NaNd ago'
  if (Number.isNaN(then)) return AGE_UNKNOWN
  // clamped at zero: a future timestamp is clock skew, and '-3h ago' reads as a corrupted record
  const ms = Math.max(0, now.getTime() - then)
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d ago`
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h ago`
  return `${Math.floor(ms / MINUTE_MS)}m ago`
}
