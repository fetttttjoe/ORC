import { describe, expect, it } from 'bun:test'
import {
  byAttention, clipLine, DECISION_LIMITS, DECISION_REFUSAL, DECISION_STATUS, DecisionInput, DecisionStatus, decisionSlugOf, decisionStatusOf,
  decisionSummaryOf, type Decision,
} from './decision'
import { DECISION_SLUG_CHARS } from './knowledge-ref'

const sections = { title: 'T', context: 'c', decision: 'd', consequences: 'q' }
const decision = (id: string, status: DecisionStatus, date: string, over: Partial<Decision> = {}): Decision => ({
  id, title: id, status, date, tags: [], supersedes: null, supersededBy: null, context: 'c', decision: 'd', consequences: 'q',
  considered: [], location: `docs/decisions/${date}-${id}.md`, ...over,
})

describe('decision status', () => {
  it('names the four ADR states and nothing else', () => {
    expect(Object.values(DecisionStatus)).toEqual([DecisionStatus.proposed, DecisionStatus.accepted, DecisionStatus.superseded, DecisionStatus.deprecated])
  })
  it('an absent status derives to accepted; a present one is kept', () => {
    expect(decisionStatusOf(undefined)).toBe(DECISION_STATUS.accepted)
    expect(decisionStatusOf(DECISION_STATUS.proposed)).toBe(DECISION_STATUS.proposed)
  })
})

describe('DecisionInput', () => {
  it('requires the three sections and refuses an empty one, an unknown status and a malformed supersedes', () => {
    const ok = DecisionInput.parse(sections)
    expect(ok.tags).toEqual([])
    expect(ok.status).toBeUndefined()
    expect(DecisionInput.safeParse({ ...sections, context: '' }).success).toBe(false)
    expect(DecisionInput.safeParse({ ...sections, status: 'final' }).success).toBe(false)
    expect(DecisionInput.safeParse({ ...sections, supersedes: 'Not A Slug' }).success).toBe(false)
  })
  it('refuses superseded as a recorded status', () => {
    expect(DecisionInput.safeParse({ ...sections, status: DecisionStatus.proposed }).success).toBe(true)
    expect(DecisionInput.safeParse({ ...sections, status: DecisionStatus.superseded }).success).toBe(false)
  })
  it('refuses a section line that starts with "## "', () => {
    expect(DecisionInput.safeParse({ ...sections, context: 'fine\n# a title line is fine' }).success).toBe(true)
    expect(DecisionInput.safeParse({ ...sections, context: 'first\n## Decision' }).success).toBe(false)
    expect(DecisionInput.safeParse({ ...sections, considered: ['one', 'two\n## Consequences'] }).success).toBe(false)
  })
})

describe('decisionSlugOf', () => {
  it('cuts at 80 characters on a clean edge and refuses a title with no latin letters or digits', () => {
    const title = `${'a'.repeat(DECISION_SLUG_CHARS - 1)} ${'b'.repeat(20)}`
    const slug = decisionSlugOf(title)
    expect(slug.length).toBeLessThanOrEqual(DECISION_SLUG_CHARS)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toBe('a'.repeat(DECISION_SLUG_CHARS - 1))
    expect(decisionSlugOf('  Finish-gate checks report; they never block!  ')).toBe('finish-gate-checks-report-they-never-block')
    expect(() => decisionSlugOf('—')).toThrow(DECISION_REFUSAL.noSlug('—'))
  })
})

describe('byAttention', () => {
  it('orders proposed, accepted, deprecated, superseded; newest first within a status; then id', () => {
    const shuffled = [
      decision('old-superseded', DecisionStatus.superseded, '2026-09-29'),
      decision('b-accepted', DecisionStatus.accepted, '2026-09-01'),
      decision('deprecated', DecisionStatus.deprecated, '2026-09-29'),
      decision('a-accepted', DecisionStatus.accepted, '2026-09-01'),
      decision('new-accepted', DecisionStatus.accepted, '2026-09-20'),
      decision('proposed', DecisionStatus.proposed, '2026-01-01'),
    ]
    expect(shuffled.toSorted(byAttention).map(d => d.id))
      .toEqual(['proposed', 'new-accepted', 'a-accepted', 'b-accepted', 'deprecated', 'old-superseded'])
  })
})

describe('decisionSummaryOf', () => {
  it('takes the first non-empty line of the Decision section and clips it', () => {
    const d = decision('x', DecisionStatus.accepted, '2026-09-29', { decision: '\n  The log is the only writer.  \nMore detail.', supersedes: 'w', supersededBy: 'y' })
    expect(decisionSummaryOf(d)).toEqual({
      id: 'x', title: 'x', status: DecisionStatus.accepted, date: '2026-09-29', summary: 'The log is the only writer.', supersedes: 'w', supersededBy: 'y',
    })
    const long = decisionSummaryOf({ ...d, decision: 'z'.repeat(DECISION_LIMITS.summaryChars + 5) }).summary
    expect(long).toBe(`${'z'.repeat(DECISION_LIMITS.summaryChars - 1)}…`)
    expect(decisionSummaryOf({ ...d, decision: 'z'.repeat(DECISION_LIMITS.summaryChars) }).summary).toBe('z'.repeat(DECISION_LIMITS.summaryChars))
  })
})

describe('clipLine', () => {
  it('keeps the first non-empty line, trimmed, and clips at the limit with an ellipsis', () => {
    expect(clipLine('\n  first line  \nsecond', 50)).toBe('first line')
    expect(clipLine('abcdef', 6)).toBe('abcdef')
    expect(clipLine('abcdefg', 6)).toBe('abcde…')
    expect(clipLine('', 6)).toBe('')
  })
})
