import { z } from 'zod'

export enum Errno { ENOENT = 'ENOENT', EEXIST = 'EEXIST' }

const WithCode = z.object({ code: z.string() })

export const codeOf = (err: unknown): string | undefined => WithCode.safeParse(err).data?.code
