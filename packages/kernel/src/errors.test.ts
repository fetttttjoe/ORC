import { describe, expect, it } from 'bun:test'
import { isDatabaseUnreachable } from './errors'

// walks .errors and .cause: drizzle wraps driver errors and pg's socket error can nest
describe('isDatabaseUnreachable', () => {
  it('detects ECONNREFUSED flat, under AggregateError, and down a cause chain', () => {
    expect(isDatabaseUnreachable(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isDatabaseUnreachable(new AggregateError([
      new Error('unrelated'),
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ]))).toBe(true)
    // drizzle's DrizzleQueryError shape: the driver error hangs off .cause
    expect(isDatabaseUnreachable(Object.assign(new Error('query failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    }))).toBe(true)
  })

  it('detects each pg connect-timeout message, plain and wrapped in .cause', () => {
    for (const message of [
      'Connection terminated due to connection timeout',
      'timeout exceeded when trying to connect',
      'timeout expired',
    ]) {
      expect(isDatabaseUnreachable(new Error(message))).toBe(true)
      expect(isDatabaseUnreachable(Object.assign(new Error('query failed'), {
        cause: new Error(message),
      }))).toBe(true)
    }
  })

  it('does not fire on unrelated errors, non-objects, or a self-referential cause', () => {
    expect(isDatabaseUnreachable(new Error('permission denied'))).toBe(false)
    expect(isDatabaseUnreachable(Object.assign(new Error('nope'), { code: '42P01' }))).toBe(false)
    expect(isDatabaseUnreachable('ECONNREFUSED')).toBe(false) // a string, not an error
    expect(isDatabaseUnreachable(null)).toBe(false)
    const loop: { cause?: unknown } = {}
    loop.cause = loop // must terminate, not recurse forever
    expect(isDatabaseUnreachable(loop)).toBe(false)
  })
})
