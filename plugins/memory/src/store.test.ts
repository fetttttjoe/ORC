import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { MemoryAuthor } from '@orc/contracts'
import { EventLog } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryStore } from './store'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

describe('MemoryStore gateway', () => {
  it('write appends a memory_written event with stamped provenance and null taskId', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await EventLog.open(pg.url, { projectId: TEST_PROJECT_ID })
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.write({ id: 'auth', title: 'Auth' }, { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' })
    const events = await log.all()
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('memory_written')
    expect(events[0]!.taskId).toBeNull()
    const { author } = z.object({ author: MemoryAuthor }).parse(events[0]!.payload)
    expect(author.executor).toBe('api-loop')
    await log.close()
  })

  it('rejects a malformed note without appending', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await EventLog.open(pg.url, { projectId: TEST_PROJECT_ID })
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await expect(store.write({ id: 'Bad Id', title: 'x' }, { source: 'cli' })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })
})
