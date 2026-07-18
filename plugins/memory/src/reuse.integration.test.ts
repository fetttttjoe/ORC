import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { NeighborResult } from '@orc/contracts'
import { EventLog } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'
import { createMemoryProjector } from './projector'
import { createMemoryStore } from './store'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'

describe('typed-link traversal (e2e)', () => {
  it('traverses typed links written through the store, and rebuild reconstructs edges', async () => {
    const pg = await createTestDb()
    const ts = await createTestSurreal()
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-memory-m4c-'))
    const log = await EventLog.open(pg.url)
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
