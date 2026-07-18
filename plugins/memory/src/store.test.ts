import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { MemoryAuthor } from '@orc/contracts'
import { EventLog } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryStore } from './store'
import { gitRevision } from './index'

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

  it('replaying a write under one idempotency key leaves one memory_written event', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await EventLog.open(pg.url, { projectId: TEST_PROJECT_ID })
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const author: MemoryAuthor = { source: 'agent', runToken: 'step:t1:s1:a1' }
    const key = 'step:t1:s1:a1:tool:c1:memory:auth'
    await store.write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    await store.write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    expect(await log.all()).toHaveLength(1)
    await log.close()
  })

  it('stamps the gateway sourceRevision — agent-supplied values are overwritten', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await EventLog.open(pg.url, { projectId: TEST_PROJECT_ID })
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts), sourceRevision: 'head-sha-42' })
    await store.write({ id: 'auth', title: 'Auth', sourceRevision: 'invented-by-agent' }, { source: 'agent' })
    const [event] = await log.all()
    const { note } = z.object({ note: z.object({ sourceRevision: z.string().nullable() }) }).parse(event!.payload)
    expect(note.sourceRevision).toBe('head-sha-42')
    await log.close()
  })

  it('gitRevision returns HEAD inside a repo and null outside', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-git-'))
    expect(await gitRevision(dir)).toBeNull() // not a repo
    const sh = (...cmd: string[]) => Bun.spawn(cmd, { cwd: dir, stdout: 'ignore', stderr: 'ignore' }).exited
    await sh('git', 'init', '-q')
    await sh('git', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
    expect(await gitRevision(dir)).toMatch(/^[0-9a-f]{40}$/)
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
