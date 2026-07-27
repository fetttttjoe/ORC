import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { claimId, EVENT_KIND, MemoryAccessedPayload, MemoryAuthor, MemoryTopicAccessedPayload, MemoryWrittenPayload, NOTE_TIER, type AccessVia } from '@orc/contracts'
import { openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryStore } from './store'
import { gitRevision } from './index'

const drops: (() => Promise<void>)[] = []
// Concurrent drops with a real hook budget — the same fix and reason as surreal.test.ts's teardown:
// serial drops blew bun's default 5s budget as soon as this file grew another describe block, and a
// timed-out teardown leaves throwaway Postgres/Surreal databases behind.
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

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

  it('recordAccess with via appends a payload that parses MemoryAccessedPayload including via', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const via: AccessVia = { seed: 'net-topology', kind: 'supersedes', direction: 'out' }
    await store.recordAccess('auth', 'project', 'read', { source: 'cli' }, { via })
    const events = await log.all()
    const payload = MemoryAccessedPayload.parse(events[0]!.payload)
    expect(payload.via).toEqual(via)
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

  it('tolerates a keyed replay whose payload changed only by the gateway stamp (typed conflict, not a throw)', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const author: MemoryAuthor = { source: 'agent', runToken: 'step:t1:s1:a1' }
    const key = 'step:t1:s1:a1:tool:c1:memory:auth'
    // same tool call replayed after a restart: identical draft, but a new Git HEAD stamp → the
    // memory_written payload DIFFERS. The event log throws KernelError(idempotency_conflict); the
    // gateway must recognize it by CODE and swallow it (the first write stands), not fail the op.
    await createMemoryStore({ log, surreal, sourceRevision: async () => 'sha-A' }).write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    await createMemoryStore({ log, surreal, sourceRevision: async () => 'sha-B' }).write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    expect(await log.all()).toHaveLength(1) // one event; the differing replay was tolerated, not thrown
    await log.close()
  })

  it('stamps the gateway sourceRevision — agent-supplied values are overwritten', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts), sourceRevision: async () => 'head-sha-42' })
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

// The revision only ever stamps a WRITE, and resolving it shells out to git. Every `orc memory`
// command opened a store, so every read paid a subprocess spawn for a value it never used.
// Only the semantic tier has a `claims` column, so MemoryNoteInput.parse silently dropped a
// resolved claim set on any other tier — and the writer was told it worked. inferTier returns
// `plan` for any non-empty rationale, and rationale sits beside addClaims in the same tool schema.
describe('claims on a tier that cannot hold them', () => {
  it('throws instead of dropping the statement and reporting success', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    try {
      await expect(store.write(
        { id: 'p1', title: 'A plan note', rationale: 'why this subplan exists', addClaims: ['a durable statement'] },
        { source: 'cli' },
      )).rejects.toThrow(/semantic-tier/)
      // and nothing was appended — the failure is total, not a half-written note
      expect(await store.get('p1')).toBeNull()
    } finally {
      await log.close()
    }
  })

  it('still accepts claims on a semantic note', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    try {
      await store.write({ id: 's1', title: 'A fact', addClaims: ['a durable statement'] }, { source: 'cli' })
    } finally {
      await log.close()
    }
  })
})

describe('sourceRevision is resolved lazily', () => {
  it('is never asked for on a read path, and re-resolved on EVERY write', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    let calls = 0
    const store = createMemoryStore({ log, surreal, sourceRevision: async () => { calls++; return 'abc123' } })

    await store.get('nothing')
    await store.list()
    await store.search('x')
    expect(calls).toBe(0)

    // ONE PER WRITE, not one per store. This assertion used to read `toBe(1)` and locked in a
    // memoization that made a supervisor stamp every note it ever wrote with the commit it booted
    // at — in the immutable log, where no rebuild heals it, and under a drift check that then
    // reported moved code as current. The saving was never real either: only writes resolve it.
    await store.write({ id: 'n1', title: 'N1' }, { source: 'cli' })
    await store.write({ id: 'n2', title: 'N2' }, { source: 'cli' })
    expect(calls).toBe(2)
    await log.close()
  })
})

describe('additive claim writes', () => {
  const openStore = async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    return { log, store: createMemoryStore({ log, surreal: await SurrealMemory.open(ts) }) }
  }
  const lastWrite = async (log: EventLog) => MemoryWrittenPayload.parse((await log.all()).at(-1)?.payload)
  const claimsOf = (p: MemoryWrittenPayload) => p.note.tier === NOTE_TIER.semantic ? p.note.claims : []

  it('adds one claim without the writer resending the others', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first'] }, { source: 'cli' })
    await store.write({ id: 'n', title: 'N', addClaims: ['second'] }, { source: 'cli' })

    expect(claimsOf(await lastWrite(log)).map(c => c.text)).toEqual(['first', 'second'])
    await log.close()
  })

  it('invalidating drops a claim and records the tombstone on the EVENT, not the note', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first', 'second'] }, { source: 'cli' })
    await store.write({ id: 'n', title: 'N' }, { source: 'cli' }, { invalidates: [claimId('first')] })

    const last = await lastWrite(log)
    expect(claimsOf(last).map(c => c.text)).toEqual(['second'])
    expect(last.invalidates).toEqual([claimId('first')])
    await log.close()
  })

  // The whole point of `invalidates` being STATED: the store merges on omit, so a write that simply
  // does not mention a claim must carry it forward. Absence can never mean deletion.
  it('a write that mentions no claims at all leaves the live set untouched', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first'] }, { source: 'cli' })
    await store.write({ id: 'n', title: 'N', summary: 'unrelated edit' }, { source: 'cli' })

    const last = await lastWrite(log)
    expect(claimsOf(last).map(c => c.text)).toEqual(['first'])
    expect(last.invalidates).toEqual([])
    await log.close()
  })

  it('addClaims is an instruction, never stored: the payload carries resolved claims only', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first'] }, { source: 'cli' })
    expect(JSON.stringify((await lastWrite(log)).note)).not.toContain('addClaims')
    await log.close()
  })
})

// Against the REAL store, not a fake: the operator's stated reason for making topics a tool rather
// than an implicit re-rank was that the access be tracked ("let them ask via a tool so we cna
// track"), and store.topicClaims is the only code that makes that true. A fake proves the tool
// formats output; only this proves the event lands, once, with the label resolved.
describe('topic fetches are tracked', () => {
  const vec = (text: string): number[] => (/alpha|zeta/.test(text) ? [1, 0, 0] : [0, 1, 0])
  const topicAccesses = async (log: EventLog) =>
    (await log.all()).filter(e => e.kind === EVENT_KIND.memory_topic_accessed)

  const openTopics = async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts, { embed: async texts => texts.map(vec) })
    const store = createMemoryStore({ log, surreal })
    await store.write({ id: 'n', title: 'N', addClaims: ['alpha holds', 'beta holds'] }, { source: 'cli' })
    for (const e of await log.all()) await surreal.applyEvent(e)
    await surreal.refreshTopics()
    return { log, store }
  }

  it('one fetch appends exactly one memory_topic_accessed, carrying the resolved label', async () => {
    const { log, store } = await openTopics()
    const [topic] = await store.topics()
    const claims = await store.topicClaims(topic!.topicKey, { source: 'agent', taskId: 't1', stepId: 's1', runToken: 'r1' })
    expect(claims).toHaveLength(topic!.size)

    const tracked = await topicAccesses(log)
    expect(tracked).toHaveLength(1)
    // the label rides the EVENT because the read model is disposable — a rebuild would erase it
    expect(MemoryTopicAccessedPayload.parse(tracked[0]!.payload)).toMatchObject({ topicKey: topic!.topicKey, label: topic!.label })
    // and the envelope binds it to the acting step, the same rule recordAccess follows: task-scoped
    // views filter on the envelope, so an unbound append orphans the fetch from the run that made it
    expect(tracked[0]).toMatchObject({ taskId: 't1', stepId: 's1', runToken: 'r1' })
    await log.close()
  })

  it('a keyed replay of one fetch appends one event, not two', async () => {
    const { log, store } = await openTopics()
    const [topic] = await store.topics()
    const author: MemoryAuthor = { source: 'agent', runToken: 'r1' }
    const key = `r1:tool:c1:topic:${topic!.topicKey}`
    await store.topicClaims(topic!.topicKey, author, { idempotencyKey: key })
    await store.topicClaims(topic!.topicKey, author, { idempotencyKey: key })
    expect(await topicAccesses(log)).toHaveLength(1)
    await log.close()
  })

  it('listing the inventory records nothing — only a fetch is a signal', async () => {
    const { log, store } = await openTopics()
    expect((await store.topics()).length).toBeGreaterThan(0)
    expect(await topicAccesses(log)).toEqual([])
    await log.close()
  })

  it('an unknown key throws rather than returning empty, and records no signal for it', async () => {
    const { log, store } = await openTopics()
    await expect(store.topicClaims('deadbeef0000', { source: 'cli' })).rejects.toThrow(/list topics again/)
    expect(await topicAccesses(log)).toEqual([])
    await log.close()
  })
})
