// Is a failed model call worth retrying? Pure classification over an unknown error shape, zero
// imports (the cluster.ts shape) — it decides whether the port's checkpoint retries with backoff
// or stamps the step terminal, and getting it wrong is expensive in both directions: a terminal
// verdict on a transient fault burns the step on attempt 1, and a transient verdict on a 4xx
// burns the whole retry budget re-sending a request that cannot succeed.

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

const TRANSIENT_CODE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
  // undici/Node surface a connect or headers timeout under its own code namespace, wrapped in a
  // `TypeError: fetch failed` whose `cause` carries them — see the cause unwrap below
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

// A request timeout is a DOMException, and its `name` is the ONLY field that identifies it: `code`
// is the NUMBER 23 (the legacy DOMException constant, not a string like 'ETIMEDOUT'), and it
// carries no statusCode and no isRetryable. Every check in isTransient therefore missed it, and a
// timed-out model call — the single most retryable failure there is — was stamped terminal and
// burned the step on attempt 1 of 4. Observed live:
//   "Non-retryable error in step. Attempt 1 of 4. Error: The operation timed out."
//
// AbortError is deliberately absent: that is a cancellation someone asked for, and re-issuing a
// request the operator (or a budget guard) just stopped would be the opposite of correct.
const TRANSIENT_NAME = new Set(['TimeoutError'])

const errField = (err: unknown, key: string): unknown =>
  typeof err === 'object' && err !== null && key in err ? Reflect.get(err, key) : undefined

// An error chain is attacker-shaped data as far as this file is concerned: `lastError` and `cause`
// are followed blind, and a cycle (a.cause = b, b.cause = a) recursed until the stack gave out. The
// direct self-reference guards below catch `x.cause === x` and nothing else. A depth cap is enough:
// no real provider wraps an error more than a few layers deep, and past that the answer is the same
// as for an error with no fields at all — not transient.
const MAX_CAUSE_DEPTH = 8

export function isTransient(err: unknown, depth = 0): boolean {
  if (depth >= MAX_CAUSE_DEPTH) return false
  // ai@7 exhausts its internal retries on retryable errors and throws RetryError, which carries
  // no status fields itself — classify by the underlying provider error instead
  const lastError = errField(err, 'lastError')
  if (lastError !== undefined && lastError !== err) return isTransient(lastError, depth + 1)
  // The timeout verdict is read BEFORE the SDK's own: a provider wrapper that saw a socket time
  // out has no way to know the request was survivable, and its default verdict is "not retryable".
  const name = errField(err, 'name')
  if (typeof name === 'string' && TRANSIENT_NAME.has(name)) return true
  // APICallError/GatewayError expose the SDK's own retryability verdict — trust it next
  const isRetryable = errField(err, 'isRetryable')
  if (typeof isRetryable === 'boolean') return isRetryable
  const status = errField(err, 'statusCode') ?? errField(err, 'status')
  if (typeof status === 'number') return TRANSIENT_STATUS.has(status)
  const code = errField(err, 'code')
  // `typeof code === 'string'` guards the DOMException case, whose `code` is the number 23 — a
  // bare `TRANSIENT_CODE.has(code)` would be a silent no-match rather than an obvious one
  if (typeof code === 'string' && TRANSIENT_CODE.has(code)) return true
  // `TypeError: fetch failed` hides the real fault in `cause` — undici's shape, and the one that
  // makes an otherwise fieldless error look permanent. Unwrapped last so nothing above is skipped.
  const cause = errField(err, 'cause')
  return cause !== undefined && cause !== err ? isTransient(cause, depth + 1) : false
}
