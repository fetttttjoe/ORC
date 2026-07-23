export const KERNEL_ERROR_CODE = {
  task_not_found: 'task_not_found',
  invalid_transition: 'invalid_transition',
  version_conflict: 'version_conflict',
  plan_validation_failed: 'plan_validation_failed',
  // a keyed append conflicted with a stored event of DIFFERENT data — a typed identity so
  // consumers (the memory gateway's benign-replay tolerance) match a code, not a prose message
  idempotency_conflict: 'idempotency_conflict',
} as const
export type KernelErrorCode = (typeof KERNEL_ERROR_CODE)[keyof typeof KERNEL_ERROR_CODE]

export class KernelError extends Error {
  constructor(readonly code: KernelErrorCode, message: string) {
    super(message)
    this.name = 'KernelError'
  }
}

// Lives here (not in the CLI) because it decodes shapes owned by the kernel's storage deps:
// drizzle wraps driver errors in DrizzleQueryError (unwrap .cause), pg reports ECONNREFUSED.
export function isConnectionRefused(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.some(isConnectionRefused)
  if (typeof err !== 'object' || err === null) return false
  if ('code' in err && err.code === 'ECONNREFUSED') return true
  const cause = 'cause' in err ? err.cause : undefined
  return cause !== undefined && cause !== err && isConnectionRefused(cause)
}
