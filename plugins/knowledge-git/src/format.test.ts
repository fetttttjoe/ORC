import { describe, expect, it } from 'bun:test'
import { formatLine, parseBucket, serializeBucket, type SerializableClaim } from './format'

const HEADINGS = ['Facts', 'Why']
const claim = (over: Partial<SerializableClaim>): SerializableClaim => ({
  id: 'aaaaaaaa', text: 'A fact.', section: 'Facts', anchors: [], tags: [], sources: [], decision: null, ...over,
})

describe('formatLine', () => {
  it('writes id, anchors in order, sorted tags, sources in order, then the decision', () => {
    expect(formatLine(claim({
      id: 'k7f3a2x9', text: 'The store is the only writer.',
      anchors: [{ path: 'plugins/memory/src/store.ts', symbol: 'createMemoryStore' }, { path: 'docs', symbol: null }],
      tags: ['zeta', 'events'], sources: ['https://example.com/a#b'], decision: 'merge-base-from-log',
    }))).toBe('- The store is the only writer. {k7f3a2x9 @plugins/memory/src/store.ts#createMemoryStore @docs #events #zeta <https://example.com/a#b> adr:merge-base-from-log}')
  })
})

describe('serializeBucket', () => {
  it('writes the title, Facts before Why, claims sorted by first anchor then id, empty sections omitted', () => {
    const text = serializeBucket('plugins/memory/src/store.ts', [
      claim({ id: 'aaaaaaaa', anchors: [{ path: 'p/a.ts', symbol: 'z' }] }),
      claim({ id: 'cccccccc', section: 'Why', text: 'Because.' }),
      claim({ id: 'bbbbbbbb', anchors: [{ path: 'p/a.ts', symbol: 'a' }] }),
      claim({ id: 'dddddddd', anchors: [{ path: 'p/a.ts', symbol: 'a' }] }),
    ], HEADINGS)
    expect(text).toBe([
      '# plugins/memory/src/store.ts', '',
      '## Facts',
      '- A fact. {bbbbbbbb @p/a.ts#a}',
      '- A fact. {dddddddd @p/a.ts#a}',
      '- A fact. {aaaaaaaa @p/a.ts#z}', '',
      '## Why',
      '- Because. {cccccccc}', '',
    ].join('\n'))
  })
})

describe('parseBucket', () => {
  it('round-trips what it serializes', () => {
    const claims = [
      claim({ id: 'aaaaaaaa', anchors: [{ path: 'p/a.ts', symbol: 'a.b' }], tags: ['x'], sources: ['https://bun.sh/docs#x'], decision: 'd-1' }),
      claim({ id: 'bbbbbbbb', section: 'Why', text: 'Braces {inside} are fine.' }),
    ]
    const text = serializeBucket('t', claims, HEADINGS)
    const parsed = parseBucket(text, HEADINGS)
    expect(parsed.problems).toEqual([])
    expect(parsed.title).toBe('t')
    expect(serializeBucket('t', parsed.claims.map(c => ({ ...c, id: c.id ?? '' })), HEADINGS)).toBe(text)
  })
  it('a line without a tail is a claim with no id', () => {
    const parsed = parseBucket('# t\n\n## Facts\n- Written by hand.\n', HEADINGS)
    expect(parsed.claims).toEqual([{ id: null, text: 'Written by hand.', section: 'Facts', anchors: [], tags: [], sources: [], decision: null, line: 4 }])
  })
  it('reports, with line numbers, what it cannot read, and keeps reading', () => {
    const parsed = parseBucket([
      '# t',
      '## Notes',
      '- lost {aaaaaaaa}',
      '## Facts',
      'free text',
      '- bad {aaaaaaaa @}',
      '- two {aaaaaaaa adr:a adr:b}',
      '- kept {bbbbbbbb}',
    ].join('\n'), HEADINGS)
    expect(parsed.problems.map(p => p.line)).toEqual([2, 3, 5, 6, 7])
    expect(parsed.claims.map(c => c.id)).toEqual(['bbbbbbbb'])
  })
})
