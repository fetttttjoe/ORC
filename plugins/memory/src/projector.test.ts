import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { claimId, EVENT_KIND, MEMORY_ACCESS, noteKey, TASK_STATUS, type EmbeddingProvider, type EventKind } from '@orc/contracts'
import { openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { catchUpProgressLine, createMemoryProjector } from './projector'

const drops: (() => Promise<void>)[] = []
// Concurrent, with a real hook budget — see surreal.test.ts's teardown: serial drops blow bun's
// default 5s hook budget as the file grows, and the timeout leaves throwaway databases behind.
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)
const noteInput = { id: 'auth', scope: 'project', title: 'Auth', categories: [], tags: ['auth'], links: [], paths: [], summary: 's', body: 'b' }

// Wait for the SUBSCRIPTION to land rather than sleeping a guessed slice. A fixed `Bun.sleep(150)`
// encodes an assumption about machine speed: measured, it fails reproducibly on a loaded box (three
// runs out of three at load average 7) while passing on an idle one, which turns a green suite red
// for a reason unrelated to the code under test. Bounded, so a genuine break still fails, and fast,
// so the common case costs one poll.
const until = async (cond: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  for (;;) {
    if (await cond()) return
    if (Date.now() >= deadline) return // let the caller's own expect() report the failure
    await Bun.sleep(10)
  }
}

describe('memory projector', () => {
  it('applies written/deleted from the stream to SurrealDB + vault, and rebuilds from the log', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()
    // teardown in a finally, like the sibling tests below: a bare close after the assertions leaks
    // a live log subscription when one of them throws, and every later test file in the process then
    // fails on the dropped database (observed: one flaky assertion here cascaded into four files).
    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    try {
      const noteFile = path.join(vaultDir, 'memory', 'auth.md')
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })
      await until(() => existsSync(noteFile))
      expect(existsSync(noteFile)).toBe(true)
      expect((await surreal.get('auth', 'project'))?.title).toBe('Auth')

      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_deleted', payload: { id: 'auth', scope: 'project', author: { source: 'cli' } } })
      await until(() => !existsSync(noteFile))
      expect(existsSync(noteFile)).toBe(false)
      expect(await surreal.get('auth', 'project')).toBeNull()

      const result = await proj.rebuild()   // replays memory_* from the log into a fresh store
      expect(await surreal.get('auth', 'project')).toBeNull() // deleted stayed deleted after replay
      // clean rebuild: every live note the log's fold expects landed back in Surreal, so the
      // per-id accounting check reports success, not a silent drop.
      expect(result.degraded).toBe(false)
      expect(result.missing).toEqual([])
      expect(warns.some(w => w.includes('[memory] rebuild missing'))).toBe(false)
    } finally {
      warnSpy.mockRestore()
      await proj.close(); await surreal.close(); await log.close()
    }
  })

  // planGraphHash hashes authored content AND provenance (grounded-plan.ts), so a rebuild that
  // reproduces bodies but drifts on revision/createdAt/createdBy silently changes an approved
  // plan's identity. The existing rebuild assertions only cover "deleted stays deleted" and edge
  // reconstruction — neither would notice.
  it('rebuild reproduces revision and provenance exactly, not just content', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-rebuild-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()
    try {
      // two writes by DIFFERENT authors: revision advances, createdAt/By pin to the first
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written',
        payload: { note: noteInput, author: { source: 'cli' } } })
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written',
        payload: { note: { ...noteInput, summary: 'revised' }, author: { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' } } })
      await proj.catchUp()

      const before = await surreal.allNotes()
      expect(before[0]?.revision).toBe(2)
      expect(before[0]?.createdBy).toBe('cli')
      expect(before[0]?.updatedBy).toBe('api-loop·opus·review')

      await proj.rebuild()
      expect(await surreal.allNotes()).toEqual(before)
    } finally {
      await proj.close(); await surreal.close(); await log.close()
    }
  })

  // The whole point of event-sourcing the counter: written straight to Surreal, hits are erased
  // by any rebuild, which makes them noise that looks like data. Replayed from the log they are
  // data — and the hot/cold split they measure is what a future decay policy would key off.
  it('access counts survive a rebuild', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-hits-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()
    try {
      const append = (kind: EventKind, payload: Record<string, unknown>) =>
        log.append({ taskId: null, stepId: null, runToken: null, kind, payload })
      const access = { id: 'auth', scope: 'project', mode: MEMORY_ACCESS.read, author: { source: 'cli' } }
      await append(EVENT_KIND.memory_written, { note: noteInput, author: { source: 'cli' } })
      await append(EVENT_KIND.memory_accessed, access)
      await append(EVENT_KIND.memory_accessed, access)
      await proj.catchUp()

      const before = await surreal.list()
      expect(before[0]).toMatchObject({ id: 'auth', hits: 2 })
      expect(before[0]?.lastAccessedAt).toBeString()

      await proj.rebuild()
      expect(await surreal.list()).toEqual(before)
    } finally {
      await proj.close(); await surreal.close(); await log.close()
    }
  })

  // Stage 3's half of "the read model is disposable". cluster.test.ts proves the ALGORITHM is
  // order-independent; nothing proved the PIPELINE reproduces a partition end to end. A rebuild
  // clears the claim and topic tables and replays from seq 0, so every topicKey, label, size and
  // member has to come back identical — a topicKey is what an agent holds between two tool calls,
  // and a rebuild that renamed one would make every held key start erroring.
  it('a rebuild reproduces the same partition from the log', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    // 'zeta' means what 'alpha' means while sharing no token with it, so a merge is proven by
    // MEANING rather than by shared words (same fake encoder shape as topic-projection.test.ts)
    const vec = (text: string): number[] =>
      /alpha|zeta/.test(text) ? [1, 0, 0] : /beta/.test(text) ? [0, 1, 0] : [0, 0, 1]
    const fakeEmbedder: EmbeddingProvider = { embed: async texts => texts.map(vec) }
    const surreal = await SurrealMemory.open(ts, fakeEmbedder)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-partition-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    try {
      const withClaims = (id: string, texts: string[]) =>
        ({ ...noteInput, id, claims: texts.map(text => ({ id: claimId(text), text, sourceRevision: null })) })
      for (const [id, texts] of [['n1', ['alpha holds', 'beta holds']], ['n2', ['zeta holds']], ['n3', ['gamma holds']]] as const)
        await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
          payload: { note: withClaims(id, [...texts]), author: { source: 'cli' } } })
      await proj.catchUp()

      const before = await surreal.topics()
      expect(before).toHaveLength(3) // {alpha, zeta} merged; beta and gamma stand alone
      expect(before[0]?.size).toBe(2)
      const claimsBefore = await Promise.all(before.map(t => surreal.topicClaims(t.topicKey)))

      await proj.rebuild()
      expect(await surreal.topics()).toEqual(before)
      // and each key still resolves to the same statements, with the same validFrom stamps
      expect(await Promise.all(before.map(t => surreal.topicClaims(t.topicKey)))).toEqual(claimsBefore)
    } finally {
      await proj.close(); await surreal.close(); await log.close()
    }
  })

  it('never scans the whole log — catch-up uses the scoped kind query', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })

    const allSpy = spyOn(log, 'all')
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    try {
      await proj.start()
      await proj.catchUp()
      await proj.rebuild()
      await proj.close()
      expect(allSpy).not.toHaveBeenCalled()
      expect((await surreal.get('auth', 'project'))?.title).toBe('Auth')
    } finally {
      await proj.close(); await surreal.close(); await log.close()
    }
  })

  // Pins the two properties the topic-refresh gate exists for (see drainFrom's `force` in
  // projector.ts): start() must partition a corpus that already has claims even when the cursor is
  // already at head and zero events drain — the case a plain "did we drain anything" check cannot
  // tell apart from "nothing to do" — while a drain that carries no memory events, or only a
  // memory_accessed that cannot change which claims exist, must do no partition work at all.
  it('start() partitions an already-caught-up corpus; a memory-less or claim-less drain never repartitions', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const fakeEmbedder: EmbeddingProvider = { embed: async texts => texts.map(() => [1, 0, 0]) }
    const surreal = await SurrealMemory.open(ts, fakeEmbedder)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-topics-'))

    // Simulate a corpus that already holds claims but was never partitioned — pre-feature data, or
    // a run where refreshTopics kept failing: apply straight to Surreal, bypassing the projector
    // entirely, so Surreal's cursor lands at this event's seq WITHOUT refreshTopics ever running.
    const withClaims = { ...noteInput, id: 'topic-note', claims: [{ id: claimId('alpha holds'), text: 'alpha holds', sourceRevision: null }] }
    const rec = await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: withClaims, author: { source: 'cli' } } })
    await surreal.applyEvent(rec)
    expect(await surreal.topics()).toEqual([]) // sanity: claims exist, nothing partitioned yet

    const refreshSpy = spyOn(surreal, 'refreshTopics')
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    try {
      await proj.start() // cursor is already at rec.seq — drainFrom applies ZERO events this round
      expect(refreshSpy).toHaveBeenCalledTimes(1)
      expect(await surreal.topics()).not.toEqual([]) // yet start() still partitioned it (force: true)

      // A non-memory event must never even wake the reconcile pipeline (the subscribe filter in
      // start()) — spying on log.after from here on proves the pipeline was never ENTERED, not just
      // that it entered and found nothing: no claim-table read, no topic transaction, no drain query.
      const afterSpy = spyOn(log, 'after')
      await log.append({ taskId: 't1', stepId: null, runToken: null, kind: 'task_status_changed', payload: { taskId: 't1', from: TASK_STATUS.draft, to: TASK_STATUS.running } })
      await Bun.sleep(150)
      expect(afterSpy).not.toHaveBeenCalled()
      expect(refreshSpy).toHaveBeenCalledTimes(1)

      // memory_accessed IS a MEMORY_KINDS member, so it DOES wake the reconcile (the trigger filter
      // is by kind, not by "can this change claims") — but it cannot change which claims exist, so the
      // internal vaultChanged gate must still suppress the refresh.
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_accessed', payload: { id: 'topic-note', scope: 'project', mode: MEMORY_ACCESS.read, author: { source: 'cli' } } })
      await Bun.sleep(150)
      expect(afterSpy).toHaveBeenCalled()
      expect(refreshSpy).toHaveBeenCalledTimes(1)

      // catchUp(), the CLI's one-shot path, is gated the same way: nothing pending, no repartition.
      await proj.catchUp()
      expect(refreshSpy).toHaveBeenCalledTimes(1)
    } finally {
      await proj.close(); await surreal.close(); await log.close()
    }
  })
})

describe('projector resilience', () => {
  const fullNote = {
    ...noteInput, kind: 'fact', retention: 'durable', sourceRevision: null, sources: [],
    rationale: '', uncertainty: [], createdAt: 't', createdBy: 'cli', updatedAt: 't', updatedBy: 'cli', revision: 1,
  }
  it('absorbs one connection-shaped failure with a silent retry; warns only when failures persist', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-retry-'))
    let applyCalls = 0
    // ponytail: SurrealMemory is a class with a private constructor + private fields, so a
    // fault-injecting stub can't structurally satisfy it — this is the one shape that stays a
    // cast. Upgrade path: type createMemoryProjector's `surreal` param as a minimal
    // { applyEvent; get; getCursor; allNotes } interface (the surface it actually calls).
    const stub = {
      applyEvent: async () => {
        applyCalls += 1
        if (applyCalls === 1) throw new Error('Transaction not found') // transient, first apply only
        return true
      },
      get: async () => fullNote,
      getCursor: async () => 0,
      allNotes: async () => [fullNote],
    } as unknown as SurrealMemory
    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const proj = createMemoryProjector({ log, surreal: stub, vaultDir })
    try {
      await proj.start()
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })
      await Bun.sleep(600) // subscription fires -> fail -> 250ms backoff -> retry succeeds
    } finally {
      // restore in the finally too: a throw above would otherwise leave console.warn mocked for
      // every test that runs after this one, in this file and the next
      await proj.close(); await log.close()
      warnSpy.mockRestore()
    }
    expect(applyCalls).toBeGreaterThanOrEqual(2) // the retry actually re-applied
    expect(warns.filter(w => w.includes('memory projector'))).toEqual([]) // silently healed
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(true) // and the apply landed
  })
  // refreshTopics used to be a straight-line call AFTER the drain loop. applyOne can throw once an
  // event's Surreal side has already committed — the vault write happens outside that transaction —
  // and the retry then drains ZERO events, so `vaultChanged` is 0 and the gate suppresses the
  // refresh. The claims are in the read model and the topic table describes the corpus before them,
  // indefinitely: nothing repartitions until the next memory write or a restart.
  it('still repartitions when the drain throws after an event has committed', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-stale-topics-'))
    let applies = 0
    let refreshes = 0
    // ponytail: retained cast — see the SurrealMemory-is-a-class note above.
    const stub = {
      applyEvent: async () => { applies += 1; if (applies === 2) throw new Error('vault write failed'); return true },
      get: async () => fullNote,
      getCursor: async () => 0,
      allNotes: async () => [],
      refreshTopics: async () => { refreshes += 1 },
    } as unknown as SurrealMemory
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const proj = createMemoryProjector({ log, surreal: stub, vaultDir })
    try {
      for (const id of ['first', 'second'])
        await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: { ...noteInput, id }, author: { source: 'cli' } } })
      await proj.catchUp().catch(() => {}) // no start(): nothing forces a refresh, only the gate can
    } finally {
      await proj.close(); await log.close(); warnSpy.mockRestore()
    }
    expect(applies).toBe(2) // the second event is the one that threw
    expect(refreshes).toBe(1) // and the first event's claims still got partitioned
  })

  it('a WRITE repartitions topics but skips the O(n) link rebuild — only a DELETE re-links', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-link-gate-'))
    let links = 0
    let topics = 0
    // ponytail: retained cast — see the SurrealMemory-is-a-class note above.
    const stub = {
      applyEvent: async () => true,
      get: async () => fullNote,
      getCursor: async () => 0, // always re-drains from 0, so the 2nd catchUp re-applies write+delete
      allNotes: async () => [],
      refreshLinks: async () => { links += 1 },
      refreshTopics: async () => { topics += 1 },
    } as unknown as SurrealMemory
    const proj = createMemoryProjector({ log, surreal: stub, vaultDir })
    try {
      // a plain WRITE materializes its own edges per-note in applyEvent, so the global O(all-notes)
      // re-link is wasteful work it must skip. Topics still repartition (no per-event shortcut).
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: { ...noteInput }, author: { source: 'cli' } } })
      await proj.catchUp()
      expect(topics).toBe(1)
      expect(links).toBe(0)
      // a DELETE cascades away edges a NEIGHBOUR authored (Surreal drops a RELATE when either endpoint
      // is deleted), so only here does recomputing the whole edge set earn its cost.
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_deleted', payload: { id: noteInput.id, scope: 'project', author: { source: 'cli' } } })
      await proj.catchUp()
      expect(links).toBe(1)
    } finally {
      await proj.close(); await log.close()
    }
  })

  // A real replay can never itself drop a live note — applyOne either applies an event or skips it
  // deterministically from the payload — so exercising rebuild()'s per-id accounting branch needs a
  // fault-injecting stub whose applyEvent legitimately fails to persist ONE specific note id while
  // applying every other event normally, which is what a genuinely dropped write looks like.
  it('rebuild reports degraded and warns the specific id when one note is dropped during replay', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-rebuild-degraded-'))
    const droppedId = 'dropped-note'
    const persisted = new Map<string, typeof fullNote>()
    // ponytail: retained cast — see the SurrealMemory-is-a-class note above.
    const stub = {
      clear: async () => { persisted.clear() },
      applyEvent: async (e: { kind: string; payload: unknown }) => {
        if (e.kind !== 'memory_written') return true
        const note = (e.payload as { note: { id: string; scope: string } }).note
        if (note.id === droppedId) return false // simulate a write that never lands, for any reason
        persisted.set(noteKey(note.scope, note.id), { ...fullNote, id: note.id, scope: note.scope })
        return true
      },
      get: async () => fullNote,
      getCursor: async () => 0,
      allNotes: async () => [...persisted.values()],
      refreshLinks: async () => {},
      refreshTopics: async () => {},
    } as unknown as SurrealMemory
    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const proj = createMemoryProjector({ log, surreal: stub, vaultDir })
    try {
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: { ...noteInput, id: droppedId }, author: { source: 'cli' } } })
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: { ...noteInput, id: 'kept-note' }, author: { source: 'cli' } } })

      const result = await proj.rebuild()

      expect(result.degraded).toBe(true)
      // per-id, not just "something is missing": the dropped id itself is named
      expect(result.missing.some(k => k.includes(droppedId))).toBe(true)
      expect(warns.some(w => w.includes(droppedId))).toBe(true)
    } finally {
      await proj.close(); await log.close(); warnSpy.mockRestore()
    }
  })

  it('a persistent non-connection failure still warns once and does not reject unhandled', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vault-warn-'))
    // ponytail: retained cast — see the SurrealMemory-is-a-class note above.
    const stub = {
      applyEvent: async () => { throw new Error('boom') },
      get: async () => fullNote,
      getCursor: async () => { throw new Error('boom too') }, // catch-path cursor read also fails
      allNotes: async () => [],
    } as unknown as SurrealMemory
    const warns: string[] = []
    const warnSpy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.join(' ')) })
    const proj = createMemoryProjector({ log, surreal: stub, vaultDir })
    try {
      // start()'s initial drain hits the failing stub too — tolerate it; the subscription is live after
      await proj.start().catch(() => {})
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })
      await Bun.sleep(400)
    } finally {
      await proj.close(); await log.close()
      warnSpy.mockRestore()
    }
    expect(warns.some(w => w.includes('memory projector: boom'))).toBe(true) // honest warning survives
  })
})

describe('catchUpProgressLine (visibility for the big drain only)', () => {
  it('stays silent for a routine drain below the reporting floor', () => {
    expect(catchUpProgressLine(25, 49)).toBeNull()
  })

  it('reports at each interval of a large drain and stays quiet between', () => {
    expect(catchUpProgressLine(25, 200)).toBe('[memory] catch-up: 25/200 events projected')
    expect(catchUpProgressLine(26, 200)).toBeNull()
    expect(catchUpProgressLine(200, 200)).toBe('[memory] catch-up: 200/200 events projected')
  })
})
