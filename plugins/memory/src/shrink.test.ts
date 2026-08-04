import { describe, expect, it } from 'bun:test'
import { shrinkWarnings } from './tools'

const long = 'x'.repeat(1000)

describe('shrinkWarnings (a rewrite that guts a note says so, at the moment it happens)', () => {
  /**
   * The incident this exists for: an agent meaning to CONFIRM notes had no verify tool registered,
   * fell back to memory_write, and replaced a 6235-character hub body with a 46-character
   * placeholder. Three more notes lost 55-75% of their prose the same way. Every revision was
   * recoverable from the log — but nothing said anything, and it was found days later by looking.
   */
  it('warns when a body collapses', () => {
    const w = shrinkWarnings({ body: long }, { body: 'TODO: reconstruct this' })
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('1000')
    expect(w[0]).toContain('memory_verify') // names the tool the writer probably wanted
  })

  it('warns on a collapsed summary too — it is the retrieval surface', () => {
    expect(shrinkWarnings({ summary: long }, { summary: 'x' })).toHaveLength(1)
  })

  it('says nothing when the field was OMITTED — merge-on-omit carries it forward untouched', () => {
    // the correct update shape: change claims, leave prose alone. It must not read as a deletion.
    expect(shrinkWarnings({ body: long }, {})).toEqual([])
    expect(shrinkWarnings({ body: long }, { summary: 'a new summary that is not short at all, really' })).toEqual([])
  })

  it('says nothing about ordinary tightening — a warning that always fires is one nobody reads', () => {
    expect(shrinkWarnings({ body: long }, { body: 'y'.repeat(900) })).toEqual([])
    expect(shrinkWarnings({ body: long }, { body: 'y'.repeat(501) })).toEqual([])
  })

  it('says nothing for a note too small for a ratio to mean anything', () => {
    // halving a 40-character body is not evidence of anything
    expect(shrinkWarnings({ body: 'short body here' }, { body: 'x' })).toEqual([])
  })

  it('says nothing on a CREATE — there is no previous revision to lose', () => {
    expect(shrinkWarnings(null, { body: 'x' })).toEqual([])
  })
})
