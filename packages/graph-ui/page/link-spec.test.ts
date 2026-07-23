import { describe, expect, it } from 'bun:test'
import { formatLinkSpec, parseLinkSpec } from './link-spec'

describe('parseLinkSpec', () => {
  it('parses bare ids and kind:id entries, defaulting kind by omission', () => {
    expect(parseLinkSpec('other-note')).toEqual([{ id: 'other-note' }])
    expect(parseLinkSpec('supersedes:old-note, other-note')).toEqual([
      { id: 'old-note', kind: 'supersedes' }, { id: 'other-note' },
    ])
    expect(parseLinkSpec('  ')).toEqual([])
  })
  it('rejects unknown kinds and malformed ids, naming the bad entry', () => {
    expect(() => parseLinkSpec('replaces:x')).toThrow(/unknown link kind 'replaces'/)
    expect(() => parseLinkSpec('supersedes:Bad Id')).toThrow(/not a valid note id/)
  })
  it('round-trips through formatLinkSpec', () => {
    const spec = 'supersedes:old-note, relates_to:other'
    expect(formatLinkSpec(parseLinkSpec(spec).map(l => ({ id: l.id, kind: l.kind ?? 'relates_to' })))).toBe(spec)
  })
})
