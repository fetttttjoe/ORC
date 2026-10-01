import { describe, expect, it } from 'bun:test'
import { anchorState, ClaimState, claimState, type AnchorReading } from './claim-state'

const reading = (over: Partial<AnchorReading>): AnchorReading => ({ path: 'src/a.ts', symbol: 'alpha', basis: 'b1', current: 'b1', readable: true, ...over })

describe('anchorState', () => {
  it.each<[string, Partial<AnchorReading>, string[], ClaimState]>([
    ['an unreadable anchor is unknown, even when its digests agree', { readable: false }, [], ClaimState.unknown],
    ['an unreadable anchor is unknown, even when its target is gone', { readable: false, current: null }, [], ClaimState.unknown],
    ['a gone target is suspect', { current: null }, [], ClaimState.suspect],
    ['a gone target is suspect even when its basis was gone too', { basis: null, current: null }, [], ClaimState.suspect],
    ['a current digest equal to the basis is clean', {}, [], ClaimState.clean],
    ['a current digest other than the basis is suspect', { current: 'c2' }, [], ClaimState.suspect],
    ['a current digest a holds check accepted is clean', { current: 'c2' }, ['c1', 'c2'], ClaimState.clean],
    ['an accepted digest that is not the current one does not clear it', { current: 'c3' }, ['c2'], ClaimState.suspect],
    ['a target missing at the basis that exists now is suspect', { basis: null, current: 'c1' }, [], ClaimState.suspect],
  ])('%s', (_name, over, accepted, expected) => {
    expect(anchorState(reading(over), accepted)).toBe(expected)
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
