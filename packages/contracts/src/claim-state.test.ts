import { describe, expect, it } from 'bun:test'
import { anchorState, ClaimState, claimState, NO_ANCHOR_EVIDENCE, type AnchorEvidence, type AnchorReading } from './claim-state'

const reading = (over: Partial<AnchorReading>): AnchorReading => ({ path: 'src/a.ts', symbol: 'alpha', basis: 'b1', current: 'b1', readable: true, ...over })

describe('anchorState', () => {
  it.each<[string, Partial<AnchorReading>, Partial<AnchorEvidence>, ClaimState]>([
    ['an unreadable anchor is unknown, even when its digests agree', { readable: false }, {}, ClaimState.unknown],
    ['an unreadable anchor is unknown, even when its target is gone', { readable: false, current: null }, {}, ClaimState.unknown],
    ['an unreadable anchor is unknown, even when its writer asserted the digest', { readable: false }, { asserted: ['b1'] }, ClaimState.unknown],
    ['a gone target is suspect', { current: null }, {}, ClaimState.suspect],
    ['a gone target is suspect even when its basis was gone too', { basis: null, current: null }, {}, ClaimState.suspect],
    ['a current digest equal to the basis is clean', {}, {}, ClaimState.clean],
    ['a current digest other than the basis is suspect', { current: 'c2' }, {}, ClaimState.suspect],
    ['a current digest a holds check accepted is clean', { current: 'c2' }, { held: ['c1', 'c2'] }, ClaimState.clean],
    ['a held digest that is not the current one does not clear it', { current: 'c3' }, { held: ['c2'] }, ClaimState.suspect],
    ['a target missing at the basis that exists now is suspect', { basis: null, current: 'c1' }, {}, ClaimState.suspect],
    ['an assertion that does not name the current digest is suspect, even when the basis agrees', {}, { asserted: ['a0'] }, ClaimState.suspect],
    ['an asserted current digest is clean while the basis differs', { current: 'c2' }, { asserted: ['a0', 'c2'] }, ClaimState.clean],
    ['a holds check clears a current digest the assertion does not name', { current: 'c2' }, { asserted: ['a0'], held: ['c2'] }, ClaimState.clean],
  ])('%s', (_name, over, evidence, expected) => {
    expect(anchorState(reading(over), { ...NO_ANCHOR_EVIDENCE, ...evidence })).toBe(expected)
  })
})

describe('claimState', () => {
  it.each<[string, ClaimState[], ClaimState]>([
    ['no anchors is unanchored', [], ClaimState.unanchored],
    ['all clean is clean', [ClaimState.clean, ClaimState.clean], ClaimState.clean],
    ['any suspect is suspect, over unknown', [ClaimState.clean, ClaimState.unknown, ClaimState.suspect], ClaimState.suspect],
    ['an unknown among cleans is unknown', [ClaimState.clean, ClaimState.unknown], ClaimState.unknown],
    ['a lone suspect is suspect', [ClaimState.suspect], ClaimState.suspect],
  ])('%s', (_name, anchors, expected) => {
    expect(claimState(anchors)).toBe(expected)
  })
})
