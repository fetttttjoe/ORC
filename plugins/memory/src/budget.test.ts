import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, type MemoryNote } from '@orc/contracts'
import { applyBudget, approxTokens, fitMemoryNoteToBudget, TRIM_MARKER } from './budget'

// Minimal valid MemoryNote (provenance fields MemoryNoteInput doesn't cover), with overrides —
// the pattern the pre-existing budget test below builds inline, factored out for reuse.
const noteWith = (overrides: Partial<MemoryNote>): MemoryNote => ({
  ...MemoryNoteInput.parse({ id: 'n', title: 'N' }),
  sources: [],
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'cli',
  updatedAt: '2026-01-01T00:00:00.000Z', updatedBy: 'cli',
  revision: 1,
  ...overrides,
})

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
  it('keeps the complete response within the irreducible floor even with oversized provenance', () => {
    const note: MemoryNote = {
      ...MemoryNoteInput.parse({ id: 'a'.repeat(128), title: 't'.repeat(200) }),
      sources: [],
      scope: 's'.repeat(1_000), sourceRevision: 'r'.repeat(1_000),
      createdAt: 'c'.repeat(1_000), createdBy: 'c'.repeat(1_000),
      updatedAt: 'u'.repeat(1_000), updatedBy: 'u'.repeat(1_000), revision: 1,
    }
    const result = fitMemoryNoteToBudget(note, 1)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_024)
  })

  it('trims at a whitespace boundary and marks the cut — never a silent mid-word slice', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
    const { note: fitted, truncated } = fitMemoryNoteToBudget(noteWith({ body: long }), 200)
    expect(truncated).toBe(true)
    expect(fitted.body.endsWith(TRIM_MARKER)).toBe(true)
    const kept = fitted.body.slice(0, -TRIM_MARKER.length)
    expect(long.startsWith(kept.trimEnd())).toBe(true)
    expect(kept.trimEnd()).toMatch(/word\d+$/) // boundary cut: last token is whole
  })

  it('whitespace-free content keeps its budget: mid-word cut + marker, no collapse', () => {
    const { note: fitted } = fitMemoryNoteToBudget(noteWith({ body: 'x'.repeat(4_000) }), 100)
    // must NOT collapse to ~1 char: backoff only applies when whitespace exists near the cut
    expect(fitted.body.length).toBeGreaterThan(200) // well over half of contentLimit=400
    expect(fitted.body.endsWith(TRIM_MARKER)).toBe(true)
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
