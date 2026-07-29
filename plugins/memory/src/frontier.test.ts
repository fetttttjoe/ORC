import { describe, expect, it } from 'bun:test'
import { frontier, type FrontierNote } from './frontier'

const NOW = '2026-07-28T00:00:00.000Z'
const n = (id: string, links: string[], updatedAt = NOW): FrontierNote =>
  ({ id, scope: 'project', title: id, tier: 'semantic', links, updatedAt })

describe('frontier', () => {
  it('ranks a note that names more than it covers, even though something reaches it', () => {
    // 'hub' claims two areas and leaf-a links back — it still qualifies because it points OUT more
    // than IN (2 vs 1), not because nothing reaches it (that case is its own test below).
    const hits = frontier([n('hub', ['leaf-a', 'leaf-b']), n('leaf-a', ['hub']), n('leaf-b', [])], NOW)
    expect(hits[0]?.id).toBe('hub')
    expect(hits[0]?.out).toBe(2)
    expect(hits[0]?.in).toBe(1)
  })

  it('does not count a link to a note that does not exist', () => {
    // dangling links are unresolvedLinks' job; counting them here would double-report one defect.
    // leaf-a links back so 'hub' clears the in>=1 floor; the dangling link must still not inflate out.
    const hits = frontier([n('hub', ['leaf-a', 'leaf-b', 'missing-note']), n('leaf-a', ['hub']), n('leaf-b', [])], NOW)
    expect(hits[0]?.id).toBe('hub')
    expect(hits[0]?.out).toBe(2)
    expect(hits[0]?.in).toBe(1)
  })

  it('decays a stale note below a fresh one with the same degree', () => {
    // fresh and stale link to each other (so each clears in>=1) and to 'leaf' — same out/in degree
    // (2/1) for both, differing only in updatedAt, so the ordering can only come from decay.
    const old = '2026-01-01T00:00:00.000Z'
    const hits = frontier([n('fresh', ['leaf', 'stale']), n('stale', ['leaf', 'fresh'], old), n('leaf', [])], NOW)
    expect(hits.map(h => h.id)).toEqual(['fresh', 'stale'])
  })

  it('excludes a note with more inbound than outbound links', () => {
    // area-contracts: the leaf every other note points AT. It is settled, not frontier.
    const hits = frontier([n('contracts', []), n('a', ['contracts']), n('b', ['contracts'])], NOW)
    expect(hits.map(h => h.id)).not.toContain('contracts')
  })

  it('excludes a note that names things but nothing reaches — a root index, not an edge', () => {
    // arch-overview on the live graph: out 12, in 0. Not a gap — a hub nothing points back to by
    // design. out>0 alone must not qualify a note; it also needs an inbound link to be ON the
    // graph's edge at all (see the in===0 exclusion in frontier.ts).
    const hits = frontier([n('root', ['leaf-a', 'leaf-b']), n('leaf-a', []), n('leaf-b', [])], NOW)
    expect(hits.map(h => h.id)).not.toContain('root')
  })

  it('ignores notes outside the semantic tier', () => {
    const plan: FrontierNote = { ...n('plan-node', ['leaf']), tier: 'plan' }
    expect(frontier([plan, n('leaf', [])], NOW)).toEqual([])
  })
})
