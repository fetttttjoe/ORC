import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { errorMessage } from './guards'

describe('errorMessage', () => {
  it('unwraps Error and stringifies the rest', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })

  // A ZodError's .message is the raw issue-JSON dump — a model reading a tool result should get
  // the human line, not a page of JSON to re-parse.
  it('prettifies a ZodError instead of dumping issue JSON', () => {
    const r = z.object({ paths: z.array(z.string()) }).safeParse({ paths: 'src/x.ts' })
    if (r.success) throw new Error('parse unexpectedly succeeded')
    const msg = errorMessage(r.error)
    expect(msg).toContain('paths')
    expect(msg).not.toContain('"code"') // no raw issue JSON
  })
})
