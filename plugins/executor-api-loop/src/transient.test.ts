import { describe, expect, it } from 'bun:test'
import { isTransient } from './transient'

/** the shape ai@7 throws once its own internal retries are exhausted */
const retryError = (lastError: unknown): unknown => Object.assign(new Error('retries exhausted'), { lastError })

describe('isTransient', () => {
  it('trusts the SDK verdict when the error carries one', () => {
    expect(isTransient(Object.assign(new Error('gateway'), { isRetryable: true }))).toBe(true)
    expect(isTransient(Object.assign(new Error('bad key'), { isRetryable: false }))).toBe(false)
  })

  it('classifies by status when there is no SDK verdict', () => {
    expect(isTransient(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(true)
    expect(isTransient(Object.assign(new Error('overloaded'), { status: 503 }))).toBe(true)
    expect(isTransient(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(false)
  })

  it('unwraps RetryError and classifies the underlying provider error', () => {
    expect(isTransient(retryError(Object.assign(new Error('overloaded'), { statusCode: 503 })))).toBe(true)
    expect(isTransient(retryError(Object.assign(new Error('context too long'), { statusCode: 400 })))).toBe(false)
  })

  it('treats the socket-level codes as transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'])
      expect(isTransient(Object.assign(new Error('socket'), { code }))).toBe(true)
  })

  /**
   * The bug this file exists for. Bun surfaces a request timeout as a DOMException whose `name` is
   * 'TimeoutError' and whose `code` is the NUMBER 23 (the legacy DOMException constant) — no
   * statusCode, no isRetryable, and no STRING code, so every check above missed it. A timed-out
   * model call was stamped terminal and burned the step on attempt 1 of 4; observed live in
   * .orc/serve.log as "Non-retryable error in step. Attempt 1 of 4. Error: The operation timed out."
   */
  it('treats a fetch timeout as transient — the single most retryable failure there is', () => {
    expect(isTransient(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(true)
  })

  it('treats a REAL fetch timeout as transient, whatever shape the runtime gives it', async () => {
    let thrown: unknown
    // 10.255.255.1 blackholes rather than refusing, so the request times out instead of resetting
    try {
      await fetch('http://10.255.255.1:81/', { signal: AbortSignal.timeout(250) })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    expect(isTransient(thrown)).toBe(true)
  })

  it('does NOT retry a deliberate abort — a cancellation is not a fault', () => {
    expect(isTransient(new DOMException('The operation was aborted.', 'AbortError'))).toBe(false)
  })

  it('does not mistake the numeric DOMException code for a socket code', () => {
    // code 23 is TIMEOUT_ERR; a numeric code must never match the string set by coercion
    expect(isTransient(Object.assign(new Error('nope'), { code: 23 }))).toBe(false)
  })

  it('says no to shapes it cannot read rather than burning the retry budget on them', () => {
    expect(isTransient(null)).toBe(false)
    expect(isTransient('a string')).toBe(false)
    expect(isTransient(new Error('plain'))).toBe(false)
  })
})

describe('isTransient — wrapper shapes that hide the real fault', () => {
  it('unwraps a `TypeError: fetch failed` and classifies its cause', () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
    })
    expect(isTransient(wrapped)).toBe(true)
  })

  it('still refuses a wrapper whose cause is genuinely permanent', () => {
    const wrapped = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('bad api key'), { statusCode: 401 }),
    })
    expect(isTransient(wrapped)).toBe(false)
  })

  it('does not loop forever on an error that is its own cause', () => {
    const selfref: Record<string, unknown> = { name: 'Weird' }
    selfref['cause'] = selfref
    expect(isTransient(selfref)).toBe(false)
  })
})
