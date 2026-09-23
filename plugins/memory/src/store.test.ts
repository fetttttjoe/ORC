import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { AUTHOR_SOURCE, basisAnchors, type BlobAt, ClaimClass, ClaimDraft, ClaimDriftState, claimDriftState, claimId, Door, EDGE_DIRECTION, EVENT_KIND, MEMORY_ACCESS, MEMORY_LIMITS, MEMORY_USE, MemoryAccessedPayload, MemoryAuthor, MemoryOutcomePayload, MemoryScope, MemoryTopicAccessedPayload, MemoryVerifiedPayload, MemoryWrittenPayload, NOTE_KIND, NOTE_TIER, type AccessVia, type Origin, type TreeStamps, LINK_KIND } from '@orc/contracts'
import { gitRevision, openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID, type TestDb } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryStore, STORE_REFUSAL } from './store'
import { authorFixture, must } from '@orc/contracts/fixtures'

const drops: (() => Promise<void>)[] = []

// The one non-default origin this file writes from: an agent step's writes belong to the chat its
// run opened. A CLI write is authorFixture()'s default origin.
const RUN: Origin = { chatId: 'run:t1:v1', door: Door.supervisor }
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

// A checkout as a test double: a test names the revision it expects and the blob of every path it
// anchors, so both stamps are observable without a real repo (tree-stamps.test.ts owns that).
const stampsOf = (revision: string | null, blobs: Record<string, string> = {}): TreeStamps => ({
  revision: async () => revision,
  blob: async file => blobs[file] ?? null,
})
const draft = (text: string, ...paths: string[]): ClaimDraft =>
  ClaimDraft.parse({ text, class: ClaimClass.fact, anchors: paths.map(path => ({ path })) })

const lastWrite = async (log: EventLog): Promise<MemoryWrittenPayload> => MemoryWrittenPayload.parse((await log.all()).at(-1)?.payload)
const claimsOf = (p: MemoryWrittenPayload) => p.note.tier === NOTE_TIER.semantic ? p.note.claims : []

describe('MemoryStore gateway', () => {
  it('write appends a memory_written event with stamped provenance and null taskId', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.write({ id: 'auth', title: 'Auth' }, authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, executor: 'api-loop', model: 'opus', role: 'review' }))
    const events = await log.all()
    expect(events).toHaveLength(1)
    expect(must(events[0], 'events[0]').kind).toBe(EVENT_KIND.memory_written)
    expect(must(events[0], 'events[0]').taskId).toBeNull()
    const { author } = z.object({ author: MemoryAuthor }).parse(must(events[0], 'events[0]').payload)
    expect(author.executor).toBe('api-loop')
  })

  it('write carries the author origin onto the event envelope, chatId and door unchanged', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.write({ id: 'auth', title: 'Auth' }, authorFixture({ source: AUTHOR_SOURCE.mcp, origin: { chatId: 'c1', door: Door.mcp } }))
    const event = must((await log.all())[0], 'events[0]')
    // a note written through the MCP door in chat c1 must stay attributable to it: an envelope that
    // drops either half cannot answer who asked for the write.
    expect({ chatId: event.chatId, door: event.door }).toEqual({ chatId: 'c1', door: Door.mcp })
  })

  it('recordAccess binds the event envelope to the author task identity', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.recordAccess('auth', 'project', MEMORY_ACCESS.read, authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, taskId: 't1', stepId: 's1', runToken: 'r1' }))
    await store.recordAccess('auth', 'project', MEMORY_ACCESS.read, authorFixture())
    const events = await log.all()
    expect(must(events[0], 'events[0]').taskId).toBe('t1')
    expect(must(events[0], 'events[0]').stepId).toBe('s1')
    expect(must(events[0], 'events[0]').runToken).toBe('r1')
    expect(must(events[1], 'events[1]').taskId).toBeNull() // cli access stays unbound
  })

  it('recordOutcomes appends one bound memory_outcome event per entry, idempotent under a key base', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const author = authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, taskId: 't1', stepId: 's1', runToken: 'r1' })
    await store.recordOutcomes(
      [{ id: 'auth', outcome: MEMORY_USE.useful }, { id: 'net', outcome: MEMORY_USE.dead_end }],
      author, { idempotencyKeyBase: 'r1:knowledge' },
    )
    // an at-least-once retry of the capturing step must not double-count the evidence
    await store.recordOutcomes([{ id: 'auth', outcome: MEMORY_USE.useful }], author, { idempotencyKeyBase: 'r1:knowledge' })
    const events = await log.all()
    expect(events).toHaveLength(2)
    expect(events.map(e => e.kind)).toEqual([EVENT_KIND.memory_outcome, EVENT_KIND.memory_outcome])
    expect(must(events[0], 'events[0]').taskId).toBe('t1') // bound to the acting step, recordAccess's rule
    const payload = MemoryOutcomePayload.parse(must(events[0], 'events[0]').payload)
    expect(payload).toMatchObject({ id: 'auth', scope: 'project', outcome: MEMORY_USE.useful })
  })

  it('recordAccess with via appends a payload that parses MemoryAccessedPayload including via', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const via: AccessVia = { seed: 'net-topology', kind: LINK_KIND.supersedes, direction: EDGE_DIRECTION.out }
    await store.recordAccess('auth', 'project', MEMORY_ACCESS.read, authorFixture(), { via })
    const events = await log.all()
    const payload = MemoryAccessedPayload.parse(must(events[0], 'events[0]').payload)
    expect(payload.via).toEqual(via)
  })

  it('replaying a write under one idempotency key leaves one memory_written event', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    const author: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, runToken: 'step:t1:s1:a1' })
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
    const author: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, runToken: 'step:t1:s1:a1' })
    const key = 'step:t1:s1:a1:tool:c1:memory:auth'
    // same tool call replayed after a restart: identical draft, but a new Git HEAD stamp → the
    // memory_written payload DIFFERS. The event log throws KernelError(idempotency_conflict); the
    // gateway must recognize it by CODE and swallow it (the first write stands), not fail the op.
    await createMemoryStore({ log, surreal, stampsFor: () => stampsOf('sha-A') }).write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    await createMemoryStore({ log, surreal, stampsFor: () => stampsOf('sha-B') }).write({ id: 'auth', title: 'Auth' }, author, { idempotencyKey: key })
    expect(await log.all()).toHaveLength(1) // one event; the differing replay was tolerated, not thrown
  })

  it('stamps the gateway sourceRevision — agent-supplied values are overwritten', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts), stampsFor: () => stampsOf('head-sha-42') })
    await store.write({ id: 'auth', title: 'Auth', sourceRevision: 'invented-by-agent' }, authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN }))
    const [event] = await log.all()
    const { note } = z.object({ note: z.object({ sourceRevision: z.string().nullable() }) }).parse(must(event, 'event').payload)
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
    await store.write({ id: 'auth', title: 'Auth', summary: 'tokens rotate', body: 'long body', tags: ['auth'], links: [{ id: 'other', kind: LINK_KIND.depends_on }] }, authorFixture())
    let events = await log.all()
    await surreal.applyEvent(must(events[0], 'events[0]')) // materialize so the gateway sees the previous revision
    // omitting body/tags/links must NOT wipe them (the graph-refresh body-wipe defect)
    await store.write({ id: 'auth', title: 'Auth v2' }, authorFixture())
    events = await log.all()
    let { note } = notePayload.parse(must(events[1], 'events[1]').payload)
    expect(note.title).toBe('Auth v2')            // supplied → replaced
    expect(note.body).toBe('long body')           // omitted → preserved
    expect(note.tags).toEqual(['auth'])
    expect(note.links).toEqual([{ id: 'other', kind: LINK_KIND.depends_on }])
    // an EXPLICIT empty still clears; an undefined-valued key is an omission (CLI optional flags)
    await surreal.applyEvent(must(events[1], 'events[1]'))
    await store.write({ id: 'auth', title: 'Auth v2', body: '', summary: undefined }, authorFixture())
    events = await log.all()
    note = notePayload.parse(must(events[2], 'events[2]').payload).note
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
    await store.write({ id: 'auth', title: 'Auth', body: 'long body', tags: ['auth'] }, authorFixture())
    await store.write({ id: 'auth', title: 'Auth v2' }, authorFixture())
    const events = await log.all()
    const { note } = notePayload.parse(must(events[1], 'events[1]').payload)
    expect(note.title).toBe('Auth v2')       // supplied → replaced
    expect(note.body).toBe('long body')       // omitted → preserved despite the un-projected first write
    expect(note.tags).toEqual(['auth'])
  })

  it('rejects a malformed note without appending', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await expect(store.write({ id: 'Bad Id', title: 'x' }, authorFixture())).rejects.toThrow()
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
    const author = authorFixture()
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
      { id: 'p1', title: 'A plan note', rationale: 'why this subplan exists', addClaims: [draft('a durable statement')] },
      authorFixture(),
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
    await store.write({ id: 's1', title: 'A fact', addClaims: [draft('a durable statement')] }, authorFixture())
  })
})

describe('sourceRevision is resolved lazily', () => {
  it('is never asked for on a read path, and re-resolved on EVERY write', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const surreal = await SurrealMemory.open(ts)
    let calls = 0
    const store = createMemoryStore({ log, surreal, stampsFor: () => ({ revision: async () => { calls++; return 'abc123' }, blob: async () => null }) })

    await store.get('nothing')
    await store.list()
    await store.search('x')
    expect(calls).toBe(0)

    // ONE PER WRITE, not one per store: a store-level memo stamped every note with the commit the
    // supervisor booted at — in the immutable log, where no rebuild heals it — and the drift check
    // then reported moved code as current. Only writes resolve it, so the saving was never real.
    await store.write({ id: 'n1', title: 'N1' }, authorFixture())
    await store.write({ id: 'n2', title: 'N2' }, authorFixture())
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

  it('adds one claim without the writer resending the others', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first')] }, authorFixture())
    await store.write({ id: 'n', title: 'N', addClaims: [draft('second')] }, authorFixture())

    expect(claimsOf(await lastWrite(log)).map(c => c.text)).toEqual(['first', 'second'])
  })

  it('invalidating drops a claim and records the tombstone on the EVENT, not the note', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first'), draft('second')] }, authorFixture())
    await store.write({ id: 'n', title: 'N' }, authorFixture(), { invalidates: [claimId('first')] })

    const last = await lastWrite(log)
    expect(claimsOf(last).map(c => c.text)).toEqual(['second'])
    expect(last.invalidates).toEqual([claimId('first')])
  })

  // The whole point of `invalidates` being STATED: the store merges on omit, so a write that simply
  // does not mention a claim must carry it forward. Absence can never mean deletion.
  it('a write that mentions no claims at all leaves the live set untouched', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first')] }, authorFixture())
    await store.write({ id: 'n', title: 'N', summary: 'unrelated edit' }, authorFixture())

    const last = await lastWrite(log)
    expect(claimsOf(last).map(c => c.text)).toEqual(['first'])
    expect(last.invalidates).toEqual([])
  })

  it('addClaims is an instruction, never stored: the payload carries resolved claims only', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first')] }, authorFixture())
    expect(JSON.stringify((await lastWrite(log)).note)).not.toContain('addClaims')
  })

  // A reader asking "why is this true, and what decided it" reads the WRITE, so both ride the
  // event — and a `decision` that names no live decision note would send that reader nowhere.
  it('records the why and the decision of a write that changes no claims at all', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'follow-the-barrel', title: 'Follow the barrel', kind: NOTE_KIND.decision }, authorFixture())
    await store.write({ id: 'n', title: 'N' }, authorFixture(), { why: 'the walker now follows the barrel', decision: 'follow-the-barrel' })

    const last = await lastWrite(log)
    expect(last.why).toBe('the walker now follows the barrel')
    expect(last.decision).toBe('follow-the-barrel')
  })

  it('leaves why and decision null when the write states neither', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first')] }, authorFixture())
    expect(await lastWrite(log)).toMatchObject({ why: null, decision: null })
  })

  // Checked against the LOG inside the write's own transaction: the read model is asynchronous, so
  // a decision recorded a moment ago must not be refused by a projection that has not drained.
  it('accepts a decision written in the same turn, with nothing projected', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'fresh-decision', title: 'Fresh', kind: NOTE_KIND.decision }, authorFixture())
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first')] }, authorFixture(), { decision: 'fresh-decision' })
    expect((await lastWrite(log)).decision).toBe('fresh-decision')
  })

  it('refuses a decision that is not a decision note, is absent, or was deleted', async () => {
    const { store } = await openStore()
    const author = authorFixture()
    await store.write({ id: 'plain', title: 'Plain' }, author)
    await store.write({ id: 'gone', title: 'Gone', kind: NOTE_KIND.decision }, author)
    await store.remove('gone', MemoryScope.project, author)

    await expect(store.write({ id: 'n', title: 'N' }, author, { decision: 'plain' }))
      .rejects.toThrow(STORE_REFUSAL.notADecision('plain', MemoryScope.project))
    await expect(store.write({ id: 'n', title: 'N' }, author, { decision: 'never-recorded' }))
      .rejects.toThrow(STORE_REFUSAL.notADecision('never-recorded', MemoryScope.project))
    await expect(store.write({ id: 'n', title: 'N' }, author, { decision: 'gone' }))
      .rejects.toThrow(STORE_REFUSAL.notADecision('gone', MemoryScope.project))
  })

  // Claim identity is (scope, noteId, claimId): two notes can hold the same sentence, and retiring
  // one must leave the other's stretch open.
  it('retiring a claim on one note leaves the identical claim on another untouched', async () => {
    const { log, store } = await openStore()
    await store.write({ id: 'a', title: 'A', addClaims: [draft('shared sentence')] }, authorFixture())
    await store.write({ id: 'b', title: 'B', addClaims: [draft('shared sentence')] }, authorFixture())
    await store.write({ id: 'a', title: 'A' }, authorFixture(), { invalidates: [claimId('shared sentence')] })

    const events = (await log.all()).filter(e => e.kind === EVENT_KIND.memory_written).map(e => MemoryWrittenPayload.parse(e.payload))
    const forNote = (id: string) => events.filter(p => p.note.id === id)
    expect(claimsOf(must(forNote('a').at(-1), 'a write for note a'))).toEqual([])
    expect(claimsOf(must(forNote('b').at(-1), 'a write for note b')).map(c => c.text)).toEqual(['shared sentence'])
  })
})

// Both stamps name the AUTHOR's checkout, never the supervisor's: a note written from a worktree
// but stamped with main's HEAD reads clean until its branch merges, and drifted afterwards.
describe('claim stamps are read from the author checkout', () => {
  const KERNEL = 'packages/kernel/src/kernel.ts'
  const openStamped = async (stampsFor: (author: MemoryAuthor) => TreeStamps) => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    return { log, store: createMemoryStore({ log, surreal: await SurrealMemory.open(ts), stampsFor }) }
  }
  const stampsIn = (p: MemoryWrittenPayload) =>
    claimsOf(p).map(c => ({ sourceRevision: c.sourceRevision, blobs: c.anchors.map(a => a.blob) }))

  it('stores every anchor blob and the claim revision the provider answers', async () => {
    const { log, store } = await openStamped(() => stampsOf('rev1', { [KERNEL]: 'aaa' }))
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first', KERNEL)] }, authorFixture())
    expect(claimsOf(await lastWrite(log))).toEqual([{
      id: claimId('first'), text: 'first', class: ClaimClass.fact, sourceRevision: 'rev1',
      anchors: [{ path: KERNEL, symbol: null, blob: 'aaa' }],
    }])
  })

  it('stores blob null for an anchor the checkout cannot hash', async () => {
    const { log, store } = await openStamped(() => stampsOf('rev1'))
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first', 'src/gone.ts')] }, authorFixture())
    expect(stampsIn(await lastWrite(log))).toEqual([{ sourceRevision: 'rev1', blobs: [null] }])
  })

  it('resolves the provider from the AUTHOR: two workspaces stamp differently through one store', async () => {
    const { log, store } = await openStamped(author =>
      author.workspaceId === 'ws-a' ? stampsOf('rev-a', { [KERNEL]: 'aaa' }) : stampsOf('rev-b', { [KERNEL]: 'bbb' }))
    await store.write({ id: 'a', title: 'A', addClaims: [draft('from a', KERNEL)] }, authorFixture({ workspaceId: 'ws-a' }))
    await store.write({ id: 'b', title: 'B', addClaims: [draft('from b', KERNEL)] }, authorFixture({ workspaceId: 'ws-b' }))
    const stamped = (await log.all()).map(e => stampsIn(MemoryWrittenPayload.parse(e.payload)))
    expect(stamped).toEqual([
      [{ sourceRevision: 'rev-a', blobs: ['aaa'] }],
      [{ sourceRevision: 'rev-b', blobs: ['bbb'] }],
    ])
  })

  it('takes both stamps before the log transaction — git never spawns under the write lock', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    const order: string[] = []
    const traced: EventLog = new Proxy(log, {
      get: (target, prop) => prop === 'transaction'
        ? (fn: Parameters<EventLog['transaction']>[0]) => { order.push('transaction'); return target.transaction(fn) }
        : Reflect.get(target, prop, target),
    })
    const store = createMemoryStore({
      log: traced, surreal: await SurrealMemory.open(ts),
      stampsFor: () => ({
        revision: async () => { order.push('revision'); return 'rev1' },
        blob: async () => { order.push('blob'); return 'aaa' },
      }),
    })
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first', KERNEL)] }, authorFixture())
    expect(order).toEqual(['revision', 'blob', 'transaction'])
  })

  it('re-adding identical text keeps the original class, anchors, blob and revision', async () => {
    const { log, store } = await openStamped(author =>
      author.workspaceId === 'ws-a' ? stampsOf('rev-a', { [KERNEL]: 'aaa' }) : stampsOf('rev-b', { [KERNEL]: 'bbb' }))
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first', KERNEL)] }, authorFixture({ workspaceId: 'ws-a' }))
    await store.write(
      { id: 'n', title: 'N', addClaims: [ClaimDraft.parse({ text: 'first', class: ClaimClass.why, anchors: [] })] },
      authorFixture({ workspaceId: 'ws-b' }),
    )
    expect(claimsOf(await lastWrite(log))).toEqual([{
      id: claimId('first'), text: 'first', class: ClaimClass.fact, sourceRevision: 'rev-a',
      anchors: [{ path: KERNEL, symbol: null, blob: 'aaa' }],
    }])
  })

  it('invalidating an id beats adding the same text in one write', async () => {
    const { log, store } = await openStamped(() => stampsOf('rev1', { [KERNEL]: 'aaa' }))
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first', KERNEL)] }, authorFixture(), { invalidates: [claimId('first')] })
    expect(claimsOf(await lastWrite(log))).toEqual([])
  })

  it('refuses a write that would take the note past the claim limit', async () => {
    const { log, store } = await openStamped(() => stampsOf('rev1'))
    const full = Array.from({ length: MEMORY_LIMITS.detailItems }, (_, i) => draft(`statement ${i}`))
    await store.write({ id: 'n', title: 'N', addClaims: full }, authorFixture())
    await expect(store.write({ id: 'n', title: 'N', addClaims: [draft('one statement too many')] }, authorFixture()))
      .rejects.toThrow(/too many claims/)
    expect(await log.all()).toHaveLength(1)
  })

  it('a metadata-only write, an archive and a restore all carry the stamps forward', async () => {
    const { log, store } = await openStamped(() => stampsOf('rev1', { [KERNEL]: 'aaa' }))
    const author = authorFixture()
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first', KERNEL)] }, author)
    await store.write({ id: 'n', title: 'N', summary: 'unrelated edit' }, author)
    await store.setArchived('n', 'project', true, author)
    await store.setArchived('n', 'project', false, author)
    const stamped = (await log.all()).map(e => stampsIn(MemoryWrittenPayload.parse(e.payload)))
    expect(stamped).toEqual(Array.from({ length: 4 }, () => [{ sourceRevision: 'rev1', blobs: ['aaa'] }]))
  })

  it('a verification snapshots the blobs it checked, and that snapshot becomes the comparison basis', async () => {
    const blobs: Record<string, string> = { [KERNEL]: 'A' }
    const { log, store } = await openStamped(() => stampsOf('rev1', blobs))
    const author = authorFixture()
    await store.write({ id: 'n', title: 'N', addClaims: [draft('first', KERNEL)] }, author)
    const writtenClaims = async () => claimsOf(MemoryWrittenPayload.parse(
      must((await log.all()).filter(e => e.kind === EVENT_KIND.memory_written).at(-1), 'the last write').payload,
    ))
    const claim = must((await writtenClaims())[0], 'the written claim')

    blobs[KERNEL] = 'B'
    const atB: BlobAt = () => 'B'
    expect(claimDriftState(claim, atB)).toBe(ClaimDriftState.suspect)

    const stamp = await store.verify('n', MemoryScope.project, author)
    expect(stamp.claims).toEqual([{ claimId: claimId('first'), anchors: [{ path: KERNEL, symbol: null, blob: 'B' }] }])
    // the verification is an event APPEND: the claim's own stamp still says A
    expect((await writtenClaims())[0]?.anchors).toEqual([{ path: KERNEL, symbol: null, blob: 'A' }])

    const replayed = MemoryVerifiedPayload.parse(
      must((await log.all()).filter(e => e.kind === EVENT_KIND.memory_verified).at(-1), 'the verification').payload,
    )
    const basis = basisAnchors(claim, replayed.stamp.claims ?? [])
    expect(claimDriftState(basis, atB)).toBe(ClaimDriftState.clean)
    expect(claimDriftState(basis, () => 'C')).toBe(ClaimDriftState.suspect)
    expect(claimDriftState(basis, () => undefined)).toBe(ClaimDriftState.unknown)
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
    await store.write({ id: 'n', title: 'N', addClaims: [draft('alpha holds'), draft('beta holds')] }, authorFixture())
    for (const e of await log.all()) await surreal.applyEvent(e)
    await surreal.refreshTopics()
    return { log, store }
  }

  it('one fetch appends exactly one memory_topic_accessed, carrying the resolved label', async () => {
    const { log, store } = await openTopics()
    const [topic] = await store.topics()
    const claims = await store.topicClaims(must(topic, 'topic').topicKey, authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, taskId: 't1', stepId: 's1', runToken: 'r1' }))
    expect(claims).toHaveLength(must(topic, 'topic').size)

    const tracked = await topicAccesses(log)
    expect(tracked).toHaveLength(1)
    // the label rides the EVENT because the read model is disposable — a rebuild would erase it
    expect(MemoryTopicAccessedPayload.parse(must(tracked[0], 'tracked[0]').payload)).toMatchObject({ topicKey: must(topic, 'topic').topicKey, label: must(topic, 'topic').label })
    // and the envelope binds it to the acting step, the same rule recordAccess follows: task-scoped
    // views filter on the envelope, so an unbound append orphans the fetch from the run that made it
    expect(tracked[0]).toMatchObject({ taskId: 't1', stepId: 's1', runToken: 'r1' })
  })

  it('a keyed replay of one fetch appends one event, not two', async () => {
    const { log, store } = await openTopics()
    const [topic] = await store.topics()
    const author: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, runToken: 'r1' })
    const key = `r1:tool:c1:topic:${must(topic, 'topic').topicKey}`
    await store.topicClaims(must(topic, 'topic').topicKey, author, { idempotencyKey: key })
    await store.topicClaims(must(topic, 'topic').topicKey, author, { idempotencyKey: key })
    expect(await topicAccesses(log)).toHaveLength(1)
  })

  it('listing the inventory records nothing — only a fetch is a signal', async () => {
    const { log, store } = await openTopics()
    expect((await store.topics()).length).toBeGreaterThan(0)
    expect(await topicAccesses(log)).toEqual([])
  })

  it('an unknown key throws rather than returning empty, and records no signal for it', async () => {
    const { log, store } = await openTopics()
    await expect(store.topicClaims('deadbeef0000', authorFixture())).rejects.toThrow(/list topics again/)
    expect(await topicAccesses(log)).toEqual([])
  })
})

// ─── store.verify: the single writer of the verification stamp ─────────────────────────────────
describe('MemoryStore.verify', () => {
  const HEAD = 'c0ffee1234567890'
  const open = async (revision: string | null = HEAD) => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await openLog(pg)
    return { log, store: createMemoryStore({ log, surreal: await SurrealMemory.open(ts), stampsFor: () => stampsOf(revision) }) }
  }

  it('appends exactly one memory_verified stamped with the SAME HEAD a write stamps sourceRevision from', async () => {
    const { log, store } = await open()
    await store.write({ id: 'auth', title: 'Auth' }, authorFixture())
    const stamp = await store.verify('auth', undefined, authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, taskId: 't1', stepId: 'verify', runToken: 'r1' }))
    expect(stamp.revision).toBe(HEAD)
    expect(stamp.by).toBe('agent')
    const events = await log.all()
    // the act writes NO note: one write, one verification, and nothing else
    expect(events.map(e => e.kind)).toEqual([EVENT_KIND.memory_written, EVENT_KIND.memory_verified])
    const p = MemoryVerifiedPayload.parse(must(events[1], 'events[1]').payload)
    expect(p).toMatchObject({ id: 'auth', scope: 'project', stamp })
    // envelope bound to the acting step, same rule recordAccess follows — an unbound append would
    // orphan the verification from the run that made it
    expect(must(events[1], 'events[1]').taskId).toBe('t1')
    expect(must(events[1], 'events[1]').runToken).toBe('r1')
  })

  it('refuses an id the LOG has no live note for, naming it', async () => {
    const { log, store } = await open()
    await expect(store.verify('never-written', undefined, authorFixture())).rejects.toThrow(/never-written/)
    expect(await log.all()).toEqual([])
    // a deleted note cannot be verified back into existence
    await store.write({ id: 'gone', title: 'Gone' }, authorFixture())
    await store.remove('gone', undefined, authorFixture())
    await expect(store.verify('gone', undefined, authorFixture())).rejects.toThrow(/gone/)
    expect((await log.all()).map(e => e.kind)).toEqual([EVENT_KIND.memory_written, EVENT_KIND.memory_deleted])
  })

  // A stamp whose revision nothing can be compared against reads as confirmation while proving
  // nothing — worse than no stamp at all, and unrecoverable once it is in an immutable log.
  it('refuses to stamp at all when the runtime has no readable HEAD', async () => {
    const { log, store } = await open(null)
    await store.write({ id: 'auth', title: 'Auth' }, authorFixture())
    await expect(store.verify('auth', undefined, authorFixture())).rejects.toThrow(/source revision/)
    expect((await log.all()).map(e => e.kind)).toEqual([EVENT_KIND.memory_written])
  })

  // A keyed replay is the SAME declaration arriving twice, so it must RESOLVE — the surrounding
  // operation is at-least-once, and a DBOS re-execution of a tool step whose append already
  // committed would otherwise hand the auditor a tool error for work that succeeded.
  // The payload conflicts by construction here, unlike write's: `stamp.at` is a fresh clock read per
  // attempt, so the log's identical-payload reuse path can never fire for a verification.
  it('is idempotent under a keyed crash-retry of the surrounding tool call', async () => {
    const { log, store } = await open()
    await store.write({ id: 'auth', title: 'Auth' }, authorFixture())
    const author: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, runToken: 'r1' })
    const first = await store.verify('auth', undefined, author, { idempotencyKey: 'r1:tool:c1:verify:auth' })
    const replay = await store.verify('auth', undefined, author, { idempotencyKey: 'r1:tool:c1:verify:auth' })
    expect(replay.revision).toBe(first.revision)
    expect((await log.all()).filter(e => e.kind === EVENT_KIND.memory_verified)).toHaveLength(1)
  })
})
