import { isRecord } from './guards'

// refuses only long multi-line content carrying literal \n and no real newline
const ESCAPED_NEWLINE = /\\n/g

// two escapes rule out a passing mention; the length floor rules out short one-liners
const MIN_ESCAPES = 2
const MIN_LENGTH = 200

export function looksDoubleEncoded(text: string): boolean {
  if (text.length < MIN_LENGTH || text.includes('\n')) return false
  return (text.match(ESCAPED_NEWLINE) ?? []).length >= MIN_ESCAPES
}

// The offending argument's name, or null. Named so the error can say WHICH field to resend.
export function doubleEncodedField(input: unknown): string | null {
  if (!isRecord(input)) return null
  for (const [key, value] of Object.entries(input))
    if (typeof value === 'string' && looksDoubleEncoded(value)) return key
  return null
}

// diagnosed, never auto-repaired: fixing silently would hide a writer mis-encoding everything
export const DOUBLE_ENCODED_HINT =
  'its escape sequences were encoded twice — it carries literal backslash-n where the text needs real newlines. The tool argument is already JSON: send real newlines, tabs and quotes, not \\n, \\t or \\".'

// decodes only sequences real source contains; a blind JSON.parse chokes on quotes and braces
export function unescapeSequences(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"')
}
