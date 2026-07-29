import { describe, expect, it } from 'bun:test'
import { trigramDice } from './title-similarity'

describe('trigramDice', () => {
  it('scores a rephrasing of the same subject high', () => {
    // The exact fork tools.ts:34 exists to catch: two ids, one subject.
    expect(trigramDice('Auth middleware', 'Authentication middleware')).toBeGreaterThan(0.5)
  })

  it('scores two genuinely different subjects low', () => {
    expect(trigramDice('Auth middleware', 'Vault markdown renderer')).toBeLessThan(0.2)
  })

  it('is 1 for identical titles and symmetric', () => {
    expect(trigramDice('same title', 'same title')).toBe(1)
    expect(trigramDice('a b c', 'c b a')).toBe(trigramDice('c b a', 'a b c'))
  })

  it('is 0 when either side is too short to have a trigram', () => {
    expect(trigramDice('ab', 'Authentication middleware')).toBe(0)
  })
})
