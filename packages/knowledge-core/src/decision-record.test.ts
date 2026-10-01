import { describe, expect, it } from 'bun:test'
import { DECISION_REFUSAL, DecisionStatus, type Decision, type DecisionDraft, type DecisionWriteResult } from '@orc/contracts'
import { planDecisionRecord } from './decision-record'

const draft = (id: string, over: Partial<DecisionDraft> = {}): DecisionDraft => ({
  id, title: id, status: DecisionStatus.accepted, date: '2026-09-29', tags: ['kernel'], supersedes: null,
  context: 'c', decision: 'd', consequences: 'q', considered: ['other way'], ...over,
})
const locationOf = (d: DecisionDraft): string => `mem/${d.id}`
const recorded = (d: DecisionDraft, over: Partial<Decision> = {}): Decision => ({ ...d, supersededBy: null, location: locationOf(d), ...over })
const heldOf = (...decisions: Decision[]): Map<string, Decision> => new Map(decisions.map(d => [d.id, d]))
const plan = (held: Map<string, Decision>, d: DecisionDraft, claimed: Iterable<string> = held.keys()) =>
  planDecisionRecord({ held, claimed: new Set(claimed), draft: d, locationOf })
const result = (id: string, superseded: string | null, status = DecisionStatus.accepted): DecisionWriteResult => ({
  recorded: { id, location: `mem/${id}` }, superseded: superseded === null ? null : { id: superseded, location: `mem/${superseded}` }, status,
  files: [`mem/${id}`, ...(superseded === null ? [] : [`mem/${superseded}`])], warnings: [],
})
const supersededBy = (d: Decision, newer: string): Decision => ({ ...d, status: DecisionStatus.superseded, supersededBy: newer })

describe('planDecisionRecord', () => {
  it('a new decision is written at its location with no successor', () => {
    expect(plan(heldOf(), draft('fresh'))).toEqual({ writes: [recorded(draft('fresh'))], result: result('fresh', null) })
  })

  it('an identical record replays the existing ref and its file, and writes nothing', () => {
    const held = heldOf(recorded(draft('same')))
    expect(plan(held, draft('same', { date: '2026-10-01' }))).toEqual({ writes: [], result: result('same', null) })
  })

  it('the same id with other content is refused as exists', () => {
    const held = heldOf(recorded(draft('taken')))
    expect(() => plan(held, draft('taken', { context: 'changed' }))).toThrow(DECISION_REFUSAL.exists('taken'))
    expect(() => plan(held, draft('taken', { tags: [] }))).toThrow(DECISION_REFUSAL.exists('taken'))
    expect(() => plan(held, draft('taken', { status: DecisionStatus.proposed }))).toThrow(DECISION_REFUSAL.exists('taken'))
  })

  it('lists are compared item by item, so one two-line option is not two options', () => {
    const held = heldOf(recorded(draft('listed', { considered: ['a\nb'], tags: ['x'] })))
    expect(() => plan(held, draft('listed', { considered: ['a', 'b'], tags: ['x'] }))).toThrow(DECISION_REFUSAL.exists('listed'))
    const tagged = heldOf(recorded(draft('tagged', { tags: ['a\nb'] })))
    expect(() => plan(tagged, draft('tagged', { tags: ['a', 'b'] }))).toThrow(DECISION_REFUSAL.exists('tagged'))
  })

  it('an id a file claims although it failed to parse is refused as exists', () => {
    expect(() => plan(heldOf(), draft('broken'), ['broken'])).toThrow(DECISION_REFUSAL.exists('broken'))
  })

  it('a proposed decision may not supersede, and the old one stays untouched', () => {
    const held = heldOf(recorded(draft('old')))
    expect(() => plan(held, draft('new', { supersedes: 'old', status: DecisionStatus.proposed }))).toThrow(DECISION_REFUSAL.proposedSupersedes('new'))
    expect(held.get('old')?.status).toBe(DecisionStatus.accepted)
  })

  it('superseding an unknown decision is refused', () => {
    expect(() => plan(heldOf(), draft('new', { supersedes: 'ghost' }))).toThrow(DECISION_REFUSAL.noSuchDecision('ghost'))
  })

  it('superseding an already-superseded decision is refused', () => {
    const held = heldOf(supersededBy(recorded(draft('old')), 'newer'), recorded(draft('newer', { supersedes: 'old' })))
    expect(() => plan(held, draft('newest', { supersedes: 'old' }))).toThrow(DECISION_REFUSAL.alreadySuperseded('old'))
  })

  it('a supersession writes the new decision, then marks the old one superseded by it, and reports both files', () => {
    const old = recorded(draft('old'))
    expect(plan(heldOf(old), draft('new', { supersedes: 'old' }))).toEqual({
      writes: [recorded(draft('new', { supersedes: 'old' })), supersededBy(old, 'new')],
      result: result('new', 'old'),
    })
  })

  it('a replay of a whole supersession reports the same result as the record, and writes nothing', () => {
    const held = heldOf(supersededBy(recorded(draft('old')), 'new'), recorded(draft('new', { supersedes: 'old' })))
    expect(plan(held, draft('new', { supersedes: 'old' }))).toEqual({ writes: [], result: result('new', 'old') })
  })

  it('a replay of a half-done supersession marks the old decision, and reports the same result as the record', () => {
    const old = recorded(draft('old'))
    const held = heldOf(old, recorded(draft('new', { supersedes: 'old' })))
    expect(plan(held, draft('new', { supersedes: 'old' }))).toEqual({ writes: [supersededBy(old, 'new')], result: result('new', 'old') })
    const halfMarked = { ...old, status: DecisionStatus.superseded }
    expect(plan(heldOf(halfMarked, recorded(draft('new', { supersedes: 'old' }))), draft('new', { supersedes: 'old' })).writes)
      .toEqual([supersededBy(old, 'new')])
  })

  it('a replay leaves an old decision that another decision superseded alone', () => {
    const old = supersededBy(recorded(draft('old')), 'other')
    const held = heldOf(old, recorded(draft('new', { supersedes: 'old' })), recorded(draft('other', { supersedes: 'old' })))
    expect(plan(held, draft('new', { supersedes: 'old' }))).toEqual({ writes: [], result: result('new', 'old') })
  })

  it('a replay of a decision that was later superseded is still a replay, and names what it superseded', () => {
    const held = heldOf(
      supersededBy(recorded(draft('first')), 'middle'),
      supersededBy(recorded(draft('middle', { supersedes: 'first' })), 'last'),
      recorded(draft('last', { supersedes: 'middle' })),
    )
    expect(plan(held, draft('middle', { supersedes: 'first' }))).toEqual({ writes: [], result: result('middle', 'first', DecisionStatus.superseded) })
  })
})
