import { describe, expect, it } from 'bun:test'
import { linkRefusal, linkSteps, unlinkSteps, wouldCycle, type EditableStep } from './plan-edit'

const chain: EditableStep[] = [
  { id: 'a', dependsOn: [] },
  { id: 'b', dependsOn: ['a'] },
  { id: 'c', dependsOn: ['b'] },
]

// (from, to) means `to` waits on `from`; the fixture is the chain a, b, c
describe('wouldCycle', () => {
  it('sees a direct back-link', () => {
    // b already waits on a; making a wait on b closes a two-step loop
    expect(wouldCycle(chain, 'b', 'a')).toBe(true)
    // the link that already exists is not a cycle, just a duplicate
    expect(wouldCycle(chain, 'a', 'b')).toBe(false)
  })

  it('sees a TRANSITIVE loop, which is the one a reader misses', () => {
    // c already waits on b, which waits on a. Making a wait on c closes a → b → c → a.
    expect(wouldCycle(chain, 'c', 'a')).toBe(true)
    // the other direction just adds a redundant forward edge — legal
    expect(wouldCycle(chain, 'a', 'c')).toBe(false)
  })

  it('treats a self-link as a cycle', () => {
    expect(wouldCycle(chain, 'a', 'a')).toBe(true)
  })
})

describe('linkRefusal — the message the operator sees', () => {
  it('allows a legal new dependency', () => {
    expect(linkRefusal([{ id: 'x', dependsOn: [] }, { id: 'y', dependsOn: [] }], 'x', 'y')).toBeNull()
  })

  it('refuses a step waiting on itself', () => {
    expect(linkRefusal(chain, 'a', 'a')).toBe('a step cannot wait for itself')
  })

  it('refuses a duplicate rather than recording it twice', () => {
    expect(linkRefusal(chain, 'a', 'b')).toBe('that dependency already exists')
  })

  it('refuses a link that would leave the plan with no execution order', () => {
    // a already runs before c (a → b → c); making a wait on c closes the loop
    expect(linkRefusal(chain, 'c', 'a')).toContain('wait for each other')
  })

  it('allows a redundant FORWARD edge — it adds nothing, but it is not illegal', () => {
    expect(linkRefusal(chain, 'a', 'c')).toBeNull()
  })

  it('refuses a step from outside this plan', () => {
    expect(linkRefusal(chain, 'ghost', 'a')).toBe('both steps must belong to this plan')
  })
})

describe('linkSteps / unlinkSteps', () => {
  it('adds the dependency to the WAITING step, not the one waited on', () => {
    const steps: EditableStep[] = [{ id: 'x', dependsOn: [] }, { id: 'y', dependsOn: [] }]
    const next = linkSteps(steps, 'x', 'y')
    expect(next.find(s => s.id === 'y')?.dependsOn).toEqual(['x'])
    expect(next.find(s => s.id === 'x')?.dependsOn).toEqual([])
  })

  it('never mutates the caller’s array — an editor that edits the cache corrupts its own view', () => {
    const before: EditableStep[] = [{ id: 'x', dependsOn: [] }, { id: 'y', dependsOn: [] }]
    linkSteps(before, 'x', 'y')
    expect(before.find(s => s.id === 'y')?.dependsOn).toEqual([])
  })

  it('returns the steps untouched when the link is refused', () => {
    expect(linkSteps(chain, 'c', 'a')).toEqual(chain)
  })

  it('unlinks, and is a no-op for a link that was never there', () => {
    expect(unlinkSteps(chain, 'a', 'b').find(s => s.id === 'b')?.dependsOn).toEqual([])
    expect(unlinkSteps(chain, 'a', 'c').find(s => s.id === 'c')?.dependsOn).toEqual(['b'])
  })
})
