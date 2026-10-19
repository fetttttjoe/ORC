import { describe, expect, it } from 'bun:test'
import { bm25, tokenize } from './bm25'

describe('tokenize', () => {
  it('splits camelCase, paths and punctuation, lower-cases, drops one-letter tokens', () => {
    expect(tokenize('createEventStore in plugins/memory/src/store.ts, a')).toEqual(
      ['createeventstore', 'create', 'event', 'store', 'in', 'plugins', 'memory', 'src', 'store', 'ts'])
  })
  it('keeps non-ASCII letters, and splits camelCase at a non-ASCII capital', () => {
    expect(tokenize('Größe')).toEqual(['größe'])
    expect(tokenize('größeÜber')).toEqual(['größeüber', 'größe', 'über'])
  })
})

describe('bm25', () => {
  const docs = [
    { id: 'a', text: 'the projector drains memory events into the read model' },
    { id: 'b', text: 'the store appends events' },
    { id: 'c', text: 'createEventStore is the composition root' },
  ]
  it('ranks the document with the rare term first and ignores non-matches', () => {
    expect(bm25(docs, 'projector events', 10).map(s => s.id)).toEqual(['a', 'b'])
  })
  it('matches a camelCase part', () => {
    expect(bm25(docs, 'event store', 10)[0]?.id).toBe('c')
  })
  it('returns nothing for an empty query, and at most the limit', () => {
    expect(bm25(docs, '  ', 10)).toEqual([])
    expect(bm25(docs, 'the', 1).length).toBe(1)
  })
})
