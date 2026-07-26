import { describe, expect, it } from 'bun:test'
import { doubleEncodedField, looksDoubleEncoded, unescapeSequences } from './encoding'

// A whole file sent as one line with its newlines escaped — the failure this exists to catch.
const doubled = `# Title\\n\\n- one\\n- two\\n${'x'.repeat(200)}`

describe('looksDoubleEncoded', () => {
  it('catches content whose newlines are escape sequences instead of newlines', () => {
    expect(looksDoubleEncoded(doubled)).toBe(true)
  })

  it('leaves real source alone — escaped quotes and \\n inside a line are legal text', () => {
    // the exact shape that must never be refused: valid code, correctly encoded, containing both
    const source = `const s = "say \\"hi\\""\nconst nl = "\\n"\n${'// filler\n'.repeat(40)}`
    expect(looksDoubleEncoded(source)).toBe(false)
  })

  it('leaves a short string holding the two characters alone — a separator, a regex', () => {
    expect(looksDoubleEncoded('split on \\n and \\t')).toBe(false)
  })
})

describe('doubleEncodedField', () => {
  it('names the argument at fault, so the writer knows what to resend', () => {
    expect(doubleEncodedField({ path: 'a.md', content: doubled })).toBe('content')
    expect(doubleEncodedField({ path: 'a.md', content: 'fine\ntext' })).toBeNull()
    expect(doubleEncodedField('not an object')).toBeNull()
  })
})

describe('unescapeSequences', () => {
  it('decodes only the sequences that appear in real source text', () => {
    expect(unescapeSequences('a\\nb\\tc\\"d')).toBe('a\nb\tc"d')
  })
})
