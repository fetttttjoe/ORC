import { describe, expect, it } from 'bun:test'
import { ClaimDriftState, claimDriftState, suspectClaimIds, type BlobAt } from './claim-drift'

const anchor = (path: string, blob: string | null) => ({ path, symbol: null, blob })
const tree = (blobs: Record<string, string | null | undefined>): BlobAt => path => blobs[path]

describe('claimDriftState — a claim is judged from its own anchors', () => {
  const cases: [string, { path: string; blob: string | null }[], Record<string, string | null | undefined>, ClaimDriftState][] = [
    ['no anchors at all', [], { 'a.ts': 'aaa' }, ClaimDriftState.unanchored],
    ['the blob is what it was', [anchor('a.ts', 'aaa')], { 'a.ts': 'aaa' }, ClaimDriftState.clean],
    ['the file was edited', [anchor('a.ts', 'aaa')], { 'a.ts': 'bbb' }, ClaimDriftState.suspect],
    ['the file is gone, and that is KNOWN', [anchor('a.ts', 'aaa')], { 'a.ts': null }, ClaimDriftState.suspect],
    ['nothing was stamped at write time', [anchor('a.ts', null)], { 'a.ts': 'aaa' }, ClaimDriftState.unknown],
    ['the probe could not answer', [anchor('a.ts', 'aaa')], { 'a.ts': undefined }, ClaimDriftState.unknown],
    ['every anchor still matches', [anchor('a.ts', 'aaa'), anchor('b.ts', 'bbb')], { 'a.ts': 'aaa', 'b.ts': 'bbb' }, ClaimDriftState.clean],
    ['one anchor moved, another cannot be read', [anchor('a.ts', 'aaa'), anchor('b.ts', 'bbb')], { 'a.ts': 'moved', 'b.ts': undefined }, ClaimDriftState.suspect],
  ]
  it.each(cases)('%s', (_name, anchors, blobs, expected) => {
    expect(claimDriftState({ anchors }, tree(blobs))).toBe(expected)
  })
})

describe('suspectClaimIds', () => {
  it('names only the claims whose own anchors moved', () => {
    const claims = [
      { id: 'aaaaaaaaaaaa', anchors: [anchor('a.ts', 'aaa')] },
      { id: 'bbbbbbbbbbbb', anchors: [anchor('b.ts', 'bbb')] },
      { id: 'cccccccccccc', anchors: [] },
      { id: 'dddddddddddd', anchors: [anchor('d.ts', null)] },
    ]
    expect(suspectClaimIds(claims, tree({ 'a.ts': 'aaa', 'b.ts': 'edited', 'd.ts': 'ddd' }))).toEqual(['bbbbbbbbbbbb'])
  })
})
