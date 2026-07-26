import { afterAll, describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { claimId, EVENT_KIND, MEMORY_ACCESS, TASK_STATUS, type EmbeddingProvider, type EventKind } from '@orc/contracts'
import { openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryProjector } from './projector'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })
const noteInput = { id: 'auth', scope: 'project', title: 'Auth', categories: [], tags: ['auth'], links: [], paths: [], rules: [], summary: 's', body: 'b' }

describe('memory projector', () => {
  it('applies written/deleted from the stream to SurrealDB + vault, and rebuilds from the log', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()

    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })
    await Bun.sleep(150)
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(true)
    expect((await surreal.get('auth', 'project'))?.title).toBe('Auth')

    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_deleted', payload: { id: 'auth', scope: 'project', author: { source: 'cli' } } })
    await Bun.sleep(150)
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(false)
    expect(await surreal.get('auth', 'project')).toBeNull()

    await proj.rebuild()   // replays memory_* from the log into a fresh store
    expect(await surreal.get('auth', 'project')).toBeNull() // deleted stayed deleted after replay
    await proj.close(); await surreal.close(); await log.close()
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

  it('never scans the whole log — catch-up uses the scoped kind query', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })

    const allSpy = spyOn(log, 'all')
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()
    await proj.catchUp()
    await proj.rebuild()
    await proj.close()
    expect(allSpy).not.toHaveBeenCalled()
    expect((await surreal.get('auth', 'project'))?.title).toBe('Auth')
    await surreal.close(); await log.close()
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

    await proj.close(); await surreal.close(); await log.close()
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
    await proj.start()
    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })
    await Bun.sleep(600) // subscription fires -> fail -> 250ms backoff -> retry succeeds
    await proj.close(); await log.close()
    warnSpy.mockRestore()
    expect(applyCalls).toBeGreaterThanOrEqual(2) // the retry actually re-applied
    expect(warns.filter(w => w.includes('memory projector'))).toEqual([]) // silently healed
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(true) // and the apply landed
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
    // start()'s initial drain hits the failing stub too — tolerate it; the subscription is live after
    await proj.start().catch(() => {})
    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } })
    await Bun.sleep(400)
    await proj.close(); await log.close()
    warnSpy.mockRestore()
    expect(warns.some(w => w.includes('memory projector: boom'))).toBe(true) // honest warning survives
  })
})
