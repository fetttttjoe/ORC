import { describe, expect, it } from 'bun:test'
import { ClaimClass, ClaimState, DeliveryMode, type ClaimDrift } from '@orc/contracts'
import { emptyEvidence, EvidenceKind, foldEvidence, type EvidenceEvent } from '@orc/knowledge-core'
import { extensionOf, knowledgeStats, NO_EXTENSION, renderStats } from './knowledge-stats'

const claim = (id: string, anchorPaths: string[], state = ClaimState.clean): ClaimDrift => ({
  claim: { id, text: `claim ${id}`, class: ClaimClass.fact, anchors: anchorPaths.map(path => ({ path, symbol: null })), tags: [], sources: [], decision: null, location: `knowledge/${id}.md` },
  state, basis: null,
  anchors: anchorPaths.map(path => ({ path, symbol: null, basis: null, current: null, readable: true, state })),
})
const evidenceOf = (...events: EvidenceEvent[]) => foldEvidence(emptyEvidence(), events)
const read = (seq: number, run: string | null, path: string): EvidenceEvent => ({ kind: EvidenceKind.read, seq, run, path })
const delivered = (seq: number, run: string | null, ids: string[], mode: string): EvidenceEvent => ({ kind: EvidenceKind.delivered, seq, run, ids, mode })

const drifts = [claim('aaaaaaaa', ['src/a.ts']), claim('bbbbbbbb', ['pkg']), claim('cccccccc', ['src/c.ts'], ClaimState.suspect)]

describe('knowledgeStats', () => {
  it('a file read with no claim is a gap; one under a folder claim alone is folder-covered, not a gap', () => {
    const e = evidenceOf(read(1, 'r1', 'src/a.ts'), read(2, 'r1', 'pkg/inner.ts'), read(3, 'r1', 'lib/x.ts'))
    const { gaps } = knowledgeStats(e, drifts, 15)
    expect(gaps).toEqual({ total: 1, top: [{ path: 'lib/x.ts', runs: 1, reads: 1 }], byExtension: { '.ts': 1 }, folderCovered: 1 })
  })

  it('sorts gaps by runs, then reads, then path, and cuts at top', () => {
    const e = evidenceOf(
      read(1, 'r1', 'z.md'), read(2, 'r2', 'z.md'), read(3, 'r1', 'b.md'), read(4, 'r1', 'b.md'), read(5, 'r1', 'a.md'), read(6, 'r1', 'Makefile'),
    )
    const { gaps } = knowledgeStats(e, [], 3)
    expect(gaps.top.map(g => g.path)).toEqual(['z.md', 'b.md', 'Makefile'])
    expect(gaps).toMatchObject({ total: 4, byExtension: { '.md': 3, [NO_EXTENSION]: 1 } })
  })

  it('ranks hot claims and hot anchor paths by deliveries and counts deliveries by mode', () => {
    const e = evidenceOf(
      delivered(1, 'r1', ['aaaaaaaa', 'cccccccc'], DeliveryMode.push), delivered(2, 'r2', ['aaaaaaaa'], DeliveryMode.card), delivered(3, null, ['aaaaaaaa'], DeliveryMode.card),
    )
    const s = knowledgeStats(e, drifts, 15)
    expect(s.hotClaims).toEqual([
      { id: 'aaaaaaaa', claimDeliveries: 3, location: 'knowledge/aaaaaaaa.md' },
      { id: 'cccccccc', claimDeliveries: 1, location: 'knowledge/cccccccc.md' },
    ])
    expect(s.hotAnchorPaths).toEqual([{ path: 'src/a.ts', claimDeliveries: 3 }, { path: 'src/c.ts', claimDeliveries: 1 }])
    expect(s.claimDeliveries).toEqual({ total: 4, distinctClaims: 2, byMode: { [DeliveryMode.push]: 2, [DeliveryMode.card]: 2 } })
    expect(s.corpus).toEqual({ clean: 2, suspect: 1, unknown: 0, unanchored: 0 })
  })

  it('summarises anchor reads after a delivery by mode, counts retired-after-delivery and verdicts', () => {
    const e = evidenceOf(
      delivered(1, 'r1', ['aaaaaaaa'], DeliveryMode.push), read(2, 'r1', 'src/a.ts'),
      delivered(3, 'r2', ['cccccccc'], DeliveryMode.card),
      { kind: EvidenceKind.retired, seq: 4, run: null, id: 'cccccccc' },
      { kind: EvidenceKind.checked, seq: 5, run: null, id: 'aaaaaaaa', text: 't', verdict: 'holds', accepts: true, anchors: [] },
    )
    const s = knowledgeStats(e, drifts, 15)
    expect(s.runDeliveryEvents).toEqual({
      events: 2, claimDeliveries: 2, followedByAnchorRead: 1,
      byMode: { [DeliveryMode.push]: { deliveryEvents: 1, followedByAnchorRead: 1 }, [DeliveryMode.card]: { deliveryEvents: 1, followedByAnchorRead: 0 } },
    })
    expect(s.retiredAfterDelivery).toBe(1)
    expect(s.verdicts).toEqual({ holds: 1 })
  })

  it('renders every section, with dashes for empty lists', () => {
    const lines = renderStats(knowledgeStats(emptyEvidence(), drifts, 15))
    expect(lines).toEqual([
      'claims: clean 2 · suspect 1 · unknown 0 · unanchored 0',
      'claim-deliveries: 0 to 0 claims (-)',
      'delivery events in runs: 0 carrying 0 claim-deliveries',
      'hot claims (claim-deliveries):', '  -',
      'hot anchor paths (claim-deliveries):', '  -',
      'claims retired after delivery: 0',
      'delivery events in runs followed by an anchor read: 0/0 (-)',
      'check verdicts: -',
      'gaps: 0 files read with no claim (0 covered by a folder claim alone)',
      'gap extensions: -',
    ])
  })
})

describe('units', () => {
  it('one delivery event carrying several ids is several claim-deliveries but one event, and both are reported', () => {
    const e = evidenceOf(delivered(1, 'r1', ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'], DeliveryMode.preload), delivered(2, null, ['aaaaaaaa'], DeliveryMode.card))
    const s = knowledgeStats(e, drifts, 15)
    expect(s.claimDeliveries).toEqual({ total: 4, distinctClaims: 3, byMode: { [DeliveryMode.preload]: 3, [DeliveryMode.card]: 1 } })
    expect(s.runDeliveryEvents).toMatchObject({ events: 1, claimDeliveries: 3, byMode: { [DeliveryMode.preload]: { deliveryEvents: 1 } } })
  })
  it('a delivered claim that left the corpus stays in the hot list, marked, so hot claims and distinctClaims agree', () => {
    const e = evidenceOf(delivered(1, 'r1', ['gone0000', 'aaaaaaaa'], DeliveryMode.card), delivered(2, 'r1', ['gone0000'], DeliveryMode.card))
    const s = knowledgeStats(e, drifts, 15)
    expect(s.hotClaims).toEqual([{ id: 'gone0000', claimDeliveries: 2, location: null }, { id: 'aaaaaaaa', claimDeliveries: 1, location: 'knowledge/aaaaaaaa.md' }])
    expect(s.claimDeliveries.distinctClaims).toBe(s.hotClaims.length)
  })
})

describe('extensionOf', () => {
  it('takes the last dot of the file name, and none for a dotfile or a bare name', () => {
    expect([extensionOf('a/b.test.ts'), extensionOf('.gitignore'), extensionOf('a.d/Makefile')]).toEqual(['.ts', NO_EXTENSION, NO_EXTENSION])
  })
})
