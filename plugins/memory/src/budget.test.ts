import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, type MemoryNote } from '@orc/contracts'
import { applyBudget, approxTokens, fitMemoryNoteToBudget } from './budget'

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
      scope: 's'.repeat(1_000), sourceRevision: 'r'.repeat(1_000),
      createdAt: 'c'.repeat(1_000), createdBy: 'c'.repeat(1_000),
      updatedAt: 'u'.repeat(1_000), updatedBy: 'u'.repeat(1_000), revision: 1,
    }
    const result = fitMemoryNoteToBudget(note, 1)
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_024)
  })
})
