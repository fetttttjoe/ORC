// Classifies an unknown error as retryable-with-backoff or terminal.
import { errField, errorChainNodes } from './error-chain'

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

const TRANSIENT_CODE = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
  // undici surfaces a connect/headers timeout in its own code namespace, reached via `cause`
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
])

// DOMException identifies a timeout only by `name`; its numeric `code` is a legacy constant, not a string
// AbortError is excluded: a deliberate cancellation is not a fault to retry
const TRANSIENT_NAME = new Set(['TimeoutError'])

export function isTransient(err: unknown): boolean {
  for (const node of errorChainNodes(err)) {
    // a node with lastError is classified by what it points to, not by its own fields
    const lastError = errField(node, 'lastError')
    if (lastError !== undefined && lastError !== node) continue
    const name = errField(node, 'name')
    if (typeof name === 'string' && TRANSIENT_NAME.has(name)) return true
    const isRetryable = errField(node, 'isRetryable')
    if (typeof isRetryable === 'boolean') return isRetryable
    const status = errField(node, 'statusCode') ?? errField(node, 'status')
    if (typeof status === 'number') return TRANSIENT_STATUS.has(status)
    const code = errField(node, 'code')
    // `typeof code === 'string'` guards the DOMException case, whose `code` is the number 23
    if (typeof code === 'string' && TRANSIENT_CODE.has(code)) return true
  }
  return false
}
