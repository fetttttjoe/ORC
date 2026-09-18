import { describe, expect, it } from 'bun:test'
import type { Clock } from './touch-coalesce'
import { makeCoalescer } from './touch-coalesce'

/** a fake clock a test steps by hand — nothing here ever waits on real time */
function fakeClock(): Clock & { fireAll(): void; pendingCount(): number } {
  let nextId = 0
  const timers = new Map<number, () => void>()
  return {
    setTimeout(fn, _ms) {
      const id = ++nextId
      timers.set(id, fn)
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    fireAll() {
      const due = [...timers.values()]
      timers.clear()
      for (const fn of due) fn()
    },
    pendingCount: () => timers.size,
  }
}

describe('makeCoalescer', () => {
  it('collapses a burst on the same key into one trailing call', () => {
    const clock = fakeClock()
    const coalescer = makeCoalescer(clock, 250)
    const fired: string[] = []
    coalescer.schedule('k', () => fired.push('first'))
    coalescer.schedule('k', () => fired.push('second'))
    coalescer.schedule('k', () => fired.push('third'))
    // only the LAST schedule's timer should still be pending — the earlier two were cancelled
    expect(clock.pendingCount()).toBe(1)
    clock.fireAll()
    expect(fired).toEqual(['third'])
  })

  it('fires each distinct key independently', () => {
    const clock = fakeClock()
    const coalescer = makeCoalescer(clock, 250)
    const fired: string[] = []
    coalescer.schedule('a', () => fired.push('a'))
    coalescer.schedule('b', () => fired.push('b'))
    clock.fireAll()
    expect(fired.sort()).toEqual(['a', 'b'])
  })

  it('a key fired once can be scheduled again afterwards', () => {
    const clock = fakeClock()
    const coalescer = makeCoalescer(clock, 250)
    const fired: string[] = []
    coalescer.schedule('k', () => fired.push('first'))
    clock.fireAll()
    coalescer.schedule('k', () => fired.push('second'))
    clock.fireAll()
    expect(fired).toEqual(['first', 'second'])
  })
})
