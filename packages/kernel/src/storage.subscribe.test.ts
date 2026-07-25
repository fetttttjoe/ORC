import { afterEach, describe, expect, it } from 'bun:test'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { TaskNode } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import { createTestDb, TEST_PROJECT_ID } from './test-helpers'
import { openStorage, type EventLog } from './storage'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop() })

const task = (id: string): TaskNode => ({
  id, parentId: null, type: 'generic', title: id, spec: '', status: 'draft',
  zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-17T00:00:00.000Z',
})
const appendCreated = (log: EventLog, id: string) =>
  log.append({ taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task(id) } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('EventLog.subscribe', () => {
  it('catches up from fromSeq then pushes new appends in order', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')

    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    await sleep(50)
    expect(seen).toEqual([1, 2])              // catch-up

    await appendCreated(log, 'c')
    await sleep(100)
    expect(seen).toEqual([1, 2, 3])           // pushed, no poll

    await unsub()
    await log.close()
  })

  it('retries a failed handler from the same cursor — the event is not lost', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const attempts: number[] = []
    let failedOnce = false
    const unsub = await log.subscribe({ fromSeq: 0 }, e => {
      attempts.push(e.seq)
      if (e.seq === 1 && !failedOnce) {
        failedOnce = true
        throw new Error('handler boom')
      }
    })
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')
    const deadline = Date.now() + 5000
    while (attempts.length < 3 && Date.now() < deadline) await sleep(50)
    expect(attempts).toEqual([1, 1, 2]) // seq 1 retried before seq 2 — cursor never skipped it
    await unsub()
    await log.close()
  })

  it('reconnects after the LISTEN backend dies and catches up without a gap', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
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
    await unsub()
    await log.close()
  }, 15_000)

  it('delivers nothing for a rolled-back transaction (commit-only)', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    await sleep(30)
    await log.transaction(async tx => { await tx.append({ taskId: 'x', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task('x') } }); throw new Error('rollback') }).catch(() => {})
    await sleep(100)
    expect(seen).toEqual([])
    await unsub()
    await log.close()
  })

  // A cursor outlives the log it came from: `docker compose down -v`, a restore, a repointed
  // database. Every catch-up query is `seq > cursor`, so the new log's rows all sort BELOW it and
  // the stream goes silent forever with no error and no dropped connection to notice — a live
  // graph UI served a two-runs-old snapshot until someone restarted the process.
  it('rewinds and announces a reset when the log no longer reaches its cursor', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')
    const seen: number[] = []
    let resets = 0
    const unsub = await log.subscribe({ fromSeq: 0, onReset: () => { resets += 1 } }, e => { seen.push(e.seq) })
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
    await unsub()
    await log.close()
  }, 20_000)
})
