import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { claimId, EVENT_KIND, MEMORY_USE, MemoryAccessedPayload, MemoryAuthor, MemoryOutcomePayload, MemoryScope, MemoryTopicAccessedPayload, MemoryVerifiedPayload, MemoryWrittenPayload, NOTE_TIER, type AccessVia } from '@orc/contracts'
import { gitRevision, openStorage, type EventLog } from '@orc/kernel'
import { TEST_WORKSPACE_ID, createTestDb, TEST_PROJECT_ID, type TestDb } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryStore, STORE_REFUSAL } from './store'

const drops: (() => Promise<void>)[] = []
// Concurrent drops with a real hook budget — the same fix and reason as surreal.test.ts's teardown:
// serial drops blew bun's default 5s budget as soon as this file grew another describe block, and a
// timed-out teardown leaves throwaway Postgres/Surreal databases behind.
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

// Teardown must be unconditional: a bare `await log.close()` after the assertions is skipped the
// moment an expect above it throws, and the leaked pool's backends get FORCE-terminated by the
// database drop instead of closing cleanly. TestDb.onClose is the seam built for exactly this —
// it runs the close BEFORE the drop, and a throwing closer never masks the test's own failure.
const openLog = async (pg: TestDb): Promise<EventLog> => {
  const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
  pg.onClose(() => log.close())
  return log
}

describe('MemoryStore gateway', () => {
  it('write appends a memory_written event with stamped provenance and null taskId', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.write({ id: 'auth', title: 'Auth' }, { source: 'agent', workspaceId: TEST_WORKSPACE_ID, executor: 'api-loop', model: 'opus', role: 'review' })
    const events = await log.all()
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('memory_written')
    expect(events[0]!.taskId).toBeNull()
    const { author } = z.object({ author: MemoryAuthor }).parse(events[0]!.payload)
    expect(author.executor).toBe('api-loop')
  })

  it('recordAccess binds the event envelope to the author task identity', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.recordAccess('auth', 'project', 'read', { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't1', stepId: 's1', runToken: 'r1' })
    await store.recordAccess('auth', 'project', 'read', { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    const events = await log.all()
    expect(events[0]!.taskId).toBe('t1')
    expect(events[0]!.stepId).toBe('s1')
    expect(events[0]!.runToken).toBe('r1')
    expect(events[1]!.taskId).toBeNull() // cli access stays unbound
  })

  it('recordOutcomes appends one bound memory_outcome event per entry, idempotent under a key base', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const author = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't1', stepId: 's1', runToken: 'r1' } as const
    await store.recordOutcomes(
      [{ id: 'auth', outcome: MEMORY_USE.useful }, { id: 'net', outcome: MEMORY_USE.dead_end }],
      author, { idempotencyKeyBase: 'r1:knowledge' },
    )
    // an at-least-once retry of the capturing step must not double-count the evidence
    await store.recordOutcomes([{ id: 'auth', outcome: MEMORY_USE.useful }], author, { idempotencyKeyBase: 'r1:knowledge' })
    const events = await log.all()
    expect(events).toHaveLength(2)
    expect(events.map(e => e.kind)).toEqual(['memory_outcome', 'memory_outcome'])
    expect(events[0]!.taskId).toBe('t1') // bound to the acting step, recordAccess's rule
    const payload = MemoryOutcomePayload.parse(events[0]!.payload)
    expect(payload).toMatchObject({ id: 'auth', scope: 'project', outcome: MEMORY_USE.useful })
  })

  it('recordAccess with via appends a payload that parses MemoryAccessedPayload including via', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const via: AccessVia = { seed: 'net-topology', kind: 'supersedes', direction: 'out' }
    await store.recordAccess('auth', 'project', 'read', { source: 'cli', workspaceId: TEST_WORKSPACE_ID }, { via })
    const events = await log.all()
    const payload = MemoryAccessedPayload.parse(events[0]!.payload)
    expect(payload.via).toEqual(via)
  })

  it('replaying a write under one idempotency key leaves one memory_written event', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const author: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, runToken: 'step:t1:s1:a1' }
    const key = 'step:t1:s1:a1:tool:c1:memory:auth'
    await store.write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    await store.write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    expect(await log.all()).toHaveLength(1)
  })

  it('tolerates a keyed replay whose payload changed only by the gateway stamp (typed conflict, not a throw)', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const surreal = await SurrealMemory.open(ts)
    const author: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, runToken: 'step:t1:s1:a1' }
    const key = 'step:t1:s1:a1:tool:c1:memory:auth'
    // same tool call replayed after a restart: identical draft, but a new Git HEAD stamp → the
    // memory_written payload DIFFERS. The event log throws KernelError(idempotency_conflict); the
    // gateway must recognize it by CODE and swallow it (the first write stands), not fail the op.
    await createMemoryStore({ log, surreal, sourceRevision: async () => 'sha-A' }).write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    await createMemoryStore({ log, surreal, sourceRevision: async () => 'sha-B' }).write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    expect(await log.all()).toHaveLength(1) // one event; the differing replay was tolerated, not thrown
  })

  it('stamps the gateway sourceRevision — agent-supplied values are overwritten', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts), sourceRevision: async () => 'head-sha-42' })
    await store.write({ id: 'auth', title: 'Auth', sourceRevision: 'invented-by-agent' }, { source: 'agent', workspaceId: TEST_WORKSPACE_ID })
    const [event] = await log.all()
    const { note } = z.object({ note: z.object({ sourceRevision: z.string().nullable() }) }).parse(event!.payload)
    expect(note.sourceRevision).toBe('head-sha-42')
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
    const log = await openLog(pg)
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    const notePayload = z.object({ note: z.object({ title: z.string(), summary: z.string(), body: z.string(), tags: z.array(z.string()), links: z.array(z.object({ id: z.string(), kind: z.string() })) }) })
    await store.write({ id: 'auth', title: 'Auth', summary: 'tokens rotate', body: 'long body', tags: ['auth'], links: [{ id: 'other', kind: 'depends_on' }] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    let events = await log.all()
    await surreal.applyEvent(events[0]!) // materialize so the gateway sees the previous revision
    // omitting body/tags/links must NOT wipe them (the graph-refresh body-wipe defect)
    await store.write({ id: 'auth', title: 'Auth v2' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    events = await log.all()
    let { note } = notePayload.parse(events[1]!.payload)
    expect(note.title).toBe('Auth v2')            // supplied → replaced
    expect(note.body).toBe('long body')           // omitted → preserved
    expect(note.tags).toEqual(['auth'])
    expect(note.links).toEqual([{ id: 'other', kind: 'depends_on' }])
    // an EXPLICIT empty still clears; an undefined-valued key is an omission (CLI optional flags)
    await surreal.applyEvent(events[1]!)
    await store.write({ id: 'auth', title: 'Auth v2', body: '', summary: undefined }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    events = await log.all()
    note = notePayload.parse(events[2]!.payload).note
    expect(note.body).toBe('')
    expect(note.summary).toBe('tokens rotate')
  })

  it('merge base folds from the log, not the projection: a stalled projector cannot regress fields', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    const notePayload = z.object({ note: z.object({ title: z.string(), body: z.string(), tags: z.array(z.string()) }) })
    // write A (full), then partial B WITHOUT projecting A — the projector is "stalled". Under the old
    // projection-based merge, surreal.get returns null and B clears body/tags into the canonical log;
    // folding the merge base from the log preserves them.
    await store.write({ id: 'auth', title: 'Auth', body: 'long body', tags: ['auth'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.write({ id: 'auth', title: 'Auth v2' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    const events = await log.all()
    const { note } = notePayload.parse(events[1]!.payload)
    expect(note.title).toBe('Auth v2')       // supplied → replaced
    expect(note.body).toBe('long body')       // omitted → preserved despite the un-projected first write
    expect(note.tags).toEqual(['auth'])
  })

  it('rejects a malformed note without appending', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await expect(store.write({ id: 'Bad Id', title: 'x' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
  })

  // ARCHIVED counts as "already exists" because archiving only DELETES the read-model row
  // (surreal.get returns null) — a caller checking existence through store.get alone would see
  // nothing and silently resurrect the archived note (decisions.ts's recordDecision hit this
  // before mustCreate existed). A REMOVED note (memory_deleted) is gone and may come back.
  it('mustCreate refuses an id whose log carries a memory_written — archived counts, removed does not', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const author = { source: 'cli', workspaceId: TEST_WORKSPACE_ID } as const
    // a fresh id succeeds
    await store.write({ id: 'auth', title: 'Auth' }, author, { mustCreate: true })
    // the same id, still live, is refused
    await expect(store.write({ id: 'auth', title: 'Auth v2' }, author, { mustCreate: true }))
      .rejects.toThrow(STORE_REFUSAL.exists('auth', MemoryScope.project))
    // archived — still refused
    await store.setArchived('auth', 'project', true, author)
    await expect(store.write({ id: 'auth', title: 'Auth v3' }, author, { mustCreate: true }))
      .rejects.toThrow(STORE_REFUSAL.exists('auth', MemoryScope.project))
    // removed — the id is free again
    await store.remove('auth', 'project', author)
    await expect(store.write({ id: 'auth', title: 'Auth again' }, author, { mustCreate: true })).resolves.toBeDefined()
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
    const log = await openLog(pg)
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    await expect(store.write(
      { id: 'p1', title: 'A plan note', rationale: 'why this subplan exists', addClaims: ['a durable statement'] },
      { source: 'cli', workspaceId: TEST_WORKSPACE_ID },
    )).rejects.toThrow(/semantic-tier/)
    // and nothing was appended — the failure is total, not a half-written note
    expect(await store.get('p1')).toBeNull()
  })

  it('still accepts claims on a semantic note', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const surreal = await SurrealMemory.open(ts)
    const store = createMemoryStore({ log, surreal })
    await store.write({ id: 's1', title: 'A fact', addClaims: ['a durable statement'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
  })
})

describe('sourceRevision is resolved lazily', () => {
  it('is never asked for on a read path, and re-resolved on EVERY write', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
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
    await store.write({ id: 'n1', title: 'N1' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.write({ id: 'n2', title: 'N2' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    expect(calls).toBe(2)
  })
})

describe('additive claim writes', () => {
  const openStore = async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    return { log, store: createMemoryStore({ log, surreal: await SurrealMemory.open(ts) }) }
  }
  const lastWrite = async (log: EventLog) => MemoryWrittenPayload.parse((await log.all()).at(-1)?.payload)
  const claimsOf = (p: MemoryWrittenPayload) => p.note.tier === NOTE_TIER.semantic ? p.note.claims : []

  it('adds one claim without the writer resending the others', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.write({ id: 'n', title: 'N', addClaims: ['second'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })

    expect(claimsOf(await lastWrite(log)).map(c => c.text)).toEqual(['first', 'second'])
  })

  it('invalidating drops a claim and records the tombstone on the EVENT, not the note', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first', 'second'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.write({ id: 'n', title: 'N' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID }, { invalidates: [claimId('first')] })

    const last = await lastWrite(log)
    expect(claimsOf(last).map(c => c.text)).toEqual(['second'])
    expect(last.invalidates).toEqual([claimId('first')])
  })

  // The whole point of `invalidates` being STATED: the store merges on omit, so a write that simply
  // does not mention a claim must carry it forward. Absence can never mean deletion.
  it('a write that mentions no claims at all leaves the live set untouched', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.write({ id: 'n', title: 'N', summary: 'unrelated edit' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })

    const last = await lastWrite(log)
    expect(claimsOf(last).map(c => c.text)).toEqual(['first'])
    expect(last.invalidates).toEqual([])
  })

  it('addClaims is an instruction, never stored: the payload carries resolved claims only', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: ['first'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    expect(JSON.stringify((await lastWrite(log)).note)).not.toContain('addClaims')
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
    const log = await openLog(pg)
    const surreal = await SurrealMemory.open(ts, { embed: async texts => texts.map(vec) })
    const store = createMemoryStore({ log, surreal })
    await store.write({ id: 'n', title: 'N', addClaims: ['alpha holds', 'beta holds'] }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    for (const e of await log.all()) await surreal.applyEvent(e)
    await surreal.refreshTopics()
    return { log, store }
  }

  it('one fetch appends exactly one memory_topic_accessed, carrying the resolved label', async () => {
    const { log, store } = await openTopics()
    const [topic] = await store.topics()
    const claims = await store.topicClaims(topic!.topicKey, { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't1', stepId: 's1', runToken: 'r1' })
    expect(claims).toHaveLength(topic!.size)

    const tracked = await topicAccesses(log)
    expect(tracked).toHaveLength(1)
    // the label rides the EVENT because the read model is disposable — a rebuild would erase it
    expect(MemoryTopicAccessedPayload.parse(tracked[0]!.payload)).toMatchObject({ topicKey: topic!.topicKey, label: topic!.label })
    // and the envelope binds it to the acting step, the same rule recordAccess follows: task-scoped
    // views filter on the envelope, so an unbound append orphans the fetch from the run that made it
    expect(tracked[0]).toMatchObject({ taskId: 't1', stepId: 's1', runToken: 'r1' })
  })

  it('a keyed replay of one fetch appends one event, not two', async () => {
    const { log, store } = await openTopics()
    const [topic] = await store.topics()
    const author: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, runToken: 'r1' }
    const key = `r1:tool:c1:topic:${topic!.topicKey}`
    await store.topicClaims(topic!.topicKey, author, { idempotencyKey: key })
    await store.topicClaims(topic!.topicKey, author, { idempotencyKey: key })
    expect(await topicAccesses(log)).toHaveLength(1)
  })

  it('listing the inventory records nothing — only a fetch is a signal', async () => {
    const { log, store } = await openTopics()
    expect((await store.topics()).length).toBeGreaterThan(0)
    expect(await topicAccesses(log)).toEqual([])
  })

  it('an unknown key throws rather than returning empty, and records no signal for it', async () => {
    const { log, store } = await openTopics()
    await expect(store.topicClaims('deadbeef0000', { source: 'cli', workspaceId: TEST_WORKSPACE_ID })).rejects.toThrow(/list topics again/)
    expect(await topicAccesses(log)).toEqual([])
  })
})

// ─── store.verify: the single writer of the verification stamp ─────────────────────────────────
describe('MemoryStore.verify', () => {
  const HEAD = 'c0ffee1234567890'
  const open = async (sourceRevision: () => Promise<string | null> = async () => HEAD) => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    return { log, store: createMemoryStore({ log, surreal: await SurrealMemory.open(ts), sourceRevision }) }
  }

  it('appends exactly one memory_verified stamped with the SAME HEAD a write stamps sourceRevision from', async () => {
    const { log, store } = await open()
    await store.write({ id: 'auth', title: 'Auth' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    const stamp = await store.verify('auth', undefined, { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't1', stepId: 'verify', runToken: 'r1' })
    expect(stamp.revision).toBe(HEAD)
    expect(stamp.by).toBe('agent')
    const events = await log.all()
    // the act writes NO note: one write, one verification, and nothing else
    expect(events.map(e => e.kind)).toEqual([EVENT_KIND.memory_written, EVENT_KIND.memory_verified])
    const p = MemoryVerifiedPayload.parse(events[1]!.payload)
    expect(p).toMatchObject({ id: 'auth', scope: 'project', stamp })
    // envelope bound to the acting step, same rule recordAccess follows — an unbound append would
    // orphan the verification from the run that made it
    expect(events[1]!.taskId).toBe('t1')
    expect(events[1]!.runToken).toBe('r1')
  })

  it('refuses an id the LOG has no live note for, naming it', async () => {
    const { log, store } = await open()
    await expect(store.verify('never-written', undefined, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })).rejects.toThrow(/never-written/)
    expect(await log.all()).toEqual([])
    // a deleted note cannot be verified back into existence
    await store.write({ id: 'gone', title: 'Gone' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.remove('gone', undefined, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await expect(store.verify('gone', undefined, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })).rejects.toThrow(/gone/)
    expect((await log.all()).map(e => e.kind)).toEqual([EVENT_KIND.memory_written, EVENT_KIND.memory_deleted])
  })

  // A stamp whose revision nothing can be compared against reads as confirmation while proving
  // nothing — worse than no stamp at all, and unrecoverable once it is in an immutable log.
  it('refuses to stamp at all when the runtime has no readable HEAD', async () => {
    const { log, store } = await open(async () => null)
    await store.write({ id: 'auth', title: 'Auth' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await expect(store.verify('auth', undefined, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })).rejects.toThrow(/source revision/)
    expect((await log.all()).map(e => e.kind)).toEqual([EVENT_KIND.memory_written])
  })

  // A keyed replay is the SAME declaration arriving twice, so it must RESOLVE — the surrounding
  // operation is at-least-once, and a DBOS re-execution of a tool step whose append already
  // committed would otherwise hand the auditor a tool error for work that succeeded.
  // The payload conflicts by construction here, unlike write's: `stamp.at` is a fresh clock read per
  // attempt, so the log's identical-payload reuse path can never fire for a verification.
  it('is idempotent under a keyed crash-retry of the surrounding tool call', async () => {
    const { log, store } = await open()
    await store.write({ id: 'auth', title: 'Auth' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    const author: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, runToken: 'r1' }
    const first = await store.verify('auth', undefined, author, { idempotencyKey: 'r1:tool:c1:verify:auth' })
    const replay = await store.verify('auth', undefined, author, { idempotencyKey: 'r1:tool:c1:verify:auth' })
    expect(replay.revision).toBe(first.revision)
    expect((await log.all()).filter(e => e.kind === EVENT_KIND.memory_verified)).toHaveLength(1)
  })
})
