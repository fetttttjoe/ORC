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

// decodes drizzle's DrizzleQueryError (unwrap .cause) and pg's ECONNREFUSED
export function isConnectionRefused(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.some(isConnectionRefused)
  if (typeof err !== 'object' || err === null) return false
  if ('code' in err && err.code === 'ECONNREFUSED') return true
  const cause = 'cause' in err ? err.cause : undefined
  return cause !== undefined && cause !== err && isConnectionRefused(cause)
}
