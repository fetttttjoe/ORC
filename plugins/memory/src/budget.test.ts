import { describe, expect, it } from 'bun:test'
import { claimId, type SemanticNote } from '@orc/contracts'
import { planNoteFixture, semanticNoteFixture } from '@orc/contracts/fixtures'
import { applyBudget, approxTokens, fitMemoryNoteToBudget, TRIM_MARKER } from './budget'

const noteWith = (overrides: Partial<SemanticNote>): SemanticNote => semanticNoteFixture(overrides)

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
    const fitted = fitMemoryNoteToBudget(noteWith({ body: 'x'.repeat(5_000), claims }), 20).note
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

  it('trims at a whitespace boundary and marks the cut — never a silent mid-word slice', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
    const { note: fitted, truncated } = fitMemoryNoteToBudget(noteWith({ body: long }), 200)
    expect(truncated).toBe(true)
    expect(fitted.body ?? '').toEndWith(TRIM_MARKER)
    const kept = (fitted.body ?? '').slice(0, -TRIM_MARKER.length)
    expect(long.startsWith(kept.trimEnd())).toBe(true)
    expect(kept.trimEnd()).toMatch(/word\d+$/) // boundary cut: last token is whole
  })

  it('whitespace-free content keeps its budget: mid-word cut + marker, no collapse', () => {
    const { note: fitted } = fitMemoryNoteToBudget(noteWith({ body: 'x'.repeat(4_000) }), 100)
    expect((fitted.body ?? '').length).toBeGreaterThan(200) // well over half of contentLimit=400
    expect(fitted.body ?? '').toEndWith(TRIM_MARKER)
  })

  it('surfaces the next-hint on truncation (regression pin — shipped behavior)', () => {
    const { next } = fitMemoryNoteToBudget(noteWith({ body: 'x'.repeat(50_000) }), 100)
    expect(next).toContain('memory_read')
  })

  it('leaves fields byte-identical and unmarked when everything fits', () => {
    const { note: fitted, truncated } = fitMemoryNoteToBudget(noteWith({ body: 'short body' }), 5_000)
    expect(truncated).toBe(false)
    expect(fitted.body).toBe('short body')
  })
})
