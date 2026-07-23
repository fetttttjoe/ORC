import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { MemoryAuthor } from '@orc/contracts'
import { openStorage } from '@orc/kernel'
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
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
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

  it('recordAccess binds the event envelope to the author task identity', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.recordAccess('auth', 'project', 'read', { source: 'agent', taskId: 't1', stepId: 's1', runToken: 'r1' })
    await store.recordAccess('auth', 'project', 'read', { source: 'cli' })
    const events = await log.all()
    expect(events[0]!.taskId).toBe('t1')
    expect(events[0]!.stepId).toBe('s1')
    expect(events[0]!.runToken).toBe('r1')
    expect(events[1]!.taskId).toBeNull() // cli access stays unbound
    await log.close()
  })

  it('replaying a write under one idempotency key leaves one memory_written event', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
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
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
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

  it('upsert merges omitted fields from the existing note; explicit empty clears', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    const notePayload = z.object({ note: z.object({ title: z.string(), summary: z.string(), body: z.string(), tags: z.array(z.string()), links: z.array(z.object({ id: z.string(), kind: z.string() })) }) })
    await store.write({ id: 'auth', title: 'Auth', summary: 'tokens rotate', body: 'long body', tags: ['auth'], links: [{ id: 'other', kind: 'depends_on' }] }, { source: 'cli' })
    let events = await log.all()
    await surreal.applyEvent(events[0]!) // materialize so the gateway sees the previous revision
    // omitting body/tags/links must NOT wipe them (the graph-refresh body-wipe defect)
    await store.write({ id: 'auth', title: 'Auth v2' }, { source: 'cli' })
    events = await log.all()
    let { note } = notePayload.parse(events[1]!.payload)
    expect(note.title).toBe('Auth v2')            // supplied → replaced
    expect(note.body).toBe('long body')           // omitted → preserved
    expect(note.tags).toEqual(['auth'])
    expect(note.links).toEqual([{ id: 'other', kind: 'depends_on' }])
    // an EXPLICIT empty still clears; an undefined-valued key is an omission (CLI optional flags)
    await surreal.applyEvent(events[1]!)
    await store.write({ id: 'auth', title: 'Auth v2', body: '', summary: undefined }, { source: 'cli' })
    events = await log.all()
    note = notePayload.parse(events[2]!.payload).note
    expect(note.body).toBe('')
    expect(note.summary).toBe('tokens rotate')
    await log.close()
  })

  it('merge base folds from the log, not the projection: a stalled projector cannot regress fields', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    const notePayload = z.object({ note: z.object({ title: z.string(), body: z.string(), tags: z.array(z.string()) }) })
    // write A (full), then partial B WITHOUT projecting A — the projector is "stalled". Under the old
    // projection-based merge, surreal.get returns null and B clears body/tags into the canonical log;
    // folding the merge base from the log preserves them.
    await store.write({ id: 'auth', title: 'Auth', body: 'long body', tags: ['auth'] }, { source: 'cli' })
    await store.write({ id: 'auth', title: 'Auth v2' }, { source: 'cli' })
    const events = await log.all()
    const { note } = notePayload.parse(events[1]!.payload)
    expect(note.title).toBe('Auth v2')       // supplied → replaced
    expect(note.body).toBe('long body')       // omitted → preserved despite the un-projected first write
    expect(note.tags).toEqual(['auth'])
    await log.close()
  })

  it('rejects a malformed note without appending', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await expect(store.write({ id: 'Bad Id', title: 'x' }, { source: 'cli' })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })
})
