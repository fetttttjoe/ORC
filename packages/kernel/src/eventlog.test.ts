import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import type { EventInput } from '@orc/contracts'
import { EventLog } from './eventlog'
import { events } from './schema'
import { createTestDb, TEST_PROJECT_ID } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
})

async function freshLog(): Promise<EventLog> {
  const db = await createTestDb()
  dbs.push(db)
  return EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
}

const statusEvent = (taskId = 't1'): EventInput => ({
  taskId, stepId: null, runToken: null,
  kind: 'task_status_changed',
  payload: { taskId, from: 'draft', to: 'awaiting_approval' },
})

describe('EventLog (postgres)', () => {
  it('appends with monotonic seq and ISO timestamp', async () => {
    const log = await freshLog()
    const a = await log.append(statusEvent())
    const b = await log.append(statusEvent())
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await log.close()
  })

  it('rejects payloads that do not match the kind schema', async () => {
    const log = await freshLog()
    await expect(log.append({ ...statusEvent(), payload: { wrong: true } })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })

  it('filters by task and orders by seq', async () => {
    const log = await freshLog()
    await log.append(statusEvent('t1'))
    await log.append(statusEvent('t2'))
    await log.append(statusEvent('t1'))
    expect((await log.byTask('t1')).map(e => e.seq)).toEqual([1, 3])
    expect((await log.byTaskSince('t1', 1)).map(e => e.seq)).toEqual([3])
    await log.close()
  })

  it('strips \\u0000 from payload strings (jsonb cannot store them)', async () => {
    const log = await freshLog()
    const rec = await log.append({
      taskId: 't1', stepId: 's1', runToken: 'r1',
      kind: 'tool_result',
      payload: {
        stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read',
        output: { content: 'binary\u0000data' }, isError: false,
      },
    })
    expect(JSON.stringify(rec.payload)).toContain('binarydata')
    expect(JSON.stringify(rec.payload)).not.toContain('\\u0000')
    const [stored] = await log.byTask('t1')
    expect(JSON.stringify(stored!.payload)).toContain('binarydata')
    await log.close()
  })

  it('transaction rolls back atomically on error', async () => {
    const log = await freshLog()
    await expect(
      log.transaction(async tx => {
        await tx.append(statusEvent())
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })

  it('transaction reads see writes made inside the same transaction', async () => {
    const log = await freshLog()
    const count = await log.transaction(async tx => {
      await tx.append(statusEvent())
      return (await tx.all()).length
    })
    expect(count).toBe(1)
    await log.close()
  })

  it('persists across reopen (migrations are idempotent)', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    await log.append(statusEvent())
    await log.close()
    const reopened = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    expect(await reopened.all()).toHaveLength(1)
    await reopened.close()
  })

  it('migration 0002 assigns pre-existing rows to the unreachable legacy project', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const migrations = fileURLToPath(new URL('../drizzle', import.meta.url))

    // stage a pre-0002 database: apply only migrations 0000 + 0001
    const stage = mkdtempSync(path.join(tmpdir(), 'orc-mig-'))
    mkdirSync(path.join(stage, 'meta'))
    const journal = JSON.parse(readFileSync(path.join(migrations, 'meta', '_journal.json'), 'utf8'))
    const staged = { ...journal, entries: journal.entries.slice(0, 2) }
    writeFileSync(path.join(stage, 'meta', '_journal.json'), JSON.stringify(staged))
    for (const entry of staged.entries)
      copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(stage, `${entry.tag}.sql`))

    const pool = new pg.Pool({ connectionString: db.url })
    const raw = drizzle(pool)
    await migrate(raw, { migrationsFolder: stage })
    // one row written against the old schema — no project_id column exists yet
    const legacyEvents = pgTable('events', {
      taskId: text('task_id'),
      kind: text('kind').notNull(),
      payload: jsonb('payload').notNull(),
    })
    await raw.insert(legacyEvents).values({
      taskId: 't-legacy', kind: 'task_status_changed',
      payload: { taskId: 't-legacy', from: 'draft', to: 'awaiting_approval' },
    })

    // reopening through EventLog applies 0002 on top of the populated database
    const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    expect(await log.all()).toHaveLength(0) // legacy rows are unreachable from any project
    const [row] = await raw.select().from(events)
    expect(row!.projectId).toBe('legacy')
    await pool.end()
    await log.close()
  })

  it('isolates projects sharing one database: each log reads only its own events', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const other = '00000000-0000-4000-8000-000000000002'
    const p1 = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    const p2 = await EventLog.open(db.url, { projectId: other })
    await p1.append(statusEvent('t1'))
    await p2.append(statusEvent('t1'))
    expect((await p1.all()).map(e => e.projectId)).toEqual([TEST_PROJECT_ID])
    expect((await p2.all()).map(e => e.projectId)).toEqual([other])
    expect(await p1.byTask('t1')).toHaveLength(1)
    await p1.close()
    await p2.close()
  })

  it('after() filters by sequence and kinds in the query, not in JavaScript', async () => {
    const log = await freshLog()
    await log.append(statusEvent('t1'))
    await log.append({
      taskId: 't2', stepId: null, runToken: null, kind: 'task_created',
      payload: { task: { id: 't2', parentId: null, type: 'generic', title: 't2', spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 0, createdAt: 'T' } },
    })
    await log.append(statusEvent('t3'))
    expect((await log.after(0, ['task_created'])).map(e => e.seq)).toEqual([2])
    expect((await log.after(1)).map(e => e.seq)).toEqual([2, 3])
    expect((await log.after(0, ['task_created', 'task_status_changed'])).map(e => e.seq)).toEqual([1, 2, 3])
    await log.close()
  })

  it('idempotency: same key + same input returns the original seq and stores one row', async () => {
    const log = await freshLog()
    const first = await log.append({ ...statusEvent(), idempotencyKey: 'r1:status:0' })
    const replay = await log.append({ ...statusEvent(), idempotencyKey: 'r1:status:0' })
    expect(replay.seq).toBe(first.seq)
    expect(await log.all()).toHaveLength(1)
    await log.close()
  })

  it('idempotency: same key + different payload rejects instead of silently overwriting', async () => {
    const log = await freshLog()
    await log.append({ ...statusEvent(), idempotencyKey: 'r1:status:0' })
    await expect(
      log.append({
        ...statusEvent(), idempotencyKey: 'r1:status:0',
        payload: { taskId: 't1', from: 'approved', to: 'running' },
      }),
    ).rejects.toThrow(/idempotency key/)
    expect(await log.all()).toHaveLength(1)
    await log.close()
  })

  it('concurrent transactions serialize per project; unrelated projects stay concurrent', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    const other = await EventLog.open(db.url, { projectId: '00000000-0000-4000-8000-000000000002' })

    let releaseA = () => {}
    const gate = new Promise<void>(r => { releaseA = r })
    let aHoldsLock = () => {}
    const aStarted = new Promise<void>(r => { aHoldsLock = r })

    const order: string[] = []
    const txA = log.transaction(async tx => {
      await tx.append(statusEvent('a'))
      aHoldsLock()
      await gate
      order.push('A commits')
    })
    await aStarted

    // same project: B must wait for A's lock
    let bDone = false
    const txB = log.transaction(async tx => {
      await tx.append(statusEvent('b'))
      bDone = true
    })
    // unrelated project: appends immediately despite A holding the p1 lock
    await other.append(statusEvent('x'))

    await new Promise(r => setTimeout(r, 150))
    expect(bDone).toBe(false)
    order.push('B still waiting')
    releaseA()
    await txA
    await txB
    expect(bDone).toBe(true)
    expect(order).toEqual(['B still waiting', 'A commits'])
    await log.close()
    await other.close()
  })

  it('redacts sensitive keys and configured env secrets before storage', async () => {
    const db = await createTestDb()
    dbs.push(db)
    process.env.ORC_TEST_FAKE_SECRET = 'embedded-secret-value-42'
    process.env.ORC_TEST_CUSTOM_CREDS = 'custom-credential-value-9'
    try {
      const log = await EventLog.open(db.url, {
        projectId: TEST_PROJECT_ID,
        redactEnv: ['ORC_TEST_CUSTOM_CREDS'],
      })
      await log.append({
        taskId: 't1', stepId: 's1', runToken: 'r1', kind: 'tool_result',
        payload: {
          stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'http',
          isError: false,
          output: {
            config: { apiKey: 'raw-api-key-material' },
            headers: { Authorization: 'Bearer embedded-secret-value-42' },
            text: 'curl -H "X: embedded-secret-value-42" used custom-credential-value-9 here',
          },
        },
      })
      const stored = JSON.stringify(await log.all())
      expect(stored).not.toContain('raw-api-key-material')
      expect(stored).not.toContain('embedded-secret-value-42')
      expect(stored).not.toContain('custom-credential-value-9')
      expect(stored).toContain('[REDACTED]')
      expect(stored).toContain('[REDACTED:ORC_TEST_FAKE_SECRET]')
      expect(stored).toContain('[REDACTED:ORC_TEST_CUSTOM_CREDS]')
      await log.close()
    } finally {
      delete process.env.ORC_TEST_FAKE_SECRET
      delete process.env.ORC_TEST_CUSTOM_CREDS
    }
  })

  it('onAppend observer fires for pool and transaction appends; its errors never break the append', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const log = await freshLog()
      const seen: string[] = []
      log.onAppend = e => {
        seen.push(`${e.seq}:${e.kind}`)
        throw new Error('observer boom') // must be swallowed
      }
      const a = await log.append(statusEvent())
      await log.transaction(async tx => { await tx.append(statusEvent()) })
      expect(seen.length).toBe(2)
      expect(seen[0]).toBe(`${a.seq}:task_status_changed`)
      await log.close()
    } finally {
      mock.restore()
    }
  })
})
