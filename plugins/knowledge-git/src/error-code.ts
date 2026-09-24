import { z } from 'zod'

const WithCode = z.object({ code: z.string() })

export const codeOf = (err: unknown): string | undefined => WithCode.safeParse(err).data?.code
