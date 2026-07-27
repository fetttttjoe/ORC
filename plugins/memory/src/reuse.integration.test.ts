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

describe('typed-link traversal (e2e)', () => {
  // MEASURED, twice, and worse than it first looked. (1) SurrealDB deletes every RELATE edge
  // attached to a record when that record is deleted — both directions, regardless of what our own
  // WHERE targets, so narrowing the delete cannot preserve inbound edges. (2) A rebuild does not
  // repair it either: replay recreates A→B when A's event is applied and the later delete of B
  // cascades it away, and A is never rewritten.
  //
  // So the link index is NOT a pure function of the live note set, and no replay makes it one.
  // This test pins that, deliberately, so the gap stays visible instead of being assumed fixed —
  // the repair is a reconciliation derived from live notes (as topics are), which is a design
  // decision, not a patch. See docs/superpowers/dataflow-audit-open-findings.md.
  it('deleting a note drops inbound edges, and replay alone never restores them', async () => {
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
      await store.write({ id: 'area-b', title: 'B' }, { source: 'cli' })
      await store.write({ id: 'area-a', title: 'A', links: [{ id: 'area-b', kind: 'depends_on' }] }, { source: 'cli' })
      expect((await settle()).map(n => n.id)).toEqual(['area-b'])

      await store.remove('area-b', MemoryScope.project, { source: 'cli' })
      expect((await settle()).map(n => n.id)).toEqual([])

      // back under the same id — A's edge stays dead, because the edge ROW went with B's record
      await store.write({ id: 'area-b', title: 'B again' }, { source: 'cli' })
      expect((await settle()).map(n => n.id)).toEqual([])

      // …and NOT EVEN a rebuild restores it. Replay recreates A's edge when A's own event is
      // applied, the later memory_deleted for B cascades it away again, and A is never rewritten —
      // so the edge is gone for good while both notes are live and A still asserts it. The link
      // index is therefore not reconstructable from the log by replay alone; making it whole needs
      // a reconciliation derived from the live note set, the way topics are.
      await proj.rebuild()
      expect((await store.neighbors('area-a')).map(n => n.id)).toEqual([])
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
      await store.write({ id: 'decision-a', title: 'A', links: [{ id: 'decision-b', kind: 'supersedes' }] }, { source: 'cli' })
      await store.write({ id: 'decision-b', title: 'B' }, { source: 'cli' })

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
