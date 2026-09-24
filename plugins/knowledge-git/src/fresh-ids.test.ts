import { describe, expect, it } from 'bun:test'
import { freshIdSource } from './fresh-ids'

describe('freshIdSource', () => {
  it('skips ids already taken and ids it already handed out', () => {
    const script = ['aaaaaaaa', 'bbbbbbbb', 'bbbbbbbb', 'cccccccc']
    const fresh = freshIdSource(['aaaaaaaa'], () => script.shift() ?? 'zzzzzzzz')
    expect([fresh(), fresh()]).toEqual(['bbbbbbbb', 'cccccccc'])
  })
})
