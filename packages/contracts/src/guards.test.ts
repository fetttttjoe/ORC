import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { errorMessage, nonEmptyLines, toolSchemaOf } from './guards'

describe('errorMessage', () => {
  it('unwraps Error and stringifies the rest', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('prettifies a ZodError instead of dumping issue JSON', () => {
    const r = z.object({ paths: z.array(z.string()) }).safeParse({ paths: 'src/x.ts' })
    if (r.success) throw new Error('parse unexpectedly succeeded')
    const msg = errorMessage(r.error)
    expect(msg).toContain('paths')
    expect(msg).not.toContain('"code"') // no raw issue JSON
  })
})

describe('toolSchemaOf', () => {
  it('is the input side of the schema, without $schema: a defaulted field is optional to the caller', () => {
    expect(toolSchemaOf(z.object({ id: z.string(), limit: z.number().default(5) }))).toEqual({
      type: 'object',
      properties: { id: { type: 'string' }, limit: { type: 'number', default: 5 } },
      required: ['id'],
    })
  })
})

describe('nonEmptyLines', () => {
  it('trims each line and drops blanks', () => {
    expect(nonEmptyLines('  a  \n\nb\n  \nc  ')).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array for blank input', () => {
    expect(nonEmptyLines('')).toEqual([])
    expect(nonEmptyLines('\n  \n')).toEqual([])
  })
})
