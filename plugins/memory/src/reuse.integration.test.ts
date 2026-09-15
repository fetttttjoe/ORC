import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryScope, type NeighborResult } from '@orc/contracts'
import { openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { createMemoryProjector } from './projector'
import { createMemoryStore } from './store'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'

describe('typed-link traversal (e2e)', () => {
  // The link table is a function of the LIVE NOTE SET, and stays one across a delete.
  //
  // Two measurements forced this out of the per-event path. (1) SurrealDB removes a RELATE edge
  // when either endpoint record is deleted — both directions, whatever our own WHERE targets — so
  // deleting a note destroys edges its neighbours authored and never retracted. (2) Replay did not
  // repair it: the edge is created when its OWNING note's event applies, the later delete cascades
  // it away, and the owner is never rewritten. Deriving edges wholesale after a drain
  // (surreal.refreshLinks, the peer of refreshTopics) restores the invariant by construction.
  it('a deleted-then-recreated note gets back the edges its neighbours still assert', async () => {
    const pg = await createTestDb()
    const ts = await createTestSurreal()
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-memory-inbound-'))
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()

    const settle = async (): Promise<NeighborResult[]> => {
      await proj.catchUp()
      return store.neighbors('area-a')
    }
    try {
      await store.write({ id: 'area-b', title: 'B' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
      // A asserts the edge; B never says anything about A
      await store.write({ id: 'area-a', title: 'A', links: [{ id: 'area-b', kind: 'depends_on' }] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
      expect((await settle()).map(n => n.id)).toEqual(['area-b'])

      // while B is gone the edge cannot resolve — A's statement stands, its target does not
      await store.remove('area-b', MemoryScope.project, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
      expect((await settle()).map(n => n.id)).toEqual([])

      // B returns under the same id: A never wrote again, so only a derivation from the live note
      // set can bring this back — which is exactly the guarantee being pinned
      await store.write({ id: 'area-b', title: 'B again' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
      expect((await settle()).map(n => n.id)).toEqual(['area-b'])

      // and a rebuild reproduces the same graph rather than a thinner one
      await proj.rebuild()
      expect((await store.neighbors('area-a')).map(n => n.id)).toEqual(['area-b'])
    } finally {
      await proj.close()
      await log.close()
      rmSync(vaultDir, { recursive: true, force: true })
      await ts.drop()
      await pg.drop()
    }
  }, 20000)

  it('traverses typed links written through the store, and rebuild reconstructs edges', async () => {
    const pg = await createTestDb()
    const ts = await createTestSurreal()
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-memory-m4c-'))
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()

    try {
      await store.write({ id: 'decision-a', title: 'A', links: [{ id: 'decision-b', kind: 'supersedes' }] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
      await store.write({ id: 'decision-b', title: 'B' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })

      // the projector applies memory_written asynchronously — poll until the edge materializes
      let nb: NeighborResult[] = []
      for (let i = 0; i < 20 && nb.length === 0; i++) { await Bun.sleep(100); nb = await store.neighbors('decision-a') }
      expect(nb.map(n => n.id)).toEqual(['decision-b'])
      expect(nb[0]?.via).toBe('supersedes')

      // typed links land in the vault projection too
      expect(readFileSync(path.join(vaultDir, 'memory', 'decision-a.md'), 'utf8')).toContain('kind: supersedes')

      // rebuild clears + replays the memory event log; typed edges are reconstructed identically
      await proj.rebuild()
      expect((await surreal.neighbors('decision-a'))[0]).toMatchObject({ id: 'decision-b', via: 'supersedes' })
    } finally {
      await proj.close()
      await log.close()
      rmSync(vaultDir, { recursive: true, force: true })
      await ts.drop()
      await pg.drop()
    }
  }, 20000)
})
