import { describe, expect, it } from 'bun:test'
import { ClaimClass, type KnowledgeClaim } from '@orc/contracts'
import { CARD_REFUSAL, cardOf } from './card'

const claim = (id: string, location: string, ...paths: string[]): KnowledgeClaim =>
  ({ id, location, text: id, class: ClaimClass.fact, anchors: paths.map(path => ({ path, symbol: null })), tags: [], sources: [], decision: null })

describe('cardOf', () => {
  const all = [claim('bbbbbbbb', 'b', 'src/b.ts'), claim('aaaaaaaa', 'a', 'src/a.ts'), claim('cccccccc', 'a', 'src/a.ts'), claim('dddddddd', 'r')]
  it('orders by location then id and normalises the entity', () => {
    expect(cardOf('./src/', all, { cursor: null, limit: 10 })).toEqual({ entity: 'src', claims: [all[1], all[2], all[0]], next: null })
  })
  it('the root card includes unanchored claims', () => {
    expect(cardOf('.', all, { cursor: null, limit: 10 }).claims.map(c => c.id)).toContain('dddddddd')
  })
  it('refuses a cursor it never handed out', () => {
    expect(() => cardOf('.', all, { cursor: 'x', limit: 1 })).toThrow(CARD_REFUSAL.cursor('x'))
  })
})
