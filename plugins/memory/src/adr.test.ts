import { describe, expect, it } from 'bun:test'
import { ADR_SECTION, adrSummary, parseAdrBody, renderAdrBody } from './adr'

const fields = { context: 'We had two doors.\n\nBoth wrote notes.', decision: 'One tool records decisions.', consequences: '- fewer spellings\n- one test pins it' }

describe('adr body layout', () => {
  it('renders the three sections under fixed H2 headings, in order', () => {
    const body = renderAdrBody(fields)
    const headings = body.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3))
    expect(headings).toEqual([ADR_SECTION.context, ADR_SECTION.decision, ADR_SECTION.consequences])
  })
  it('round-trips multi-line sections exactly', () => {
    expect(parseAdrBody(renderAdrBody(fields))).toEqual(fields)
  })
  // A body written by memory_write or orc memory add is not in the layout; the reader must be told
  // rather than handed three empty sections that look authored.
  it('returns null for a body that is not in ADR layout', () => {
    expect(parseAdrBody('just prose')).toBeNull()
    expect(parseAdrBody(`## ${ADR_SECTION.context}\n\nc\n\n## Other\n\nx`)).toBeNull()
    expect(parseAdrBody(`## ${ADR_SECTION.decision}\n\nd\n\n## ${ADR_SECTION.context}\n\nc\n\n## ${ADR_SECTION.consequences}\n\nq`)).toBeNull() // order matters
  })
  // The one input that cannot round-trip is a section holding an H2 of its own; refusing it at
  // render keeps parse total on everything render produced.
  it('refuses a section that would forge a heading', () => {
    expect(() => renderAdrBody({ ...fields, decision: 'x\n## Consequences\ny' })).toThrow(/heading/)
  })
  it('adrSummary takes the first non-empty line and clips it with an ellipsis', () => {
    expect(adrSummary('\n\nFirst line.\nSecond.', 500)).toBe('First line.')
    expect(adrSummary('abcdefghij', 6)).toBe('abcde…')
    expect(adrSummary('abcdef', 6)).toBe('abcdef')
  })
})
