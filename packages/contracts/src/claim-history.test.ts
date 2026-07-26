import { describe, expect, it } from 'bun:test'
import { claimHistory, claimId, type ClaimInput } from './claim'

const c = (text: string, rev: string | null = null): ClaimInput => ({ id: claimId(text), text, sourceRevision: rev })
const ev = (ts: string, claims: ClaimInput[], invalidates: string[] = []) => ({ ts, claims, invalidates })

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

  // the log is the truth: if it says the claim came back, reporting it dead would contradict search
  it('a claim re-added after retirement is live again, keeping its original validFrom', () => {
    const h = claimHistory([
      ev('t1', [c('flip')]),
      ev('t2', [], [claimId('flip')]),
      ev('t3', [c('flip')]),
    ])
    expect(h[0]).toMatchObject({ validFrom: 't1', invalidatedAt: null })
  })

  it('a tombstone for a claim this log never carried is ignored, never invented', () => {
    expect(claimHistory([ev('t1', [], ['deadbeef0000'])])).toEqual([])
  })

  it('carries the latest text and revision forward for a surviving claim', () => {
    const h = claimHistory([ev('t1', [c('x', 'old')]), ev('t2', [c('x', 'new')])])
    expect(h[0]).toMatchObject({ sourceRevision: 'new', validFrom: 't1' })
  })
})
