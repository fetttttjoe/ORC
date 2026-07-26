import { isRecord } from './guards'

// A writer that JSON-escapes its tool arguments a SECOND time sends `\n` as two characters —
// backslash, n — so the text arrives holding literal backslashes where the real characters belong.
// Detected in one place, at the boundary every tool argument crosses, because it is a property of
// the ARGUMENT, not of any one tool: catching it inside fs_edit taught fs_write nothing, and the
// next write tool would have had to learn it again.
//
// The rule is deliberately narrow. `\n` and `\"` are ordinary text in source code — a file may
// legitimately contain either, and refusing them would break valid writes. What no legitimate
// payload contains is escape sequences INSTEAD of the characters they stand for: long, obviously
// multi-line content carrying literal `\n` and not one real newline. That is unambiguous, so it is
// the only thing this refuses.
//
// ponytail: a double-escaped quote inside otherwise well-formed source is NOT separable from valid
// code here — `const s = "say \"hi\""` is legal — so it is left to typecheck and the test suite.
// Revisit only with a signal that cannot fire on real source.
const ESCAPED_NEWLINE = /\\n/g

// Two escapes rules out a passing mention of the characters; the length floor rules out a short
// one-liner that genuinely holds them (a separator constant, a regex).
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

// Diagnosed, never auto-repaired: silently fixing the encoding would hide a writer that is
// mis-encoding everything it sends, this argument included. One wording, so every surface that
// reports it says the same thing.
export const DOUBLE_ENCODED_HINT =
  'its escape sequences were encoded twice — it carries literal backslash-n where the text needs real newlines. The tool argument is already JSON: send real newlines, tabs and quotes, not \\n, \\t or \\".'

// Decodes the sequences a double-encoding writer emitted literally. Only the ones that appear in
// real source text — a blind JSON.parse would choke on unbalanced quotes and braces.
export function unescapeSequences(value: string): string {
  return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"')
}
