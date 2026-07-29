import { describe, expect, it } from 'bun:test'
import {
  foldRow, ftsQuery, keywordCompare, keywordTerms, MARGIN_WINDOW, MAX_SEARCH_TERMS,
  meetsMargin, meetsQuorum, SEMANTIC_MARGIN,
} from './keyword'

describe('keywordTerms', () => {
  it('lowercases, dedupes, drops one-character tokens, and caps the count', () => {
    expect(keywordTerms('Write ZONE write')).toEqual(['write', 'zone'])
    // a repeated word is one piece of evidence — counting it twice would inflate both sides of
    // the quorum fraction at once
    expect(keywordTerms('the fence that the step declared')).toEqual(['the', 'fence', 'that', 'step', 'declared'])
    // one-character tokens match nearly every note after stemming and only raise the denominator
    expect(keywordTerms('a b write')).toEqual(['write'])
    expect(keywordTerms(Array.from({ length: 40 }, (_, i) => `zz${i}`).join(' '))).toHaveLength(MAX_SEARCH_TERMS)
    expect(keywordTerms('   ')).toEqual([])
  })

  // The one-character drop must never consume the WHOLE query: an empty term list matches nothing,
  // so `orc memory search x` returned "_no notes_" for a note tagged 'x'. Tags here are routinely
  // one or two characters and an identifier search is often a single token.
  it('never empties its own input — a query that is only short tokens keeps them', () => {
    expect(keywordTerms('x')).toEqual(['x'])
    expect(keywordTerms('X')).toEqual(['x'])
    expect(keywordTerms('a b')).toEqual(['a', 'b'])
    // the cap still applies to whichever list survives
    expect(keywordTerms('a b c d e f g h i j')).toHaveLength(MAX_SEARCH_TERMS)
    // and the drop still bites the moment ONE real term exists
    expect(keywordTerms('a b write')).toEqual(['write'])
  })
})

describe('meetsQuorum', () => {
  // half the query's terms, rounded up. The sweep that chose the half is in keyword.ts.
  it('takes half the terms, rounded up, and is unreachable only at zero matches', () => {
    expect(meetsQuorum(1, 2)).toBe(true)
    expect(meetsQuorum(0, 2)).toBe(false)
    expect(meetsQuorum(1, 3)).toBe(false)   // ceil(3/2) = 2
    expect(meetsQuorum(2, 3)).toBe(true)
    expect(meetsQuorum(4, 8)).toBe(true)
    expect(meetsQuorum(3, 8)).toBe(false)
    // the single-term case every short query hits: one match is the whole query
    expect(meetsQuorum(1, 1)).toBe(true)
  })
})

describe('meetsMargin', () => {
  // The WITHIN-QUERY rule: a top cosine is evidence only if it stands out from the neighbourhood
  // the same query pulled back. Scores arrive already sorted descending (the cosine SELECT's own
  // ORDER BY) and are RAW — the re-rank runs after, and a hot bystander would widen the very gap
  // this checks.
  const flat = (n: number, v: number): number[] => Array.from({ length: n }, () => v)

  it('silences a query whose top is level with its own candidate field', () => {
    // 12 candidates all equally (ir)relevant: nothing here is about the query
    expect(meetsMargin(flat(12, 0.55))).toBe(false)
    // a top that clears the window median by less than the margin is still noise
    expect(meetsMargin([0.55 + SEMANTIC_MARGIN / 2, ...flat(11, 0.55)])).toBe(false)
  })

  it('answers when the top stands clear of the window median', () => {
    expect(meetsMargin([0.76, ...flat(11, 0.55)])).toBe(true)
    // exactly at the margin counts as clear — the boundary is inclusive, like SEMANTIC_FLOOR's
    expect(meetsMargin([0.55 + SEMANTIC_MARGIN, ...flat(11, 0.55)])).toBe(true)
  })

  it('reads the median of the WINDOW, so a long weak tail cannot manufacture a margin', () => {
    // ten near-identical candidates, then a tail of much worse ones: the tail would drag a
    // whole-set median down and let a flat top through. The window ignores it.
    expect(meetsMargin([...flat(MARGIN_WINDOW, 0.55), ...flat(40, 0.1)])).toBe(false)
  })

  // A young corpus, and every fixture in this package: the constant was measured against candidate
  // sets of 15 and 50, and the median of a set smaller than the window is not that statistic. The
  // rule abstains there rather than silencing an arm on evidence nobody gathered.
  it('does not apply below one window of candidates', () => {
    expect(meetsMargin([0.9])).toBe(true)
    expect(meetsMargin(flat(MARGIN_WINDOW - 1, 0.55))).toBe(true)
    expect(meetsMargin([])).toBe(true)
    // …and applies at exactly one window
    expect(meetsMargin(flat(MARGIN_WINDOW, 0.55))).toBe(false)
  })

  it('is a positive margin over a window wide enough to have a median', () => {
    expect(SEMANTIC_MARGIN).toBeGreaterThan(0)
    expect(MARGIN_WINDOW).toBeGreaterThanOrEqual(2)
  })
})

describe('ftsQuery', () => {
  // Match references are TERM-MAJOR and shared by all three fragments. Getting that arithmetic
  // wrong pairs a term's score with another term's clause and silently mis-ranks everything, which
  // no integration test would report as anything but a bad result.
  it('numbers every (term, field) pair term-major across where, scores and matches', () => {
    const q = ftsQuery(['zone', 'fence'], ['title', 'body'])
    expect(q.where).toBe('(title @0@ $kw0 OR body @1@ $kw0) OR (title @2@ $kw1 OR body @3@ $kw1)')
    expect(q.scores).toBe('search::score(0), search::score(1), search::score(2), search::score(3)')
    expect(q.matches).toBe('(title @0@ $kw0), (body @1@ $kw0), (title @2@ $kw1), (body @3@ $kw1)')
    expect(q.vars).toEqual({ kw0: 'zone', kw1: 'fence' })
  })
})

describe('foldRow', () => {
  const weights = [3, 2, 1]
  it('counts a matched term whose BM25 score is zero', () => {
    // THE reason `matches` is projected at all: SurrealDB's unsmoothed IDF makes search::score
    // exactly 0 for a term carried by half the corpus or more, so a small corpus scores every hit
    // at 0. Counting matches from the scores would make the quorum unreachable there.
    expect(foldRow([true, false, false], [0, 0, 0], weights))
      .toEqual({ matched: 1, coverage: 3, bm25: 0 })
  })
  it('weights coverage by field and sums BM25 the same way, term by term', () => {
    // two terms: the first in title+body, the second in summary only
    const k = foldRow([true, false, true, false, true, false], [2, 0, 1, 0, 4, 0], weights)
    expect(k).toEqual({ matched: 2, coverage: 3 + 1 + 2, bm25: 2 * 3 + 1 * 1 + 4 * 2 })
  })
  it('is empty for a row that matched nothing', () => {
    expect(foldRow([], [], weights)).toEqual({ matched: 0, coverage: 0, bm25: 0 })
  })
})

describe('keywordCompare', () => {
  it('ranks coverage first and uses BM25 only to break its ties', () => {
    const wide = { matched: 2, coverage: 5, bm25: 0.1 }
    const deep = { matched: 1, coverage: 3, bm25: 90 }
    expect(keywordCompare(wide, deep)).toBeLessThan(0)
    expect(keywordCompare({ ...wide, bm25: 1 }, { ...wide, bm25: 2 })).toBeGreaterThan(0)
  })
})
