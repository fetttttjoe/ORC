import { describe, expect, it } from 'bun:test'
import { ClaimInput, claimId, resolveClaims } from './claim'

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
