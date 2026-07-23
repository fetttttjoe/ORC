import { describe, expect, it } from 'bun:test'
import { slugId, MEMORY_ID_RE } from './memory'

describe('slugId', () => {
  it('derives a MEMORY_ID_RE-safe id from a human title', () => {
    expect(slugId('Postgres Tuning Notes!')).toBe('postgres-tuning-notes')
    expect(slugId('  Ümlauts & spaces  ')).toBe('mlauts-spaces')
    expect(MEMORY_ID_RE.test(slugId('A'.repeat(200)))).toBe(true)
    expect(slugId('A'.repeat(200)).length).toBeLessThanOrEqual(64)
  })
  it('is deterministic — same title, same id (capture is an upsert, not a fork)', () => {
    expect(slugId('My Note')).toBe(slugId('My Note'))
  })
  it('throws a friendly error when nothing sluggable remains', () => {
    expect(() => slugId('!!!')).toThrow(/cannot derive a note id/)
  })
})
