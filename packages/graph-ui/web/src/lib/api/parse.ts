import type { z } from 'zod'
import { issueLine } from '@orc/contracts/guards'

/**
 * The first three issues of a failed parse, as one line naming the field path — the shape both
 * `client.ts`'s `get`/`post` and `view-client.ts`'s `fetchView` report a wire mismatch with. One
 * spelling so the three error surfaces read alike; sliced to three because a whole-object shape
 * miss can carry dozens of issues and the endpoint name plus the first few is what a reader acts on.
 */
export function describeZodError(error: z.ZodError): string {
  return error.issues.map(issueLine).slice(0, 3).join('; ')
}
