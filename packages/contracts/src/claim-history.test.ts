import { describe, expect, it } from 'bun:test'
import { claimHistory, claimId, type ClaimEvent, type ClaimInput } from './claim'
import { authorFixture, claimFixture } from './fixtures'

const c = (text: string, rev: string | null = null): ClaimInput => claimFixture(text, { sourceRevision: rev })
const ev = (
  seq: number, ts: string, claims: ClaimInput[], invalidates: string[] = [],
  act: { why?: string; decision?: string } = {},
): ClaimEvent => ({
  seq, ts, author: authorFixture(), sourceRevision: null,
  why: act.why ?? null, decision: act.decision ?? null,
  claims, invalidates, deleted: false,
})
// what the caller feeds for a memory_deleted: the note went, and its claim rows went with it
const del = (seq: number, ts: string): ClaimEvent => ({
  seq, ts, author: authorFixture(), sourceRevision: null, why: null, decision: null,
  claims: [], invalidates: [], deleted: true,
})

describe('claimHistory', () => {
  it('dates each claim by the write that FIRST carried it, not the latest', () => {
    const h = claimHistory([
      ev(1, 't1', [c('first')]),
      ev(2, 't2', [c('first'), c('second')]),
    ])
    expect(h.find(e => e.text === 'first')?.validFrom).toBe('t1')
    expect(h.find(e => e.text === 'second')?.validFrom).toBe('t2')
  })

  it('surfaces a retired claim WITH the write that retired it — the note payload cannot', () => {
    const h = claimHistory([
      ev(1, 't1', [c('retire me')]),
      ev(2, 't2', [], [claimId('retire me')]),
    ])
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ text: 'retire me', validFrom: 't1', invalidatedAt: 't2' })
  })

  it('a live claim has no tombstone and no retiring act', () => {
    const only = claimHistory([ev(1, 't1', [c('alive')])])[0]
    expect(only?.invalidatedAt).toBeNull()
    expect(only?.retiredBy).toBeNull()
  })

  it('carries the WHY and the decision of the write that retired a claim, and of the one that added it', () => {
    const h = claimHistory([
      ev(1, 't1', [c('X')]),
      ev(2, 't2', [c('Y')], [claimId('X')], { why: 'the walker now follows the barrel', decision: 'follow-the-barrel' }),
    ])
    const x = h.find(i => i.text === 'X')
    const y = h.find(i => i.text === 'Y')
    expect(x?.retiredBy?.why).toBe('the walker now follows the barrel')
    expect(x?.retiredBy?.decision).toBe('follow-the-barrel')
    expect(y?.addedBy.seq).toBe(x?.retiredBy?.seq)
    expect(x?.addedBy.why).toBeNull()
  })

  it('never inherits a why or a decision from an earlier write', () => {
    const h = claimHistory([
      ev(1, 't1', [c('A')], [], { why: 'first reason', decision: 'first-decision' }),
      ev(2, 't2', [c('A'), c('B')]),
    ])
    expect(h.find(i => i.text === 'B')?.addedBy).toMatchObject({ why: null, decision: null })
  })

  // The log is the truth: a claim that came back gets its OWN stretch, so the retired one stays
  // readable with the write that ended it.
  it('a claim re-added after retirement opens a SECOND interval, keeping the first', () => {
    const h = claimHistory([
      ev(1, 't1', [c('flip')]),
      ev(2, 't2', [], [claimId('flip')]),
      ev(3, 't3', [c('flip')]),
    ])
    expect(h).toHaveLength(2)
    expect(h[0]).toMatchObject({ validFrom: 't1', invalidatedAt: 't2' })
    expect(h[1]).toMatchObject({ validFrom: 't3', invalidatedAt: null })
    expect(h[1]?.addedBy.seq).toBe(3)
  })

  // and a claim that never LEFT the live set keeps its first sighting — a re-statement is not a revival
  it('a claim restated without ever being retired keeps its original validFrom', () => {
    const h = claimHistory([ev(1, 't1', [c('steady')]), ev(2, 't2', [c('steady')]), ev(3, 't3', [c('steady')])])
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ validFrom: 't1', invalidatedAt: null })
  })

  it('deleting the note retires its live claims, dated by the deletion, with no why', () => {
    const h = claimHistory([ev(1, 't1', [c('gone with the note')], [], { why: 'because', decision: 'a-decision' }), del(2, 't2')])
    expect(h[0]).toMatchObject({ validFrom: 't1', invalidatedAt: 't2' })
    expect(h[0]?.retiredBy).toMatchObject({ seq: 2, why: null, decision: null })
  })

  it('re-creating the note after a deletion opens a fresh interval', () => {
    const h = claimHistory([ev(1, 't1', [c('back again')]), del(2, 't2'), ev(3, 't3', [c('back again')])])
    expect(h).toHaveLength(2)
    expect(h[1]).toMatchObject({ validFrom: 't3', invalidatedAt: null })
  })

  it('a deletion cannot resurrect a tombstone date — an already-retired claim keeps its own', () => {
    const h = claimHistory([ev(1, 't1', [c('retired first')]), ev(2, 't2', [], [claimId('retired first')]), del(3, 't3')])
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ invalidatedAt: 't2' })
  })

  it('a tombstone for a claim this log never carried is ignored, never invented', () => {
    expect(claimHistory([ev(1, 't1', [], ['deadbeef0000'])])).toEqual([])
  })

  it('carries the latest text and revision forward for a surviving claim', () => {
    const h = claimHistory([ev(1, 't1', [c('x', 'old')]), ev(2, 't2', [c('x', 'new')])])
    expect(h[0]).toMatchObject({ sourceRevision: 'new', validFrom: 't1' })
  })
})
