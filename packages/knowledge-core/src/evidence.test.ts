import { describe, expect, it } from 'bun:test'
import { CheckVerdict, DeliveryMode, underEntity } from '@orc/contracts'
import { anchorEvidence, anchorKey, anchorReadsAfterDelivery, emptyEvidence, EvidenceKind, foldEvidence, type EvidenceEvent } from './evidence'

const delivered = (seq: number, run: string | null, ids: string[], mode: DeliveryMode = DeliveryMode.card): EvidenceEvent => ({ kind: EvidenceKind.delivered, seq, run, ids, mode })
const read = (seq: number, run: string | null, path: string): EvidenceEvent => ({ kind: EvidenceKind.read, seq, run, path })
const retired = (seq: number, id: string): EvidenceEvent => ({ kind: EvidenceKind.retired, seq, run: null, id })
const ALPHA = { path: 'src/a.ts', symbol: 'alpha' }

const timeline: EvidenceEvent[] = [
  { kind: EvidenceKind.asserted, seq: 1, run: 'r1', id: 'a', text: 'A', anchors: [{ ...ALPHA, digest: 'd1' }, { path: 'src/b.ts', symbol: null, digest: null }] },
  delivered(2, 'r1', ['a', 'b']),
  read(3, 'r1', 'src/a.ts'),
  { kind: EvidenceKind.checked, seq: 4, run: null, id: 'a', text: 'A', verdict: CheckVerdict.holds, accepts: true, anchors: [{ ...ALPHA, digest: 'd2' }] },
  { kind: EvidenceKind.checked, seq: 5, run: null, id: 'b', text: 'B', verdict: CheckVerdict.unknown, accepts: false, anchors: [{ path: 'src/b.ts', symbol: null, digest: 'd3' }] },
  delivered(6, 'r2', ['a'], DeliveryMode.search),
  retired(7, 'b'),
  read(8, null, 'src/b.ts'),
  read(9, 'r2', 'src/a.ts'),
]

describe('foldEvidence', () => {
  it('folds deliveries, assertions, retires, checks and reads into claims, anchor keys, runs and paths', () => {
    const e = foldEvidence(emptyEvidence(), timeline)
    expect(e.cursor).toBe(9)
    expect([...e.claims]).toEqual([
      ['a', { deliveries: 2, lastDeliveredSeq: 6, modes: { [DeliveryMode.card]: 1, [DeliveryMode.search]: 1 }, retiredAfterDelivery: false, verdicts: { [CheckVerdict.holds]: 1 } }],
      ['b', { deliveries: 1, lastDeliveredSeq: 2, modes: { [DeliveryMode.card]: 1 }, retiredAfterDelivery: true, verdicts: { [CheckVerdict.unknown]: 1 } }],
    ])
    expect([...e.anchors]).toEqual([[anchorKey('a', 'A', ALPHA.path, ALPHA.symbol), { asserted: ['d1'], held: ['d2'] }]])
    expect([...e.runs]).toEqual([
      ['r1', { delivered: [{ seq: 2, ids: ['a', 'b'], mode: DeliveryMode.card }], reads: [{ seq: 3, path: 'src/a.ts' }] }],
      ['r2', { delivered: [{ seq: 6, ids: ['a'], mode: DeliveryMode.search }], reads: [{ seq: 9, path: 'src/a.ts' }] }],
    ])
    expect([...e.paths]).toEqual([['src/a.ts', { reads: 2, runs: new Set(['r1', 'r2']) }], ['src/b.ts', { reads: 1, runs: new Set() }]])
  })

  it('an assertion and a holds check for one key land in asserted and held, and only that key answers', () => {
    const e = foldEvidence(emptyEvidence(), timeline)
    expect(anchorEvidence(e, 'a', 'A', ALPHA.path, ALPHA.symbol)).toEqual({ asserted: ['d1'], held: ['d2'] })
    expect(anchorEvidence(e, 'a', 'A changed', ALPHA.path, ALPHA.symbol)).toEqual({ asserted: [], held: [] })
    expect(anchorEvidence(e, 'b', 'B', 'src/b.ts', null)).toEqual({ asserted: [], held: [] })
  })

  it('a retire before any delivery is not a retire after delivery', () => {
    const e = foldEvidence(emptyEvidence(), [
      { kind: EvidenceKind.checked, seq: 1, run: null, id: 'a', text: 'A', verdict: CheckVerdict.false, accepts: false, anchors: [] },
      retired(2, 'a'), delivered(3, 'r1', ['a']),
    ])
    expect(e.claims.get('a')?.retiredAfterDelivery).toBe(false)
  })

  it('folding in two batches leaves the same evidence as folding once', () => {
    const once = foldEvidence(emptyEvidence(), timeline)
    const twice = foldEvidence(foldEvidence(emptyEvidence(), timeline.slice(0, 4)), timeline.slice(4))
    expect(twice).toEqual(once)
  })
})

describe('anchorReadsAfterDelivery', () => {
  const paths: Record<string, readonly string[]> = { a: ['src/a.ts'], b: ['pkg'], c: ['src/c.ts'] }
  const anchorPathsOf = (id: string): readonly string[] | null => paths[id] ?? null
  const reaches = (path: string, anchorPath: string): boolean => underEntity(anchorPath, path)

  it('counts a delivery once when its run later reads any delivered claim\'s anchor path, a directory anchor by a path under it', () => {
    const e = foldEvidence(emptyEvidence(), [
      delivered(1, 'r1', ['a', 'b']), read(2, 'r1', 'src/a.ts'), read(3, 'r1', 'pkg/src/c.ts'),
      delivered(4, 'r2', ['b'], DeliveryMode.search), read(5, 'r2', 'pkg/src/c.ts'),
      delivered(6, 'r3', ['c', 'gone'], DeliveryMode.search), read(7, 'r3', 'src/a.ts'),
    ])
    expect(anchorReadsAfterDelivery(e, anchorPathsOf, reaches)).toEqual({
      deliveries: 3, followedByAnchorRead: 2,
      byMode: { [DeliveryMode.card]: { deliveries: 1, followedByAnchorRead: 1 }, [DeliveryMode.search]: { deliveries: 2, followedByAnchorRead: 1 } },
    })
  })

  it('a read before the delivery, in another run, or of a sibling with the anchor\'s prefix does not count, and a delivery outside a run is not one', () => {
    const e = foldEvidence(emptyEvidence(), [
      read(1, 'r1', 'src/a.ts'), delivered(2, 'r1', ['a']),
      delivered(3, 'r2', ['a']), read(4, 'r3', 'src/a.ts'),
      delivered(5, 'r4', ['b']), read(6, 'r4', 'pkg-other/x.ts'),
      delivered(7, null, ['a']), read(8, null, 'src/a.ts'),
    ])
    expect(anchorReadsAfterDelivery(e, anchorPathsOf, reaches)).toEqual({ deliveries: 3, followedByAnchorRead: 0, byMode: { [DeliveryMode.card]: { deliveries: 3, followedByAnchorRead: 0 } } })
  })

  it('asks the injected rule whether a read reaches an anchor, and counts none when it never does', () => {
    const e = foldEvidence(emptyEvidence(), [delivered(1, 'r1', ['a']), read(2, 'r1', 'src/a.ts')])
    expect(anchorReadsAfterDelivery(e, anchorPathsOf, () => false).followedByAnchorRead).toBe(0)
    expect(anchorReadsAfterDelivery(e, anchorPathsOf, reaches).followedByAnchorRead).toBe(1)
  })
})
