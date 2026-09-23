import { describe, expect, it } from 'bun:test'
import { ClaimClass, ClaimDraft, ClaimInput, claimId, ClaimWrite, resolveClaims } from './claim'
import { additionFixture, claimFixture } from './fixtures'
import { errorMessage } from './guards'
import { MEMORY_LIMITS } from './limits'

const REV = 'abc123'
const claim = (text: string): ClaimInput => claimFixture(text, { sourceRevision: REV })
const add = (text: string) => additionFixture(text)
const draft = (text: string) => ({ text, class: ClaimClass.fact })

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
    const out = resolveClaims(live, [add('second')], [], REV)
    expect(out.map(c => c.text)).toEqual(['first', 'second'])
  })
  it('re-adding an identical statement is a no-op, not a duplicate', () => {
    const out = resolveClaims([claim('first')], [add('first')], [], REV)
    expect(out).toHaveLength(1)
  })
  it('carries each addition’s class and stamped anchors onto the stored claim', () => {
    const anchors = [{ path: 'packages/kernel/src/kernel.ts', symbol: null, blob: 'aaa' }]
    const out = resolveClaims([], [additionFixture('second', { class: ClaimClass.why, anchors })], [], REV)
    expect(out[0]).toMatchObject({ class: ClaimClass.why, anchors })
  })
  it('re-adding live text with different metadata keeps the ORIGINAL class, anchors and revision', () => {
    const live = claimFixture('first', { class: ClaimClass.why, anchors: [{ path: 'a/b.ts', symbol: null, blob: 'aaa' }], sourceRevision: 'old' })
    const restated = additionFixture('first', { class: ClaimClass.fact, anchors: [{ path: 'c/d.ts', symbol: null, blob: 'bbb' }] })
    expect(resolveClaims([live], [restated], [], REV)).toEqual([live])
  })
  it('invalidating drops a claim from the live set', () => {
    const out = resolveClaims([claim('first'), claim('second')], [], [claimId('first')], REV)
    expect(out.map(c => c.text)).toEqual(['second'])
  })
  it('invalidating an unknown id is ignored, never an error', () => {
    expect(resolveClaims([claim('first')], [], ['deadbeef'], REV)).toHaveLength(1)
  })
  it('a claim added in the same write as its own invalidation does not survive', () => {
    const out = resolveClaims([], [add('first')], [claimId('first')], REV)
    expect(out).toEqual([])
  })
  it('keeps a surviving claim’s own sourceRevision, not the new write’s', () => {
    const older = claimFixture('first', { sourceRevision: 'old' })
    const out = resolveClaims([older], [add('second')], [], REV)
    expect(out[0]?.sourceRevision).toBe('old')
    expect(out[1]?.sourceRevision).toBe(REV)
  })

  // `.slice(0, detailItems)` here dropped exactly the NEW claims (insertion order is live-first),
  // and memory_write still returned success — the writer was told its statement was recorded when
  // the appended event carried the unchanged set. Loud beats silent, and the writer picks the fix.
  it('a note at the claim cap fails the write instead of swallowing the new statement', () => {
    const full = Array.from({ length: MEMORY_LIMITS.detailItems }, (_, i) => claim(`fact number ${i}`))
    expect(() => resolveClaims(full, [add('a brand new fact nobody has stated')], [], REV))
      .toThrow(/invalidate the claims this write supersedes/)
    // making room the way the message says lands the new claim
    const out = resolveClaims(full, [add('a brand new fact nobody has stated')], [claimId('fact number 0')], REV)
    expect(out).toHaveLength(MEMORY_LIMITS.detailItems)
    expect(out.at(-1)?.text).toBe('a brand new fact nobody has stated')
  })

  it('a writer cannot supply validFrom — the input type has no such field', () => {
    expect(Object.keys(ClaimInput.shape).sort()).toEqual(['anchors', 'class', 'id', 'sourceRevision', 'text'])
  })
})

describe('ClaimWrite', () => {
  // `"   "` cleared min(1) on the raw string, normalized to '' inside resolveClaims, and then failed
  // ClaimInput's own min(1) inside the log transaction — so the writer was handed a ZodError about
  // `claims.0.text`, a field it never sent and cannot find in the tool schema. Checked here, on the
  // field it did send, with a message that names the problem.
  it('rejects a blank statement by name, on the field the writer actually sent', () => {
    const r = ClaimWrite.safeParse({ addClaims: [draft('   ')] })
    expect(r.success).toBe(false)
    const message = r.success ? '' : errorMessage(r.error)
    expect(message).toContain('a claim cannot be blank')
    expect(message).toContain('addClaims')
  })

  it('still accepts a statement that merely has surrounding whitespace', () => {
    expect(ClaimWrite.parse({ addClaims: [draft('  the log is truth  ')] }).addClaims).toHaveLength(1)
  })

  // a bare string was the whole shape once; taking one now would store a classless, anchorless
  // statement under a schema that says both are required
  it('refuses a bare string in addClaims, naming the item that is wrong', () => {
    const r = ClaimWrite.safeParse({ addClaims: ['the log is truth'] })
    expect(r.success).toBe(false)
    expect(r.success ? '' : errorMessage(r.error)).toContain('addClaims')
  })
})

describe('ClaimDraft', () => {
  it('requires a class', () => {
    expect(ClaimDraft.safeParse({ text: 'the log is truth' }).success).toBe(false)
  })

  it('rejects classes outside the contract vocabulary', () => {
    expect(ClaimDraft.safeParse({ text: 'the log is truth', class: 'story' }).success).toBe(false)
  })

  it('defaults anchors to an empty list', () => {
    expect(ClaimDraft.parse({ text: 'the log is truth', class: 'fact' }).anchors).toEqual([])
  })

  it('strips a caller-supplied anchor blob', () => {
    const draft = ClaimDraft.parse({
      text: 'the log is truth',
      class: 'fact',
      anchors: [{ path: './packages\\kernel/src/task.ts', blob: 'caller-owned' }],
    })
    expect(draft.anchors).toEqual([{ path: 'packages/kernel/src/task.ts', symbol: null }])
    expect('blob' in draft.anchors[0]).toBe(false)
  })

  it('rejects unsafe and root-only anchor paths', () => {
    for (const path of ['/etc/passwd', 'C:\\secret.txt', '../secret.txt', 'a/../secret.txt', 'a\0b', '.'])
      expect(ClaimDraft.safeParse({ text: 'the log is truth', class: 'fact', anchors: [{ path }] }).success)
        .toBe(false)
  })
})
