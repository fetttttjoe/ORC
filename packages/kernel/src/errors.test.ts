import { describe, expect, it } from 'bun:test'
import { isConnectionRefused } from './errors'

// walks .errors and .cause: drizzle wraps driver errors and pg's socket error can nest
describe('isConnectionRefused', () => {
  it('detects ECONNREFUSED flat, under AggregateError, and down a cause chain', () => {
    expect(isConnectionRefused(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isConnectionRefused(new AggregateError([
      new Error('unrelated'),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ]))).toBe(true)
    // drizzle's DrizzleQueryError shape: the driver error hangs off .cause
    expect(isConnectionRefused(Object.assign(new Error('query failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    }))).toBe(true)
  })

  it('does not fire on unrelated errors, non-objects, or a self-referential cause', () => {
    expect(isConnectionRefused(new Error('permission denied'))).toBe(false)
    expect(isConnectionRefused(Object.assign(new Error('nope'), { code: '42P01' }))).toBe(false)
    expect(isConnectionRefused('ECONNREFUSED')).toBe(false) // a string, not an error
    expect(isConnectionRefused(null)).toBe(false)
    const loop: { cause?: unknown } = {}
    loop.cause = loop // must terminate, not recurse forever
    expect(isConnectionRefused(loop)).toBe(false)
  })
})
