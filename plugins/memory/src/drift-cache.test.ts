import { describe, expect, it } from 'bun:test'
import { createDriftCache } from './drift-cache'

/** counts how often the expensive half actually ran — the whole point of the cache */
const counting = (fingerprint: () => Promise<string | null>) => {
  let runs = 0
  const inner = createDriftCache<number>(fingerprint)
  const cache = (cursor: number) => inner(cursor, async () => { runs += 1; return runs })
  return { cache, runs: () => runs }
}

describe('createDriftCache (exact invalidation, never a TTL)', () => {
  it('recomputes once while the cursor and the tree both hold still', async () => {
    const { cache, runs } = counting(async () => 'TREE-1')
    expect(await cache(10)).toBe(1)
    expect(await cache(10)).toBe(1)
    expect(await cache(10)).toBe(1)
    expect(runs()).toBe(1)
  })

  it('recomputes when the CORPUS moves — new events, same tree', async () => {
    const { cache, runs } = counting(async () => 'TREE-1')
    await cache(10)
    await cache(11)
    expect(runs()).toBe(2)
  })

  it('recomputes when the TREE moves under a still corpus', async () => {
    // the case a cursor-only key would miss, and the one drift exists to catch: nothing was
    // appended, someone edited a file
    let tree = 'TREE-1'
    const { cache, runs } = counting(async () => tree)
    await cache(10)
    tree = 'TREE-2'
    await cache(10)
    expect(runs()).toBe(2)
  })

  it('never caches a tree it cannot fingerprint', async () => {
    // no repo, or git failed: with nothing to invalidate against, a hit could serve a verdict for a
    // tree that has completely changed
    const { cache, runs } = counting(async () => null)
    await cache(10)
    await cache(10)
    expect(runs()).toBe(2)
  })

  it('returns to a cached value after the tree moves back', async () => {
    // the memo holds ONE entry, so this recomputes — asserted so the single-slot behaviour is a
    // stated choice rather than an accident someone later "fixes" into an unbounded map
    let tree = 'TREE-1'
    const { cache, runs } = counting(async () => tree)
    await cache(10)
    tree = 'TREE-2'; await cache(10)
    tree = 'TREE-1'; await cache(10)
    expect(runs()).toBe(3)
  })
})
