import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventLog } from '@orc/kernel'
import { createTestDb, testConfig } from '@orc/kernel/test-helpers'
import { createMemory } from './index'
import { createTestSurreal } from './test-helpers'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'

describe('project isolation (SurrealDB native database boundary)', () => {
  it('two projects sharing one deployment cannot read each other’s notes', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)

    const open = async (projectId: string) => {
      const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-iso-'))
      const config = testConfig(pg.url, {
        projectId, vaultDir, skillsDir: path.join(vaultDir, 'skills'),
        projectDbUrl: ts.url, projectDbNamespace: ts.ns, projectDbName: ts.db,
        projectDbUser: ts.username, projectDbPassword: ts.password,
      })
      const log = await EventLog.open(pg.url, { projectId })
      const memory = await createMemory({ log, config })
      return { log, memory }
    }

    const a = await open(P1)
    const b = await open(P2)
    await a.memory.store.write({ id: 'only-a', title: 'A-side note', summary: 'alpha finding' }, { source: 'cli' })
    await b.memory.store.write({ id: 'only-b', title: 'B-side note', summary: 'beta finding' }, { source: 'cli' })
    await a.memory.projector.catchUp()
    await b.memory.projector.catchUp()

    expect((await a.memory.store.get('only-a'))?.title).toBe('A-side note')
    expect((await b.memory.store.get('only-b'))?.title).toBe('B-side note')
    // cross-project reads see nothing — the session's database boundary isolates them
    expect(await a.memory.store.get('only-b')).toBeNull()
    expect(await b.memory.store.get('only-a')).toBeNull()
    expect(await a.memory.store.search('beta')).toEqual([])
    expect(await b.memory.store.search('alpha')).toEqual([])

    await a.memory.close()
    await b.memory.close()
    await a.log.close()
    await b.log.close()
  })
})
