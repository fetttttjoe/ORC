import { describe, expect, it } from 'bun:test'
import { ClaimInput, claimId, claimsFromLegacyRules, resolveClaims } from './claim'
import { MEMORY_LIMITS } from './limits'
import { MemoryNoteInput } from './memory'

const REV = 'abc123'
const claim = (text: string): ClaimInput => ClaimInput.parse({ id: claimId(text), text, sourceRevision: REV })

describe('claimId', () => {
  it('is stable for the same statement and insensitive to surrounding whitespace', () => {
    expect(claimId('the log is truth')).toBe(claimId('  the log is truth  '))
    expect(claimId('the log is truth')).toBe(claimId('the log  is\ttruth'))
  })
  it('differs for a reworded statement — a rewording IS a new claim', () => {
    expect(claimId('the log is truth')).not.toBe(claimId('the event log is truth'))
  })
  it('is a legal memory id (lowercase hex, no separators)', () => {
    expect(claimId('anything at all')).toMatch(/^[a-z0-9]+$/)
  })
})

describe('resolveClaims', () => {
  it('adds a statement without the caller resending the existing ones', () => {
    const live = [claim('first')]
    const out = resolveClaims(live, ['second'], [], REV)
    expect(out.map(c => c.text)).toEqual(['first', 'second'])
  })
  it('re-adding an identical statement is a no-op, not a duplicate', () => {
    const out = resolveClaims([claim('first')], ['first'], [], REV)
    expect(out).toHaveLength(1)
  })
  it('invalidating drops a claim from the live set', () => {
    const out = resolveClaims([claim('first'), claim('second')], [], [claimId('first')], REV)
    expect(out.map(c => c.text)).toEqual(['second'])
  })
  it('invalidating an unknown id is ignored, never an error', () => {
    expect(resolveClaims([claim('first')], [], ['deadbeef'], REV)).toHaveLength(1)
  })
  it('a claim added in the same write as its own invalidation does not survive', () => {
    const out = resolveClaims([], ['first'], [claimId('first')], REV)
    expect(out).toEqual([])
  })
  it('keeps a surviving claim’s own sourceRevision, not the new write’s', () => {
    const older = ClaimInput.parse({ id: claimId('first'), text: 'first', sourceRevision: 'old' })
    const out = resolveClaims([older], ['second'], [], REV)
    expect(out[0]?.sourceRevision).toBe('old')
    expect(out[1]?.sourceRevision).toBe(REV)
  })

  it('a writer cannot supply validFrom — the input type has no such field', () => {
    expect(Object.keys(ClaimInput.shape).sort()).toEqual(['id', 'sourceRevision', 'text'])
  })
})

describe('claimsFromLegacyRules', () => {
  it('maps each rule string to a claim, dated later by the projector', () => {
    const out = claimsFromLegacyRules(['a rule', 'another'], REV)
    expect(out.map(c => c.text)).toEqual(['a rule', 'another'])
    expect(out[0]?.id).toBe(claimId('a rule'))
    expect(out[0]?.sourceRevision).toBe(REV)
  })

  // History predates every limit this schema now enforces. A `.parse` inside a preprocess
  // transform throws PAST `safeParse` (a plain function call, not a parse-issue accumulator) —
  // the exact failure mode surreal.ts's projector comment calls out for memory_written: one
  // unparseable legacy payload must cost its own revision, never wedge the whole read model.
  it('a legacy rule past the text cap is truncated rather than crashing the decode, and a blank one is dropped', () => {
    const long = 'x'.repeat(MEMORY_LIMITS.detailChars + 1)
    const out = claimsFromLegacyRules([long, '   ', 'kept'], REV)
    expect(out.map(c => c.text)).toEqual([long.slice(0, MEMORY_LIMITS.detailChars), 'kept'])
  })
})

it('a note written before claims existed decodes its rules[] into claims', () => {
  const n = MemoryNoteInput.parse({ tier: 'semantic', id: 'x', title: 'X', rules: ['old rule'], sourceRevision: 'deadbeef' })
  if (n.tier !== 'semantic') throw new Error(`expected a semantic note, got '${n.tier}'`)
  expect(n.claims.map(c => c.text)).toEqual(['old rule'])
  // the legacy note was grounded at some commit; that is the honest revision for its claims
  expect(n.claims[0]?.sourceRevision).toBe('deadbeef')
})
