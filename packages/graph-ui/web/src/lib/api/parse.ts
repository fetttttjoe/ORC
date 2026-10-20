import type { z } from 'zod'
import { issueLine } from '@orc/contracts/guards'

// The first three issues of a failed parse, as one line naming the field path
export function describeZodError(error: z.ZodError): string {
  return error.issues.map(issueLine).slice(0, 3).join('; ')
}
