import { describe, expect, it } from 'bun:test'
import { FIRST_WAIT_MS, MAX_WAIT_MS, TOTAL_WAIT_BUDGET_MS, rateLimitWaitMs } from './rate-limit'

const rateLimited = (headers?: Record<string, string>): unknown =>
  Object.assign(new Error('This request would exceed your account rate limit'), {
    statusCode: 429,
    ...(headers ? { responseHeaders: headers } : {}),
  })

/** the shape ai@7 throws once its own internal retries are exhausted */
const retryError = (lastError: unknown): unknown => Object.assign(new Error('retries exhausted'), { lastError })

describe('rateLimitWaitMs', () => {
  it('waits the first interval on a 429 with no retry-after', () => {
    expect(rateLimitWaitMs(rateLimited(), 0)).toBe(FIRST_WAIT_MS)
  })

  it('doubles the wait with every wait already taken', () => {
    expect(rateLimitWaitMs(rateLimited(), 1)).toBe(FIRST_WAIT_MS * 2)
    expect(rateLimitWaitMs(rateLimited(), 2)).toBe(FIRST_WAIT_MS * 4)
  })

  it('caps the wait', () => {
    expect(rateLimitWaitMs(rateLimited(), 4)).toBe(MAX_WAIT_MS)
    expect(rateLimitWaitMs(rateLimited(), 5)).toBe(MAX_WAIT_MS)
  })

  it("honours the error's retry-after header, clamped to the cap", () => {
    expect(rateLimitWaitMs(rateLimited({ 'retry-after': '12' }), 0)).toBe(12_000)
    expect(rateLimitWaitMs(rateLimited({ 'retry-after': '900' }), 0)).toBe(MAX_WAIT_MS)
  })

  it('reads the 429 through a wrapped error the same way isTransient does', () => {
    expect(rateLimitWaitMs(retryError(rateLimited()), 0)).toBe(FIRST_WAIT_MS)
    expect(rateLimitWaitMs(Object.assign(new Error('fetch failed'), { cause: rateLimited() }), 0)).toBe(FIRST_WAIT_MS)
  })

  it('gives up once the waits would exceed the total budget', () => {
    let waits = 0
    let total = 0
    for (;;) {
      const next = rateLimitWaitMs(rateLimited(), waits)
      if (next === null) break
      total += next
      waits++
    }
    expect(total).toBeLessThanOrEqual(TOTAL_WAIT_BUDGET_MS)
    expect(total).toBeGreaterThan(TOTAL_WAIT_BUDGET_MS - MAX_WAIT_MS * 2)
  })

  it('is not a rate limit → null', () => {
    expect(rateLimitWaitMs(Object.assign(new Error('overloaded'), { statusCode: 503 }), 0)).toBeNull()
    expect(rateLimitWaitMs(new Error('boom'), 0)).toBeNull()
  })

  it('finds a rate limit behind a self-referencing lastError, falling back to cause', () => {
    const selfRef: Record<string, unknown> = {}
    selfRef.lastError = selfRef
    selfRef.cause = rateLimited()
    expect(rateLimitWaitMs(selfRef, 0)).toBe(FIRST_WAIT_MS)
  })

  it('does not hang on a two-node cycle with no rate limit anywhere in it', () => {
    const a: Record<string, unknown> = {}
    const b: Record<string, unknown> = { cause: a }
    a.cause = b
    expect(rateLimitWaitMs(a, 0)).toBeNull()
  })
})
