import { afterEach, describe, expect, it } from 'bun:test'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { Origin, TaskNode } from '@orc/contracts'
import { Door, EVENT_KIND, NO_CHAT } from '@orc/contracts'
import { createTestDb, TEST_PROJECT_ID } from './test-helpers'
import { openStorage, type EventLog } from './storage'
import { taskFixture } from '@orc/contracts/fixtures'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop() })

const task = (id: string): TaskNode => taskFixture({ id, title: id, createdAt: '2026-07-17T00:00:00.000Z' })
// These appends exercise the notification pump, not a conversation, so they name the cli door and
// no chat — spelled at each call site rather than defaulted in by the helper.
const CLI: Origin = NO_CHAT(Door.cli)
const appendCreated = (log: EventLog, id: string) =>
  log.append({ ...CLI, taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task(id) } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('EventLog.subscribe', () => {
  // A dropped database is permanent: the reconnect loop cannot retry it into working, and left
  // running it spins at the 3s backoff ceiling forever. Measured on CI — one file dropped its
  // database and the orphaned loop logged into every LATER test file's output, burying real
  // failures in noise.
  it('stops reconnecting once the database is gone for good', async () => {
    const db = await createTestDb()
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    await appendCreated(log, 'a')
    const seen: number[] = []
    // the handler for seq 2 stalls so the pump is mid-flight when the database vanishes: the next
    // notification sets wakeAgain, the loop's next SELECT then fails, and the 250 ms pump retry is
    // armed — the second loop that must stop with the reconnect loop, not spin for the process's life
    const unsub = await log.subscribe({ fromSeq: 0 }, async e => { seen.push(e.seq); if (e.seq === 2) await sleep(400) })
    await sleep(50)
    expect(seen.length).toBe(1)

    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...a: unknown[]) => { warnings.push(a.join(' ')) }
    try {
      await appendCreated(log, 'b')
      await sleep(50)
      await appendCreated(log, 'c')
      await db.drop() // pulls the database out from under a LIVE subscription
      await sleep(1200) // past several reconnect delays (100/200/400/800) and pump retries (250)
    } finally {
      console.warn = realWarn
    }
    // it gives up ONCE, rather than logging a fresh failure on every backoff tick
    expect(warnings.filter(w => w.includes('event stream stopped')).length).toBe(1)
    expect(warnings.filter(w => w.includes('reconnect failed')).length).toBe(0)
    // the pump retry quiesces with it: one failure plus at most the retry already armed, never one
    // every 250 ms for the rest of the process
    expect(warnings.filter(w => w.includes('pump failed')).length).toBeLessThanOrEqual(2)
    await unsub()
    await log.close().catch(() => {})
  }, 15000)

  // A throw during the INITIAL catch-up rejects subscribe(), so the caller never receives a
  // disposer — and `closed` lives only inside that disposer. Meanwhile ending the client fires the
  // 'end' handler, which schedules a reconnect. Nothing could ever stop it: the subscription
  // reconnected and re-pumped forever, invisibly, against a caller that believed it had failed.
  it('a handler throwing during initial catch-up leaves nothing running', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    await appendCreated(log, 'a')

    let calls = 0
    await expect(log.subscribe({ fromSeq: 0 }, () => { calls += 1; throw new Error('handler boom') }))
      .rejects.toThrow('handler boom')
    const afterFailure = calls

    // longer than PUMP_RETRY_MS (250) and the first reconnect delays (100/200/400): a still-armed
    // loop would have re-delivered by now
    await appendCreated(log, 'b')
    await sleep(900)
    expect(calls).toBe(afterFailure)
  })

  it('catches up from fromSeq then pushes new appends in order', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')

    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    db.onClose(unsub)
    await sleep(50)
    expect(seen).toEqual([1, 2])              // catch-up

    await appendCreated(log, 'c')
    await sleep(100)
    expect(seen).toEqual([1, 2, 3])           // pushed, no poll

  })

  it('retries a failed handler from the same cursor — the event is not lost', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    const attempts: number[] = []
    let failedOnce = false
    const unsub = await log.subscribe({ fromSeq: 0 }, e => {
      attempts.push(e.seq)
      if (e.seq === 1 && !failedOnce) {
        failedOnce = true
        throw new Error('handler boom')
      }
    })
    db.onClose(unsub)
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')
    const deadline = Date.now() + 5000
    while (attempts.length < 3 && Date.now() < deadline) await sleep(50)
    expect(attempts).toEqual([1, 1, 2]) // seq 1 retried before seq 2 — cursor never skipped it
  })

  it('reconnects after the LISTEN backend dies and catches up without a gap', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    db.onClose(unsub)
    await appendCreated(log, 'a')
    let deadline = Date.now() + 5000
    while (!seen.includes(1) && Date.now() < deadline) await sleep(50)

    // kill the dedicated listener connection by its application_name
    const admin = new pg.Pool({ connectionString: db.url })
    await drizzle(admin).execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${`orc-events-${TEST_PROJECT_ID}`}`,
    )
    await admin.end()

    await appendCreated(log, 'b')
    deadline = Date.now() + 10_000
    while (!seen.includes(2) && Date.now() < deadline) await sleep(50)
    expect(seen).toContain(1)
    expect(seen).toContain(2)
    expect([...seen]).toEqual([...seen].sort((a, b) => a - b)) // in increasing order
  }, 15_000)

  it('delivers nothing for a rolled-back transaction (commit-only)', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    db.onClose(unsub)
    await sleep(30)
    await log.transaction(async tx => { await tx.append({ ...CLI, taskId: 'x', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task('x') } }); throw new Error('rollback') }).catch(() => {})
    await sleep(100)
    expect(seen).toEqual([])
  })

  // A cursor outlives the log it came from: `docker compose down -v`, a restore, a repointed
  // database. Every catch-up query is `seq > cursor`, so the new log's rows all sort BELOW it and
  // the stream goes silent forever with no error and no dropped connection to notice — a live
  // graph UI served a two-runs-old snapshot until someone restarted the process.
  it('rewinds and announces a reset when the log no longer reaches its cursor', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')
    const seen: number[] = []
    let resets = 0
    const unsub = await log.subscribe({ fromSeq: 0, onReset: () => { resets += 1 } }, e => { seen.push(e.seq) })
    db.onClose(unsub)
    let deadline = Date.now() + 5000
    while (seen.length < 2 && Date.now() < deadline) await sleep(50)
    expect(seen).toEqual([1, 2]) // cursor now sits at 2

    // the log is destroyed and re-created underneath the live subscriber
    const admin = new pg.Pool({ connectionString: db.url })
    await drizzle(admin).execute(sql`truncate table events restart identity`)
    await drizzle(admin).execute(
      sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${`orc-events-${TEST_PROJECT_ID}`}`,
    )
    await admin.end()

    await appendCreated(log, 'c') // seq 1 again — BELOW the stale cursor
    deadline = Date.now() + 10_000
    while (!(resets > 0 && seen.length > 2) && Date.now() < deadline) await sleep(50)
    expect(resets).toBe(1)         // the fold-holder is told to throw its cache away
    expect(seen).toEqual([1, 2, 1]) // and the new log's first event is delivered, not skipped
  }, 20_000)
})
