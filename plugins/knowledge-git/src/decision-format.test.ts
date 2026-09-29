import { describe, expect, it } from 'bun:test'
import { DECISION_FORMAT_PROBLEM, parseDecision, parseDecisionName, renderDecision, type DecisionFile } from './decision-format'
import { DECISION_HEADINGS } from './headings'

const H = DECISION_HEADINGS
const ORDER = [H.context, H.decision, H.consequences, H.considered]
const file = (over: Partial<DecisionFile> = {}): DecisionFile => ({
  title: 'T', status: 'accepted', tags: [], supersedes: null, supersededBy: null, context: 'c', decision: 'd', consequences: 'q', considered: [], ...over,
})
const GOLDEN = `---
status: superseded
tags: checks, kernel
supersedes: older-slug
supersededBy: newer-slug
---

# Finish-gate checks report; they never block

## Context

<text>

## Decision

<text>

## Consequences

<text>

## Considered

- <option one>
- <option two
  continued>
`
const lines = (...rows: string[]): string => `${rows.join('\n')}\n`
const body = ['## Context', '', 'c', '', '## Decision', '', 'd', '', '## Consequences', '', 'q']

describe('renderDecision', () => {
  it('writes the canonical form byte for byte', () => {
    expect(renderDecision(file({
      title: 'Finish-gate checks report; they never block', status: 'superseded', tags: ['checks', 'kernel'],
      supersedes: 'older-slug', supersededBy: 'newer-slug', context: '<text>', decision: '<text>', consequences: '<text>',
      considered: ['<option one>', '<option two\ncontinued>'],
    }), H)).toBe(GOLDEN)
  })
  it('leaves out the keys and the section it has nothing for', () => {
    expect(renderDecision(file(), H)).toBe(lines('---', 'status: accepted', '---', '', '# T', '', ...body))
  })
  it('throws on a section line that starts with "## "', () => {
    expect(() => renderDecision(file({ decision: 'first\n## Other' }), H)).toThrow(DECISION_FORMAT_PROBLEM.headingInSection(H.decision))
  })
})

describe('parseDecision', () => {
  it.each([
    ['every optional key and a multi-line considered option', file({
      status: 'superseded', tags: ['checks', 'kernel'], supersedes: 'older', supersededBy: 'newer', considered: ['one', 'two\n- still two\n\n   indented'],
    })],
    ['no optional key', file()],
    ['only supersedes', file({ supersedes: 'older' })],
    ['a # line and trailing spaces inside a section', file({ context: 'first  \n# not a title\n---\nlast' })],
  ])('round-trips a file with %s', (_, written) => {
    const parsed = parseDecision(renderDecision(written, H), H)
    expect(parsed).toMatchObject({ file: written })
  })
  it('names the line of every field', () => {
    const parsed = parseDecision(renderDecision(file({ tags: ['a'], supersedes: 'older', considered: ['x'] }), H), H)
    if (!('file' in parsed)) throw new Error('did not parse')
    expect(Object.fromEntries(parsed.lines)).toEqual({
      status: 2, tags: 3, supersedes: 4, title: 7, context: 9, decision: 13, consequences: 17, considered: 21,
    })
  })
  it.each([
    ['no opening fence', lines('status: accepted', '---', '# T', ...body), 1, DECISION_FORMAT_PROBLEM.noOpening()],
    ['no closing fence', lines('---', 'status: accepted', '', '# T', ...body), 1, DECISION_FORMAT_PROBLEM.noClosing()],
    ['a line that is not key: value', lines('---', 'status accepted', '---', '', '# T', ...body), 2, DECISION_FORMAT_PROBLEM.notKeyValue()],
    ['an unknown key', lines('---', 'status: accepted', 'owner: me', '---', '', '# T', ...body), 3, DECISION_FORMAT_PROBLEM.unknownKey('owner')],
    ['a repeated key', lines('---', 'status: accepted', 'status: proposed', '---', '', '# T', ...body), 3, DECISION_FORMAT_PROBLEM.repeatedKey('status')],
    ['no status', lines('---', 'tags: a', '---', '', '# T', ...body), 3, DECISION_FORMAT_PROBLEM.noStatus()],
    ['no title', lines('---', 'status: accepted', '---', '', ...body), 5, DECISION_FORMAT_PROBLEM.noTitle()],
    ['no title before the end of the file', lines('---', 'status: accepted', '---'), 3, DECISION_FORMAT_PROBLEM.noTitle()],
    ['a second title', lines('---', 'status: accepted', '---', '', '# T', '', '# U', '', ...body), 7, DECISION_FORMAT_PROBLEM.secondTitle()],
    ['text before the first section', lines('---', 'status: accepted', '---', '', '# T', '', 'stray', '', ...body), 7, DECISION_FORMAT_PROBLEM.textBeforeSections()],
    ['sections out of order', lines('---', 'status: accepted', '---', '', '# T', '', '## Decision', '', 'd', '', '## Context', '', 'c', '', '## Consequences', '', 'q'), 7, DECISION_FORMAT_PROBLEM.unexpectedSection(H.decision, ORDER)],
    ['an unknown section', lines('---', 'status: accepted', '---', '', '# T', '', ...body, '', '## Notes', '', 'n'), 19, DECISION_FORMAT_PROBLEM.unexpectedSection('Notes', ORDER)],
    ['a section after Considered', lines('---', 'status: accepted', '---', '', '# T', '', ...body, '', '## Considered', '', '- x', '', '## More', '', 'm'), 23, DECISION_FORMAT_PROBLEM.unexpectedSection('More', ORDER)],
    ['a missing section', lines('---', 'status: accepted', '---', '', '# T', '', '## Context', '', 'c', '', '## Decision', '', 'd'), 13, DECISION_FORMAT_PROBLEM.missingSection(H.consequences)],
    ['a missing section in a file without a final newline', ['---', 'status: accepted', '---', '', '# T', '', '## Context', '', 'c'].join('\n'), 9, DECISION_FORMAT_PROBLEM.missingSection(H.decision)],
    ['a Considered section whose first line is not an option', lines('---', 'status: accepted', '---', '', '# T', '', ...body, '', '## Considered', '', 'Block on failure.', '* Report instead.'), 21, DECISION_FORMAT_PROBLEM.notAnOption(H.considered)],
    ['an empty section', lines('---', 'status: accepted', '---', '', '# T', '', '## Context', '', 'c', '', '## Decision', '', '## Consequences', '', 'q'), 11, DECISION_FORMAT_PROBLEM.emptySection(H.decision)],
  ])('reports %s with its line', (_, text, line, message) => {
    expect(parseDecision(text, H)).toEqual({ problem: { line, message } })
  })
})

describe('parseDecisionName', () => {
  it('reads the date and the id from <yyyy-mm-dd>-<slug>.md and refuses anything else', () => {
    expect(parseDecisionName('2026-09-29-finish-gate-checks.md')).toEqual({ date: '2026-09-29', id: 'finish-gate-checks' })
    expect(parseDecisionName('2026-9-1-x.md')).toBeNull()
    expect(parseDecisionName('README.md')).toBeNull()
    expect(parseDecisionName('2026-09-29-Bad.md')).toBeNull()
    expect(parseDecisionName('2026-09-29-x.mdx')).toBeNull()
    expect(parseDecisionName('2026-09-29-.md')).toBeNull()
  })
})
