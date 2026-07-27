import { describe, expect, it } from 'bun:test'
import { ClaimInput, claimId, ClaimWrite, resolveClaims } from './claim'
import { errorMessage } from './guards'
import { MEMORY_LIMITS } from './limits'

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

  // `.slice(0, detailItems)` here dropped exactly the NEW claims (insertion order is live-first),
  // and memory_write still returned success — the writer was told its statement was recorded when
  // the appended event carried the unchanged set. Loud beats silent, and the writer picks the fix.
  it('a note at the claim cap fails the write instead of swallowing the new statement', () => {
    const full = Array.from({ length: MEMORY_LIMITS.detailItems }, (_, i) => claim(`fact number ${i}`))
    expect(() => resolveClaims(full, ['a brand new fact nobody has stated'], [], REV))
      .toThrow(/invalidate the claims this write supersedes/)
    // making room the way the message says lands the new claim
    const out = resolveClaims(full, ['a brand new fact nobody has stated'], [claimId('fact number 0')], REV)
    expect(out).toHaveLength(MEMORY_LIMITS.detailItems)
    expect(out.at(-1)?.text).toBe('a brand new fact nobody has stated')
  })

  it('a writer cannot supply validFrom — the input type has no such field', () => {
    expect(Object.keys(ClaimInput.shape).sort()).toEqual(['id', 'sourceRevision', 'text'])
  })
})

describe('ClaimWrite', () => {
  // `"   "` cleared min(1) on the raw string, normalized to '' inside resolveClaims, and then failed
  // ClaimInput's own min(1) inside the log transaction — so the writer was handed a ZodError about
  // `claims.0.text`, a field it never sent and cannot find in the tool schema. Checked here, on the
  // field it did send, with a message that names the problem.
  it('rejects a blank statement by name, on the field the writer actually sent', () => {
    const r = ClaimWrite.safeParse({ addClaims: ['   '] })
    expect(r.success).toBe(false)
    const message = r.success ? '' : errorMessage(r.error)
    expect(message).toContain('a claim cannot be blank')
    expect(message).toContain('addClaims')
  })

  it('still accepts a statement that merely has surrounding whitespace', () => {
    expect(ClaimWrite.parse({ addClaims: ['  the log is truth  '] }).addClaims).toHaveLength(1)
  })
})
