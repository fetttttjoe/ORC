import { afterAll, describe, expect, it } from 'bun:test'
import { createTestDb, TEST_PROJECT_ID } from '../test-helpers'
import { RuntimeBusyError, acquireRuntimeLock } from './runtime-lock'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { for (const d of dbs) await d.drop() })

// A second runtime is not a queue — DBOS recovery re-executes the same step as a new attempt and
// the journal fences the loser into a step_failed, which blocks a healthy task. Observed live.
describe('acquireRuntimeLock', () => {
  it('refuses a second runtime for the same project, naming what to do', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const first = await acquireRuntimeLock(db.url, TEST_PROJECT_ID)
    await expect(acquireRuntimeLock(db.url, TEST_PROJECT_ID)).rejects.toBeInstanceOf(RuntimeBusyError)
    await expect(acquireRuntimeLock(db.url, TEST_PROJECT_ID)).rejects.toThrow(/orc graph/)
    await first.release()
  })

  it('releases on shutdown so the next runtime starts cleanly', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const first = await acquireRuntimeLock(db.url, TEST_PROJECT_ID)
    await first.release()
    const second = await acquireRuntimeLock(db.url, TEST_PROJECT_ID)
    await second.release()
  })

  // the lock is per project: unrelated projects share a database and must not block each other
  it('lets a different project hold its own runtime concurrently', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const a = await acquireRuntimeLock(db.url, TEST_PROJECT_ID)
    const b = await acquireRuntimeLock(db.url, 'some-other-project')
    await a.release()
    await b.release()
  })
})
