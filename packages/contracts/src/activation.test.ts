import { describe, expect, it } from 'bun:test'
import { activation, activationBoost, foldAccessCounts, foldEdgeStats, edgeKey, noteKey, EVENT_KIND } from './index'

const T0 = '2026-07-01T00:00:00.000Z'
const days = (n: number) => new Date(Date.parse(T0) + n * 86_400_000).toISOString()

describe('activation', () => {
  it('is 0 for never-accessed notes (no hits, or no timestamp)', () => {
    expect(activation({ hits: 0, lastAccessedAt: null }, T0, 14)).toBe(0)
    expect(activation({ hits: 0, lastAccessedAt: T0 }, T0, 14)).toBe(0)
    expect(activation({ hits: 3, lastAccessedAt: null }, T0, 14)).toBe(0)
  })
  it('halves per half-life and never goes negative with clock skew', () => {
    expect(activation({ hits: 8, lastAccessedAt: T0 }, days(14), 14)).toBeCloseTo(4)
    expect(activation({ hits: 8, lastAccessedAt: T0 }, days(28), 14)).toBeCloseTo(2)
    expect(activation({ hits: 8, lastAccessedAt: days(1) }, T0, 14)).toBeCloseTo(8) // future timestamp clamps to age 0
  })
  it('re-access lifts a decayed note (the learning loop)', () => {
    const cold = activation({ hits: 5, lastAccessedAt: T0 }, days(30), 14)
    const rewarmed = activation({ hits: 6, lastAccessedAt: days(30) }, days(30), 14) // one more hit, just now
    expect(rewarmed).toBeGreaterThan(cold)
  })
})

describe('activationBoost', () => {
  it('is exactly 1 at zero activation — ranks, never filters', () => {
    expect(activationBoost(0)).toBe(1)
  })
  it('grows monotonically but log-damped', () => {
    expect(activationBoost(10)).toBeGreaterThan(activationBoost(1))
    expect(activationBoost(100)).toBeLessThan(3) // damped: hot ≠ runaway
  })
})

describe('foldAccessCounts', () => {
  it('counts hits per (scope,id) with the last event ts, skipping unparseable payloads', () => {
    const ev = (id: string, ts: string) => ({ kind: EVENT_KIND.memory_accessed, ts, payload: { id, scope: 'project', mode: 'read', author: { source: 'cli' } } })
    const m = foldAccessCounts([ev('a', T0), ev('a', days(1)), ev('b', T0), { kind: EVENT_KIND.memory_accessed, ts: T0, payload: { junk: true } }])
    expect(m.get(noteKey('project', 'a'))).toEqual({ hits: 2, lastAccessedAt: days(1) })
    expect(m.get(noteKey('project', 'b'))).toEqual({ hits: 1, lastAccessedAt: T0 })
    expect(m.size).toBe(2)
  })
})

// The connection-level twin of foldAccessCounts: folds memory_accessed.via into per-edge stats.
describe('foldEdgeStats', () => {
  it('counts hits per edge key with the last event ts, skipping unparseable and via-less payloads', () => {
    const via = { seed: 'a', kind: 'supersedes', direction: 'out' as const }
    const ev = (ts: string, extra: Record<string, unknown> = {}) =>
      ({ kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'b', scope: 'project', mode: 'read', author: { source: 'cli' }, ...extra } })
    const m = foldEdgeStats([
      ev(T0, { via }),
      ev(days(1), { via }),
      ev(T0), // via-less (a plain node access, or an old pre-provenance event) — node-only, skipped here
      { kind: EVENT_KIND.memory_accessed, ts: T0, payload: { junk: true } }, // unparseable
    ])
    expect(m.get(edgeKey('project', 'a', 'b', 'supersedes'))).toEqual({ hits: 2, lastAccessedAt: days(1) })
    expect(m.size).toBe(1)
  })

  it('canonicalizes both traversal directions of one authored edge onto ONE key', () => {
    // authored edge a -[supersedes]-> b. Walking out from seed a lands on b (direction out, seed a).
    // Walking in from seed b lands on a (direction in, seed b) — the SAME authored edge, opposite hop.
    const outHop = { kind: EVENT_KIND.memory_accessed, ts: T0, payload: { id: 'b', scope: 'project', mode: 'read', author: { source: 'cli' }, via: { seed: 'a', kind: 'supersedes', direction: 'out' } } }
    const inHop = { kind: EVENT_KIND.memory_accessed, ts: days(1), payload: { id: 'a', scope: 'project', mode: 'read', author: { source: 'cli' }, via: { seed: 'b', kind: 'supersedes', direction: 'in' } } }
    const m = foldEdgeStats([outHop, inHop])
    expect(m.size).toBe(1)
    expect(m.get(edgeKey('project', 'a', 'b', 'supersedes'))).toEqual({ hits: 2, lastAccessedAt: days(1) })
  })
})
