import { afterAll, describe, expect, it } from 'bun:test'
import { openStorage } from './index'
import { createTestDb, TEST_PROJECT_ID } from '../test-helpers'
import { beat, forget, liveSupervisors, staleSupervisors, SUPERVISOR_STALE_MS } from './supervisors'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

async function fresh() {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  return storage
}

describe('supervisor presence', () => {
  it('a beat makes a supervisor live; one older than the stale window is not', async () => {
    const storage = await fresh()
    await beat(storage, 'exec-a', 111, 'box')
    expect((await liveSupervisors(storage, new Date())).map(s => s.executorId)).toEqual(['exec-a'])

    // `now` is a parameter precisely so staleness is testable without waiting 30s
    const later = new Date(Date.now() + SUPERVISOR_STALE_MS + 1_000)
    expect(await liveSupervisors(storage, later)).toEqual([])
    expect((await staleSupervisors(storage, later)).map(s => s.executorId)).toEqual(['exec-a'])
  })

  it('re-beating refreshes an existing row rather than adding a second', async () => {
    const storage = await fresh()
    await beat(storage, 'exec-a', 111, 'box')
    await beat(storage, 'exec-a', 111, 'box')
    expect(await liveSupervisors(storage, new Date())).toHaveLength(1)
  })

  it('forget removes the row, so a clean stop is immediately invisible', async () => {
    const storage = await fresh()
    await beat(storage, 'exec-a', 111, 'box')
    await forget(storage, 'exec-a')
    expect(await liveSupervisors(storage, new Date())).toEqual([])
  })
})
