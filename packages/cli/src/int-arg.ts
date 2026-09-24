import { InvalidArgumentError } from 'commander'
import { z } from 'zod'

const Digits = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int())

const integerArg = (expected: string, schema: z.ZodType<number, string>) => (value: string): number => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new InvalidArgumentError(`must be ${expected}, got '${value}'`)
  return parsed.data
}

export const parseNonNegativeInteger = integerArg('a non-negative integer', Digits)
export const parsePositiveInteger = integerArg('a positive integer (>= 1)', Digits.pipe(z.number().min(1)))
