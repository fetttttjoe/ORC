export const KERNEL_ERROR_CODE = {
  task_not_found: 'task_not_found',
  invalid_transition: 'invalid_transition',
  version_conflict: 'version_conflict',
  plan_validation_failed: 'plan_validation_failed',
  // a keyed append conflicted with a stored event of DIFFERENT data
  idempotency_conflict: 'idempotency_conflict',
  workspace_not_found: 'workspace_not_found',
} as const
export type KernelErrorCode = (typeof KERNEL_ERROR_CODE)[keyof typeof KERNEL_ERROR_CODE]

export class KernelError extends Error {
  constructor(readonly code: KernelErrorCode, message: string) {
    super(message)
    this.name = 'KernelError'
  }
}

// pg's connect timeouts carry no .code; a Pool's fresh-client dial fails with this message
const PG_POOL_NEW_CLIENT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout'
// a Pool with every client busy times out the caller waiting in its queue
const PG_POOL_QUEUE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect'
// a bare (non-pooled) Client's own connectionTimeoutMillis firing
const PG_CLIENT_CONNECT_TIMEOUT_MESSAGE = 'timeout expired'
const PG_CONNECT_TIMEOUT_MESSAGES = new Set([
  PG_POOL_NEW_CLIENT_TIMEOUT_MESSAGE,
  PG_POOL_QUEUE_TIMEOUT_MESSAGE,
  PG_CLIENT_CONNECT_TIMEOUT_MESSAGE,
])

// decodes drizzle's DrizzleQueryError (unwrap .cause), pg's ECONNREFUSED, and pg's connect-timeout messages
export function isDatabaseUnreachable(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.some(isDatabaseUnreachable)
  if (typeof err !== 'object' || err === null) return false
  if ('code' in err && err.code === 'ECONNREFUSED') return true
  if ('message' in err && typeof err.message === 'string' && PG_CONNECT_TIMEOUT_MESSAGES.has(err.message)) return true
  const cause = 'cause' in err ? err.cause : undefined
  return cause !== undefined && cause !== err && isDatabaseUnreachable(cause)
}
