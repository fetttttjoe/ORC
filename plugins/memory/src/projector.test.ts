import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventLog } from '@orc/kernel'
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
    const log = await EventLog.open(pg.url, { projectId: TEST_PROJECT_ID })
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
})
