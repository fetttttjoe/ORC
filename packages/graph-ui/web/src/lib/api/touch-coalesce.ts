// Zero imports on purpose: pure over an injected clock, so the window is tested without waiting

/** the two setTimeout primitives this file needs — injected so a test can fake time */
export interface Clock {
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(id: number): void
}

// One trailing call per key, windowMs after the LAST schedule: a burst becomes one round trip
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
