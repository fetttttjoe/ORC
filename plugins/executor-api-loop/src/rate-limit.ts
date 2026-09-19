// How long to wait out a provider rate limit before re-issuing the same model call.
import { MAX_CAUSE_DEPTH, errField } from './transient'

const RATE_LIMIT_STATUS = 429
const RETRY_AFTER_HEADER = 'retry-after'
const MS_PER_SECOND = 1000

export const FIRST_WAIT_MS = 30_000
export const MAX_WAIT_MS = 300_000
export const TOTAL_WAIT_BUDGET_MS = 1_200_000

function errorChain(err: unknown): unknown[] {
  const nodes: unknown[] = []
  let node = err
  while (node !== undefined && node !== null && nodes.length < MAX_CAUSE_DEPTH) {
    nodes.push(node)
    const next = errField(node, 'lastError') ?? errField(node, 'cause')
    node = next === node ? undefined : next
  }
  return nodes
}

export const isRateLimited = (err: unknown): boolean =>
  errorChain(err).some(n => (errField(n, 'statusCode') ?? errField(n, 'status')) === RATE_LIMIT_STATUS)

function retryAfterMs(err: unknown): number | null {
  for (const node of errorChain(err)) {
    const value = errField(errField(node, 'responseHeaders'), RETRY_AFTER_HEADER)
    const seconds = typeof value === 'string' ? Number(value) : value
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) return seconds * MS_PER_SECOND
  }
  return null
}

const scheduledWaitMs = (waitsSoFar: number): number => Math.min(FIRST_WAIT_MS * 2 ** waitsSoFar, MAX_WAIT_MS)

function alreadyWaitedMs(waitsSoFar: number): number {
  let total = 0
  for (let n = 0; n < waitsSoFar; n++) total += scheduledWaitMs(n)
  return total
}

export function rateLimitWaitMs(err: unknown, waitsSoFar: number): number | null {
  if (!isRateLimited(err)) return null
  const next = Math.min(retryAfterMs(err) ?? scheduledWaitMs(waitsSoFar), MAX_WAIT_MS)
  return alreadyWaitedMs(waitsSoFar) + next > TOTAL_WAIT_BUDGET_MS ? null : next
}
