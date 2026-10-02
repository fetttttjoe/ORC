import { describe, expect, it } from 'bun:test'
import { ClaimState } from './claim-state'
import { preloadLine } from './preload-line'

describe('preloadLine', () => {
  it('ends a claim in the knowledge file tail, its state left out only when clean', () => {
    const claim = { id: 'abcdefgh', text: 'Config is parsed once.', anchors: [{ path: 'src/a.ts', symbol: 'load' }, { path: 'src', symbol: null }] }
    expect(preloadLine(claim, ClaimState.clean)).toBe('- Config is parsed once. {abcdefgh @src/a.ts#load @src}')
    expect(preloadLine(claim, ClaimState.suspect)).toBe('- Config is parsed once. {abcdefgh suspect @src/a.ts#load @src}')
    expect(preloadLine({ ...claim, anchors: [] }, ClaimState.unanchored)).toBe('- Config is parsed once. {abcdefgh unanchored}')
  })
})
