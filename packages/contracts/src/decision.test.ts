import { describe, expect, it } from 'bun:test'
import { DECISION_STATUS, DECISION_STATUSES, DecisionInput, decisionStatusOf } from './decision'

describe('decision status', () => {
  it('names the four ADR states and nothing else', () => {
    expect([...DECISION_STATUSES]).toEqual(['proposed', 'accepted', 'superseded', 'deprecated'])
  })
  // The default is a DERIVATION, not a stored value: a decision written without one (orc memory add
  // --kind decision) must read as in force, and a second spelling of 'accepted' anywhere is drift.
  it('an absent status derives to accepted; a present one is kept', () => {
    expect(decisionStatusOf(undefined)).toBe(DECISION_STATUS.accepted)
    expect(decisionStatusOf(DECISION_STATUS.proposed)).toBe(DECISION_STATUS.proposed)
  })
  it('DecisionInput requires the three sections and refuses an empty one', () => {
    const ok = DecisionInput.parse({ title: 'T', context: 'c', decision: 'd', consequences: 'q' })
    expect(ok.tags).toEqual([])
    expect(ok.status).toBeUndefined()
    expect(DecisionInput.safeParse({ title: 'T', context: '', decision: 'd', consequences: 'q' }).success).toBe(false)
    expect(DecisionInput.safeParse({ title: 'T', context: 'c', decision: 'd', consequences: 'q', status: 'final' }).success).toBe(false)
    expect(DecisionInput.safeParse({ title: 'T', context: 'c', decision: 'd', consequences: 'q', supersedes: 'Not A Slug' }).success).toBe(false)
  })
})
