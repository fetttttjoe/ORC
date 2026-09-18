// Zero imports on purpose — the cluster.ts shape: the debounce algorithm is pure over an injected
// clock, so the 250ms window is pinned by a test that never waits 250ms.

/** the two setTimeout primitives this file needs — injected so a test can fake time */
export interface Clock {
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

/**
 * One trailing call per key, `windowMs` after the LAST `schedule()` for that key — never the
 * first. A running step's transcript touches several times a second (every agent-loop event), and
 * firing on the first touch of a burst still leaves the rest of the burst to invalidate the
 * refetch that is already in flight; collapsing to the trailing edge is what turns a burst into one
 * HTTP round trip instead of one per touch.
 */
export function makeCoalescer(clock: Clock, windowMs: number) {
  const pending = new Map<string, number>()
  return {
    schedule(key: string, fire: () => void): void {
      const existing = pending.get(key)
      if (existing !== undefined) clock.clearTimeout(existing)
      pending.set(
        key,
        clock.setTimeout(() => {
          pending.delete(key)
          fire()
        }, windowMs),
      )
    },
  }
}
