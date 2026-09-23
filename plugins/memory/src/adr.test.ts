import { describe, expect, it } from 'bun:test'
import { AdrSection, adrSummary, parseAdrBody, renderAdrBody } from './adr'

const fields = { context: 'We had two doors.\n\nBoth wrote notes.', decision: 'One tool records decisions.', consequences: '- fewer spellings\n- one test pins it', considered: [] }

describe('adr body layout', () => {
  it('renders the three sections under fixed H2 headings, in order', () => {
    const body = renderAdrBody(fields)
    const headings = body.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3))
    expect(headings).toEqual([AdrSection.context, AdrSection.decision, AdrSection.consequences])
  })
  it('round-trips multi-line sections exactly', () => {
    expect(parseAdrBody(renderAdrBody(fields))).toEqual(fields)
  })
  // The options a decision weighed live in the ADR body, after what the decision commits to — the
  // note carries no second copy of them.
  it('renders the considered options as a list under a fourth heading, after consequences', () => {
    const body = renderAdrBody({ ...fields, considered: ['keep both doors', 'one door, two renderers'] })
    const headings = body.split('\n').filter(l => l.startsWith('## ')).map(l => l.slice(3))
    expect(headings).toEqual([AdrSection.context, AdrSection.decision, AdrSection.consequences, AdrSection.considered])
    expect(body).toContain('- keep both doors\n- one door, two renderers')
  })
  it('round-trips a multiline considered option', () => {
    const considered = ['keep both doors', 'one door, two renderers\nwhich costs a second parse\nand a second test']
    expect(parseAdrBody(renderAdrBody({ ...fields, considered }))?.considered).toEqual(considered)
  })
  // A body written by memory_write or orc memory add is not in the layout; the reader must be told
  // rather than handed three empty sections that look authored.
  it('returns null for a body that is not in ADR layout', () => {
    expect(parseAdrBody('just prose')).toBeNull()
    expect(parseAdrBody(`## ${AdrSection.context}\n\nc\n\n## Other\n\nx`)).toBeNull()
    expect(parseAdrBody(`## ${AdrSection.decision}\n\nd\n\n## ${AdrSection.context}\n\nc\n\n## ${AdrSection.consequences}\n\nq`)).toBeNull() // order matters
    expect(parseAdrBody(`## ${AdrSection.context}\n\nc\n\n## ${AdrSection.decision}\n\nd\n\n## ${AdrSection.considered}\n\n- a\n\n## ${AdrSection.consequences}\n\nq`)).toBeNull()
  })
  // The one input that cannot round-trip is a section holding an H2 of its own; refusing it at
  // render keeps parse total on everything render produced.
  it('refuses a section that would forge a heading', () => {
    expect(() => renderAdrBody({ ...fields, decision: 'x\n## Consequences\ny' })).toThrow(/heading/)
  })
  // an option's continuation lines are indented, so a heading inside one is text, not a section
  it('keeps an H2 inside a considered option as text', () => {
    const considered = ['x\n## Consequences\ny']
    expect(parseAdrBody(renderAdrBody({ ...fields, considered }))?.considered).toEqual(considered)
  })
  it('adrSummary takes the first non-empty line and clips it with an ellipsis', () => {
    expect(adrSummary('\n\nFirst line.\nSecond.', 500)).toBe('First line.')
    expect(adrSummary('abcdefghij', 6)).toBe('abcde…')
    expect(adrSummary('abcdef', 6)).toBe('abcdef')
  })
})
