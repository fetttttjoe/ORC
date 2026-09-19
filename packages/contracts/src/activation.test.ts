import { describe, expect, it } from 'bun:test'
import { activation, activationBoost, foldMemory, edgeKey, noteKey, EVENT_KIND, LINK_KIND } from './index'
import { authorFixture } from './fixtures'

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

describe('foldMemory — node access', () => {
  it('counts hits per (scope,id) with the last event ts, skipping unparseable payloads', () => {
    const ev = (id: string, ts: string) => ({ kind: EVENT_KIND.memory_accessed, ts, payload: { id, scope: 'project', mode: 'read', author: authorFixture() } })
    const m = foldMemory([ev('a', T0), ev('a', days(1)), ev('b', T0), { kind: EVENT_KIND.memory_accessed, ts: T0, payload: { junk: true } }]).access
    expect(m.get(noteKey('project', 'a'))).toEqual({ hits: 2, lastAccessedAt: days(1) })
    expect(m.get(noteKey('project', 'b'))).toEqual({ hits: 1, lastAccessedAt: T0 })
    expect(m.size).toBe(2)
  })
})

// The connection-level twin: folds memory_accessed.via into per-edge stats.
describe('foldMemory — edge access', () => {
  it('counts hits per edge key with the last event ts, skipping unparseable and via-less payloads', () => {
    const via = { seed: 'a', kind: LINK_KIND.supersedes, direction: 'out' as const }
    const ev = (ts: string, extra: Record<string, unknown> = {}) =>
      ({ kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'b', scope: 'project', mode: 'read', author: authorFixture(), ...extra } })
    const m = foldMemory([
      ev(T0, { via }),
      ev(days(1), { via }),
      ev(T0), // via-less (a plain node access, or an old pre-provenance event) — node-only, skipped here
      { kind: EVENT_KIND.memory_accessed, ts: T0, payload: { junk: true } }, // unparseable
    ]).edges
    expect(m.get(edgeKey('project', 'a', 'b', 'supersedes'))).toEqual({ hits: 2, lastAccessedAt: days(1) })
    expect(m.size).toBe(1)
  })

  it('canonicalizes both traversal directions of one authored edge onto ONE key', () => {
    // authored edge a -[supersedes]-> b. Walking out from seed a lands on b (direction out, seed a).
    // Walking in from seed b lands on a (direction in, seed b) — the SAME authored edge, opposite hop.
    const outHop = { kind: EVENT_KIND.memory_accessed, ts: T0, payload: { id: 'b', scope: 'project', mode: 'read', author: authorFixture(), via: { seed: 'a', kind: LINK_KIND.supersedes, direction: 'out' } } }
    const inHop = { kind: EVENT_KIND.memory_accessed, ts: days(1), payload: { id: 'a', scope: 'project', mode: 'read', author: authorFixture(), via: { seed: 'b', kind: LINK_KIND.supersedes, direction: 'in' } } }
    const m = foldMemory([outHop, inHop]).edges
    expect(m.size).toBe(1)
    expect(m.get(edgeKey('project', 'a', 'b', 'supersedes'))).toEqual({ hits: 2, lastAccessedAt: days(1) })
  })
})

// One pass, four derivations. They were four separate functions over the same array, which meant
// staleNotes walked a project's whole memory history four times to answer one question.
describe('foldMemory — one pass', () => {
  const note = (id: string, ts: string, retention = 'durable') => ({
    kind: EVENT_KIND.memory_written, ts,
    payload: { note: { id, title: id, retention }, author: authorFixture() },
  })
  const read = (id: string, ts: string) => ({
    kind: EVENT_KIND.memory_accessed, ts,
    payload: { id, scope: 'project', mode: 'read', author: authorFixture() },
  })

  it('derives live notes, write times and access stats from a single walk', () => {
    const m = foldMemory([note('a', T0), read('a', days(1)), note('a', days(2)), note('b', T0)])
    expect([...m.notes.keys()].sort()).toEqual([noteKey('project', 'a'), noteKey('project', 'b')])
    expect(m.writes.get(noteKey('project', 'a'))).toBe(days(2)) // last write wins
    expect(m.access.get(noteKey('project', 'a'))).toEqual({ hits: 1, lastAccessedAt: days(1) })
    expect(m.access.has(noteKey('project', 'b'))).toBe(false)
  })

  it('a deleted note leaves the live set but keeps no write time it no longer has', () => {
    const m = foldMemory([
      note('a', T0),
      { kind: EVENT_KIND.memory_deleted, ts: days(1), payload: { id: 'a', scope: 'project', author: authorFixture() } },
    ])
    expect(m.notes.size).toBe(0)
    expect(m.writes.has(noteKey('project', 'a'))).toBe(false)
  })
})
