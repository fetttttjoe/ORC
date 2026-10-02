import { describe, expect, it } from 'bun:test'
import { assemblePreload, tokensOf, type Candidate } from './preload'

const c = (id: string, cost: number): Candidate<string> => ({ id, cost, item: id })
const picked = (arms: Candidate<string>[][], budget: number) => assemblePreload(arms, budget).map(p => [p.arm, p.item])

describe('tokensOf', () => {
  it('is a quarter of the line, rounded up', () => {
    expect(tokensOf('')).toBe(0)
    expect(tokensOf('abcd')).toBe(1)
    expect(tokensOf('abcde')).toBe(2)
  })
})

describe('assemblePreload', () => {
  it('keeps arm order and item order', () => {
    expect(picked([[c('a', 1), c('b', 1)], [c('c', 1)], [c('d', 1)]], 10)).toEqual([[0, 'a'], [0, 'b'], [1, 'c'], [2, 'd']])
  })
  it('keeps a claim in two arms in the first arm only', () => {
    expect(picked([[c('a', 1)], [c('b', 1), c('a', 1)]], 10)).toEqual([[0, 'a'], [1, 'b']])
  })
  it('skips an item that does not fit and takes a later one that does', () => {
    expect(picked([[c('a', 4), c('big', 5)], [c('small', 2)]], 7)).toEqual([[0, 'a'], [1, 'small']])
  })
  it('keeps the first item although it exceeds the budget, and nothing after it', () => {
    expect(picked([[c('huge', 50), c('b', 1)]], 10)).toEqual([[0, 'huge']])
  })
  it('a zero or negative budget assembles nothing', () => {
    expect(picked([[c('a', 1)]], 0)).toEqual([])
    expect(picked([[c('a', 1)]], -5)).toEqual([])
  })
})
