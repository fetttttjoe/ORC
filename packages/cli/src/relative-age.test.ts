import { describe, expect, it } from 'bun:test'
import { relativeAge } from './relative-age'

const NOW = new Date('2026-09-14T12:00:00.000Z')

describe('relativeAge', () => {
  it('reads in the coarsest unit that is not zero — days, then hours, then minutes', () => {
    expect(relativeAge('2026-09-11T12:00:00.000Z', NOW)).toBe('3d ago')
    expect(relativeAge('2026-09-14T09:30:00.000Z', NOW)).toBe('2h ago')
    expect(relativeAge('2026-09-14T11:59:10.000Z', NOW)).toBe('0m ago')
    // the boundaries, floored: 47h is not 2d, and 59m is not 1h
    expect(relativeAge('2026-09-12T13:00:00.000Z', NOW)).toBe('1d ago')
    expect(relativeAge('2026-09-14T11:01:00.000Z', NOW)).toBe('59m ago')
  })

  it('a stamp in the future reads as 0m, never a negative age', () => {
    // clock skew between the machine that wrote the event and the one printing it. A '-3h ago'
    // in the ws table would read as a corrupted record rather than as the two clocks disagreeing.
    expect(relativeAge('2026-09-14T15:00:00.000Z', NOW)).toBe('0m ago')
  })

  it('an unreadable stamp reads as unknown, never NaN', () => {
    expect(relativeAge('not a date', NOW)).toBe('-')
    expect(relativeAge('', NOW)).toBe('-')
  })
})
