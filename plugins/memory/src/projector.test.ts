import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryProjector } from './projector'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })
const noteInput = { id: 'auth', scope: 'project', title: 'Auth', categories: [], tags: ['auth'], links: [], paths: [], rules: [], summary: 's', body: 'b' }

describe('memory projector', () => {
  it('applies written/deleted from the stream to SurrealDB + vault, and rebuilds from the log', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()

    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })
    await Bun.sleep(150)
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(true)
    expect((await surreal.get('auth', 'project'))?.title).toBe('Auth')

    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_deleted', payload: { id: 'auth', scope: 'project', author: { source: 'cli' } } })
    await Bun.sleep(150)
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(false)
    expect(await surreal.get('auth', 'project')).toBeNull()

    await proj.rebuild()   // replays memory_* from the log into a fresh store
    expect(await surreal.get('auth', 'project')).toBeNull() // deleted stayed deleted after replay
    await proj.close(); await surreal.close(); await log.close()
  })

  // planGraphHash hashes authored content AND provenance (grounded-plan.ts), so a rebuild that
  // reproduces bodies but drifts on revision/createdAt/createdBy silently changes an approved
  // plan's identity. The existing rebuild assertions only cover "deleted stays deleted" and edge
  // reconstruction — neither would notice.
  it('rebuild reproduces revision and provenance exactly, not just content', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-rebuild-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()
    try {
      // two writes by DIFFERENT authors: revision advances, createdAt/By pin to the first
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written',
        payload: { note: noteInput, author: { source: 'cli' } } })
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written',
        payload: { note: { ...noteInput, summary: 'revised' }, author: { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' } } })
      await proj.catchUp()

      const before = await surreal.allNotes()
      expect(before[0]?.revision).toBe(2)
      expect(before[0]?.createdBy).toBe('cli')
      expect(before[0]?.updatedBy).toBe('api-loop·opus·review')

      await proj.rebuild()
      expect(await surreal.allNotes()).toEqual(before)
    } finally {
      await proj.close(); await surreal.close(); await log.close()
    }
  })

  it('never scans the whole log — catch-up uses the scoped kind query', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })

    const allSpy = spyOn(log, 'all')
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()
    await proj.catchUp()
    await proj.rebuild()
    await proj.close()
    expect(allSpy).not.toHaveBeenCalled()
    expect((await surreal.get('auth', 'project'))?.title).toBe('Auth')
    await surreal.close(); await log.close()
  })
})
