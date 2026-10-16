import { describe, expect, it } from 'bun:test'
import { featureTag, KNOWLEDGE_TAG_LIMITS, KNOWLEDGE_TAG_RE } from './knowledge-ref'

describe('featureTag', () => {
  it('lowercases and dashes a title', () => {
    expect(featureTag('Plan notes move to the kernel')).toBe('plan-notes-move-to-the-kernel')
  })

  it('cuts a long title to the tag limit with no trailing dash', () => {
    const tag = featureTag('word '.repeat(12).trim())
    expect(tag).not.toBeNull()
    expect(tag?.length).toBeLessThanOrEqual(KNOWLEDGE_TAG_LIMITS.chars)
    expect(tag?.endsWith('-')).toBe(false)
  })

  it('cuts at a word boundary', () => {
    expect(featureTag('Pin a numeric-claim recount rule into sweepSpec auditor instructions')).toBe('pin-a-numeric-claim-recount-rule-into')
  })

  it('hard-cuts a single word longer than the limit', () => {
    expect(featureTag('x'.repeat(50))).toBe('x'.repeat(KNOWLEDGE_TAG_LIMITS.chars))
  })

  it('trims edge dashes and collapses runs', () => {
    expect(featureTag('  --Fix: the (thing)!  ')).toBe('fix-the-thing')
  })

  it('is null when nothing alphanumeric is left', () => {
    expect(featureTag('ÄÖÜ')).toBeNull()
  })

  it('every non-null output is a valid tag', () => {
    for (const title of ['a', 'x'.repeat(60), 'one two three four five six seven eight nine', 'A--B']) {
      const tag = featureTag(title)
      expect(tag === null || KNOWLEDGE_TAG_RE.test(tag)).toBe(true)
    }
  })
})
