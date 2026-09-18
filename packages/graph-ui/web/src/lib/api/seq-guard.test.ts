import { describe, expect, it } from 'bun:test'
import { newer } from './seq-guard'

describe('newer', () => {
  it('keeps the held value when it is strictly ahead of the incoming one', () => {
    expect(newer({ seq: 5, d: 1 }, { seq: 4, d: 2 })).toEqual({ seq: 5, d: 1 })
  })

  it('takes the incoming value on an equal seq', () => {
    expect(newer({ seq: 5, d: 1 }, { seq: 5, d: 2 })).toEqual({ seq: 5, d: 2 })
  })

  it('takes the incoming value when nothing is held yet', () => {
    expect(newer(undefined, { seq: 4, d: 2 })).toEqual({ seq: 4, d: 2 })
  })
})
