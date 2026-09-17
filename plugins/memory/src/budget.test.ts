import { describe, expect, it } from 'bun:test'
import { claimId } from '@orc/contracts'
import { planNoteFixture, semanticNoteFixture } from '@orc/contracts/fixtures'
import { applyBudget, approxTokens, fitMemoryNoteToBudget, TRIM_MARKER } from './budget'

describe('applyBudget', () => {
  it('caps by count and by token budget, reporting truncation + omitted', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, body: 'x'.repeat(40) })) // ~10 tok each
    const r = applyBudget(items, i => i.body, { limit: 5, budget: 9999 })
    expect(r.items).toHaveLength(5); expect(r.truncated).toBe(true); expect(r.omitted).toBe(5)
    const b = applyBudget(items, i => i.body, { limit: 100, budget: 25 })   // ~2 items fit
    expect(b.items.length).toBeLessThan(10); expect(b.truncated).toBe(true)
    expect(approxTokens('x'.repeat(40))).toBe(10)
  })

  it('always keeps at least the first item even over budget', () => {
    const r = applyBudget([{ body: 'x'.repeat(400) }], i => i.body, { limit: 5, budget: 10 })
    expect(r.items).toHaveLength(1); expect(r.truncated).toBe(false)
  })
})

describe('fitMemoryNoteToBudget', () => {
  // Claims are the retrieval surface and the body is the fidelity layer, so when only one of the two
  // fits, the statements are what a reader can act on. Pinned because the ordering is implicit in
  // the refill ladder — every list refills ahead of the long prose, and nothing else says so.
  it('spends the budget on claims and makes the body pay', () => {
    const claims = [{ id: claimId('keep me'), text: 'keep me', sourceRevision: null }]
    const fitted = fitMemoryNoteToBudget(semanticNoteFixture({ body: 'x'.repeat(5_000), claims }), 20).note
    expect(fitted.claims).toEqual(claims)            // the retrieval surface survives intact
    expect(fitted.body ?? '').toEndWith(TRIM_MARKER) // the fidelity layer is what got cut for it
  })

  // The plan tier's execution plumbing is bounded per-field by the schema but was exempt from the
  // fitter entirely: 16 skillRefs + 16 toolRefs + a modelRef is ~2KB riding the note spread past
  // every discard, against a 1KB floor. Same shape of leak a retired `rules[]` had.
  it('bounds the plan tier’s execution plumbing — skillRefs/toolRefs/modelRef are not exempt', () => {
    const note = planNoteFixture({
      id: 'plumbing', title: 'P',
      skillRefs: Array.from({ length: 16 }, (_, i) => `skill-${i}-${'s'.repeat(50)}`),
      toolRefs: Array.from({ length: 16 }, (_, i) => `web/tool-${i}-${'t'.repeat(48)}`),
      modelRef: `anthropic/${'m'.repeat(50)}`,
    })
    const result = fitMemoryNoteToBudget(note, 1)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_024)
  })

  // dependsOn was the one refilled-group field with neither a blank nor an addList: it rode the
  // `{...note}` spread through every discard whole. At the contracts max (100 ids × 64 chars) that
  // is ~6.6KB against the 1KB response floor — same leak class as skillRefs/toolRefs above.
  it('bounds the plan tier’s dependsOn — the ordering list is not exempt', () => {
    const note = planNoteFixture({
      id: 'ordering', title: 'P',
      dependsOn: Array.from({ length: 100 }, (_, i) => `dep-${i}-${'d'.repeat(55)}`.slice(0, 64)),
    })
    const result = fitMemoryNoteToBudget(note, 1)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_024)
  })

  it('keeps the complete response within the irreducible floor even with oversized provenance', () => {
    // a PLAN note: the only tier with all three trimmable text fields, so this exercises the
    // whole ladder in one case
    const note = planNoteFixture({
      id: 'a'.repeat(128), title: 't'.repeat(200),
      summary: 's'.repeat(50), rationale: 'r'.repeat(50), body: 'b'.repeat(50),
      scope: 's'.repeat(1_000), sourceRevision: 'r'.repeat(1_000),
      createdAt: 'c'.repeat(1_000), createdBy: 'c'.repeat(1_000),
      updatedAt: 'u'.repeat(1_000), updatedBy: 'u'.repeat(1_000), revision: 1,
    })
    const result = fitMemoryNoteToBudget(note, 1)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_024)
    // contentLimit=4 is smaller than TRIM_MARKER itself: summary/rationale/body all get forced
    // to low===0 — left empty, not a bare-marker stub with no content in front of it.
    expect(result.note.summary).toBe('')
    expect(result.note.rationale).toBe('')
    expect(result.note.body).toBe('')
    expect(JSON.stringify(result.note)).not.toContain(TRIM_MARKER)
  })

  // `verified` is agent-adjacent input (a composed `by`, a git `revision`) with no schema max —
  // same leak class as the plan tier's skillRefs/toolRefs/dependsOn before those got bounded here.
  // The response-byte cap alone does NOT pin the clamp: the discard ladder's `delete fitted.verified`
  // rung already guarantees the cap by nuking the field outright once anything doesn't fit, so an
  // unclamped stamp still respects the cap — it just loses the auditor's revision/at/by entirely
  // instead of keeping a usefully-bounded one. Asserting the fields survive, clamped, is what
  // actually pins the build-time clamp (the block right after `fitted` is constructed) rather than
  // the ladder's unconditional fallback.
  it('clamps an oversized verified stamp instead of letting the ladder drop it entirely', () => {
    const note = semanticNoteFixture({
      verified: { revision: 'r'.repeat(5_000), at: 'a'.repeat(5_000), by: 'b'.repeat(5_000) },
    })
    const result = fitMemoryNoteToBudget(note, 1)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_024)
    expect(result.note.verified?.revision.length).toBeLessThanOrEqual(128)
    expect(result.note.verified?.at.length).toBeLessThanOrEqual(128)
    expect(result.note.verified?.by.length).toBeLessThanOrEqual(200)
  })

  it('trims at a whitespace boundary and marks the cut — never a silent mid-word slice', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
    const { note: fitted, truncated } = fitMemoryNoteToBudget(semanticNoteFixture({ body: long }), 200)
    expect(truncated).toBe(true)
    expect(fitted.body ?? '').toEndWith(TRIM_MARKER)
    const kept = (fitted.body ?? '').slice(0, -TRIM_MARKER.length)
    expect(long.startsWith(kept.trimEnd())).toBe(true)
    expect(kept.trimEnd()).toMatch(/word\d+$/) // boundary cut: last token is whole
  })

  it('whitespace-free content keeps its budget: mid-word cut + marker, no collapse', () => {
    const { note: fitted } = fitMemoryNoteToBudget(semanticNoteFixture({ body: 'x'.repeat(4_000) }), 100)
    expect((fitted.body ?? '').length).toBeGreaterThan(200) // well over half of contentLimit=400
    expect(fitted.body ?? '').toEndWith(TRIM_MARKER)
  })

  it('surfaces the next-hint on truncation (regression pin — shipped behavior)', () => {
    const { next } = fitMemoryNoteToBudget(semanticNoteFixture({ body: 'x'.repeat(50_000) }), 100)
    expect(next).toContain('memory_read')
  })

  it('leaves fields byte-identical and unmarked when everything fits', () => {
    const { note: fitted, truncated } = fitMemoryNoteToBudget(semanticNoteFixture({ body: 'short body' }), 5_000)
    expect(truncated).toBe(false)
    expect(fitted.body).toBe('short body')
  })
})
