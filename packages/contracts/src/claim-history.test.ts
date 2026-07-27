import { describe, expect, it } from 'bun:test'
import { claimHistory, claimId, type ClaimInput } from './claim'

const c = (text: string, rev: string | null = null): ClaimInput => ({ id: claimId(text), text, sourceRevision: rev })
const ev = (ts: string, claims: ClaimInput[], invalidates: string[] = []) => ({ ts, claims, invalidates })
// what the caller feeds for a memory_deleted: the note went, and its claim rows went with it
const del = (ts: string) => ({ ts, claims: [], invalidates: [], deleted: true })

describe('claimHistory', () => {
  it('dates each claim by the write that FIRST carried it, not the latest', () => {
    const h = claimHistory([
      ev('t1', [c('first')]),
      ev('t2', [c('first'), c('second')]),
    ])
    expect(h.find(e => e.text === 'first')?.validFrom).toBe('t1')
    expect(h.find(e => e.text === 'second')?.validFrom).toBe('t2')
  })

  it('surfaces a retired claim WITH the write that retired it — the note payload cannot', () => {
    const h = claimHistory([
      ev('t1', [c('retire me')]),
      ev('t2', [], [claimId('retire me')]),
    ])
    expect(h).toHaveLength(1)
    expect(h[0]).toMatchObject({ text: 'retire me', validFrom: 't1', invalidatedAt: 't2' })
  })

  it('a live claim has no tombstone', () => {
    expect(claimHistory([ev('t1', [c('alive')])])[0]?.invalidatedAt).toBeNull()
  })

  // The log is the truth: if it says the claim came back, reporting it dead would contradict search.
  // And the revival starts a NEW validity stretch — the projector DELETED the claim's row when it
  // left the live set, so the read model dates the re-add from t3. This fold has to agree: one field
  // cannot answer two ways on two surfaces. The t1→t2 stretch is still in the log for anyone
  // folding it; it is simply not what validFrom reports.
  it('a claim re-added after retirement is live again, dated by the write that brought it back', () => {
    const h = claimHistory([
      ev('t1', [c('flip')]),
      ev('t2', [], [claimId('flip')]),
      ev('t3', [c('flip')]),
    ])
    expect(h[0]).toMatchObject({ validFrom: 't3', invalidatedAt: null })
  })

  // and a claim that never LEFT the live set keeps its first sighting — a re-statement is not a revival
  it('a claim restated without ever being retired keeps its original validFrom', () => {
    const h = claimHistory([ev('t1', [c('steady')]), ev('t2', [c('steady')]), ev('t3', [c('steady')])])
    expect(h[0]).toMatchObject({ validFrom: 't1', invalidatedAt: null })
  })

  // Deleting the note drops its claim rows in the projector, so a fold that only watched
  // `invalidates` reported those claims live while every read surface had lost them — the same
  // one-field-two-answers split the revival rule above exists to close.
  it('deleting the note retires its live claims, dated by the deletion', () => {
    const h = claimHistory([ev('t1', [c('gone with the note')]), del('t2')])
    expect(h[0]).toMatchObject({ validFrom: 't1', invalidatedAt: 't2' })
  })

  it('re-creating the note after a deletion opens a fresh stretch, like any other revival', () => {
    const h = claimHistory([ev('t1', [c('back again')]), del('t2'), ev('t3', [c('back again')])])
    expect(h[0]).toMatchObject({ validFrom: 't3', invalidatedAt: null })
  })

  it('a deletion cannot resurrect a tombstone date — an already-retired claim keeps its own', () => {
    const h = claimHistory([ev('t1', [c('retired first')]), ev('t2', [], [claimId('retired first')]), del('t3')])
    expect(h[0]).toMatchObject({ invalidatedAt: 't2' })
  })

  it('a tombstone for a claim this log never carried is ignored, never invented', () => {
    expect(claimHistory([ev('t1', [], ['deadbeef0000'])])).toEqual([])
  })

  it('carries the latest text and revision forward for a surviving claim', () => {
    const h = claimHistory([ev('t1', [c('x', 'old')]), ev('t2', [c('x', 'new')])])
    expect(h[0]).toMatchObject({ sourceRevision: 'new', validFrom: 't1' })
  })
})
