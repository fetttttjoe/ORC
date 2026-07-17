export const KERNEL_ERROR_CODE = {
  task_not_found: 'task_not_found',
  invalid_transition: 'invalid_transition',
  version_conflict: 'version_conflict',
  plan_validation_failed: 'plan_validation_failed',
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
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ECONNREFUSED') return true
  const cause = (err as { cause?: unknown } | null)?.cause
  return cause !== undefined && cause !== err && isConnectionRefused(cause)
}
