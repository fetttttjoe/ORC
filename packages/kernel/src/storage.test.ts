import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { Door, EVENT_KIND, isRecord, isTerminalError, NO_CHAT, type EventInput, type OperationSpec } from '@orc/contracts'
import { authorFixture, eventFixture, must } from '@orc/contracts/fixtures'
import { KernelError, KERNEL_ERROR_CODE } from './errors'
import { listProjectIds, openStorage, type EventLog, type Storage } from './storage'
import { isMissingMigrationTable, migrateDatabase } from './storage/migrate'
import { events } from './schema'
import { createTestDb, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from './test-helpers'

// one spelling of a chatless CLI envelope — every append names both keys, so a per-literal copy
// would be a dozen places to edit the next time provenance gains one
const ORIGIN = NO_CHAT(Door.cli)
// the project the backfilling migration parks pre-existing rows in — no log ever opens it
const LEGACY_PROJECT_ID = 'legacy'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

async function freshStorage(): Promise<Storage> {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  // registered, not left to the test body: a bare close after assertions dies with the first
  // failing expect and leaks the pool into every later file
  db.onClose(() => storage.close())
  return storage
}
async function freshLog(): Promise<EventLog> {
  return (await freshStorage()).events
}

describe('listProjectIds', () => {
  it('lists every project with events, most recently active first', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const s1 = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => s1.close())
    const other = '99999999-9999-9999-9999-999999999999'
    const s2 = await openStorage(db.url, { projectId: other })
    db.onClose(() => s2.close())
    const draft = { ...ORIGIN, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'p', title: 'p' }, author: authorFixture() } } as const
    await s1.events.append(draft)
    await s2.events.append(draft)
    expect(await listProjectIds(db.url)).toEqual([other, TEST_PROJECT_ID]) // s2 wrote last
  })
})

function errorCodes(error: unknown): string[] {
  if (!isRecord(error)) return []
  return [
    ...(typeof error.code === 'string' ? [error.code] : []),
    ...errorCodes(error.cause),
    ...(Array.isArray(error.errors) ? error.errors : []).flatMap(errorCodes),
  ]
}

describe('schema migration', () => {
  it('preserves connection failures instead of reporting an unmigrated schema', async () => {
    const error = await openStorage('postgresql://postgres:orc@127.0.0.1:59999/orc', {
      projectId: TEST_PROJECT_ID,
    }).catch(value => value)

    expect(errorCodes(error)).toContain('ECONNREFUSED')
  })

  it('reports an empty schema as zero applied migrations, naming the checked database without credentials', async () => {
    const db = await createTestDb({ migrate: false })
    dbs.push(db)

    const err = await openStorage(db.url, { projectId: TEST_PROJECT_ID }).then(() => null, (e: unknown) => e)
    if (!(err instanceof Error)) throw new Error('expected openStorage to reject on a behind schema')
    expect(err.message).toMatch(/database schema is behind \(0\/\d+ migrations applied\)/)
    // the "(checked host/db)" suffix says WHICH database (a wrong cwd hits a different one) —
    // but only host+path, never credentials, so a regression that interpolates the raw url is caught
    expect(err.message).toContain('(checked ')
    expect(err.message).toContain(new URL(db.url).host) // host:port is shown
    expect(err.message).not.toContain('@')              // no user/password ever reaches the message
  })

  // error-wrapping libraries can hand back a chain that loops on itself; an unguarded cause walk
  // recurses to stack overflow instead of classifying the error
  it('classifies a self-referential cause chain without recursing forever', () => {
    const looped: { code: string; cause?: unknown } = { code: 'XX000' }
    looped.cause = looped
    expect(isMissingMigrationTable(looped)).toBe(false)
    // the chain walk itself must keep working — a wrapped missing-table code is still found
    expect(isMissingMigrationTable({ cause: { code: '42P01' } })).toBe(true)
  }, 1000)
})

const statusEvent = (taskId = 't1'): EventInput => ({
  ...ORIGIN, taskId, stepId: null, runToken: null,
  kind: EVENT_KIND.task_status_changed,
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
  })

  it('rejects payloads that do not match the kind schema', async () => {
    const log = await freshLog()
    await expect(log.append({ ...statusEvent(), payload: { wrong: true } })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
  })

  it('filters by task and orders by seq', async () => {
    const log = await freshLog()
    await log.append(statusEvent('t1'))
    await log.append(statusEvent('t2'))
    await log.append(statusEvent('t1'))
    expect((await log.byTask('t1')).map(e => e.seq)).toEqual([1, 3])
    expect((await log.byTaskSince('t1', 1)).map(e => e.seq)).toEqual([3])
  })

  it('strips \\u0000 from payload strings (jsonb cannot store them)', async () => {
    const log = await freshLog()
    const rec = await log.append({
      ...ORIGIN, taskId: 't1', stepId: 's1', runToken: 'r1',
      kind: EVENT_KIND.tool_result,
      payload: {
        stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read',
        output: { content: 'binary\u0000data' }, isError: false,
      },
    })
    expect(JSON.stringify(rec.payload)).toContain('binarydata')
    expect(JSON.stringify(rec.payload)).not.toContain('\\u0000')
    const stored = must((await log.byTask('t1'))[0], 'first event for task t1')
    expect(JSON.stringify(stored.payload)).toContain('binarydata')
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
  })

  it('transaction reads see writes made inside the same transaction', async () => {
    const log = await freshLog()
    const count = await log.transaction(async tx => {
      await tx.append(statusEvent())
      return (await tx.all()).length
    })
    expect(count).toBe(1)
  })

  it('persists across reopen (migrations are idempotent)', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    await log.append(statusEvent())
    await log.close() // deliberate mid-test close — the reopen IS the test
    const reopened = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => reopened.close())
    expect(await reopened.all()).toHaveLength(1)
  })

  it('migration 0002 assigns pre-existing rows to the unreachable legacy project', async () => {
    const db = await createTestDb({ migrate: false })
    dbs.push(db)
    const migrations = fileURLToPath(new URL('../drizzle', import.meta.url))

    // a database frozen after the first `count` migrations, so a row can be written against the
    // shape that existed then
    const stageThrough = (count: number): string => {
      const stage = mkdtempSync(path.join(tmpdir(), 'orc-mig-'))
      mkdirSync(path.join(stage, 'meta'))
      const journal = JSON.parse(readFileSync(path.join(migrations, 'meta', '_journal.json'), 'utf8'))
      const staged = { ...journal, entries: journal.entries.slice(0, count) }
      writeFileSync(path.join(stage, 'meta', '_journal.json'), JSON.stringify(staged))
      for (const entry of staged.entries)
        copyFileSync(path.join(migrations, `${entry.tag}.sql`), path.join(stage, `${entry.tag}.sql`))
      return stage
    }

    const pool = new pg.Pool({ connectionString: db.url })
    db.onClose(() => pool.end())
    const raw = drizzle(pool)
    await migrate(raw, { migrationsFolder: stageThrough(2) })
    // one row written against the old schema — no project_id column exists yet
    const legacyEvents = pgTable('events', {
      taskId: text('task_id'),
      kind: text('kind').notNull(),
      payload: jsonb('payload').notNull(),
    })
    await raw.insert(legacyEvents).values({
      taskId: 't-legacy', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't-legacy', from: 'draft', to: 'awaiting_approval' },
    })

    // the backfilling migration assigns the pre-existing row to the legacy project
    await migrate(raw, { migrationsFolder: stageThrough(3) })
    const backfilledEvents = pgTable('events', { projectId: text('project_id').notNull() })
    const row = must((await raw.select().from(backfilledEvents))[0], 'first row from events table')
    expect(row.projectId).toBe(LEGACY_PROJECT_ID)

    // the door column is NOT NULL with no default — it can only be added to an empty table, so the
    // legacy row is re-created once the chain is complete
    await raw.delete(legacyEvents)
    await migrateDatabase(db.url)
    await raw.insert(events).values({
      ...ORIGIN, projectId: LEGACY_PROJECT_ID, taskId: 't-legacy',
      kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't-legacy', from: 'draft', to: 'awaiting_approval' },
    })
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    expect(await log.all()).toHaveLength(0) // legacy rows are unreachable from any project
  })

  it('isolates projects sharing one database: each log reads only its own events', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const other = '00000000-0000-4000-8000-000000000002'
    const p1 = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => p1.close())
    const p2 = (await openStorage(db.url, { projectId: other })).events
    db.onClose(() => p2.close())
    await p1.append(statusEvent('t1'))
    await p2.append(statusEvent('t1'))
    expect((await p1.all()).map(e => e.projectId)).toEqual([TEST_PROJECT_ID])
    expect((await p2.all()).map(e => e.projectId)).toEqual([other])
    expect(await p1.byTask('t1')).toHaveLength(1)
  })

  it('after() filters by sequence and kinds in the query, not in JavaScript', async () => {
    const log = await freshLog()
    await log.append(statusEvent('t1'))
    await log.append({
      ...ORIGIN, taskId: 't2', stepId: null, runToken: null, kind: EVENT_KIND.task_created,
      payload: { task: { id: 't2', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title: 't2', spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 0, createdAt: 'T' } },
    })
    await log.append(statusEvent('t3'))
    expect((await log.after(0, ['task_created'])).map(e => e.seq)).toEqual([2])
    expect((await log.after(1)).map(e => e.seq)).toEqual([2, 3])
    expect((await log.after(0, ['task_created', 'task_status_changed'])).map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('idempotency: same key + same input returns the original seq and stores one row', async () => {
    const log = await freshLog()
    const first = await log.append({ ...statusEvent(), idempotencyKey: 'r1:status:0' })
    const replay = await log.append({ ...statusEvent(), idempotencyKey: 'r1:status:0' })
    expect(replay.seq).toBe(first.seq)
    expect(await log.all()).toHaveLength(1)
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
  })

  it('round-trips the envelope: a chat id, its absence, and the door the call entered by', async () => {
    const log = await freshLog()
    const inChat = await log.append({ ...statusEvent(), chatId: 'c1', door: Door.web })
    expect(inChat).toEqual(eventFixture({
      seq: inChat.seq, projectId: TEST_PROJECT_ID, chatId: 'c1', door: Door.web,
      kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't1', from: 'draft', to: 'awaiting_approval' },
      ts: inChat.ts,
    }))
    await log.append(statusEvent())
    // read back from the rows: a column the insert never filled still round-trips through the
    // record the append returned
    expect((await log.byTask('t1')).map(e => [e.chatId, e.door])).toEqual([['c1', Door.web], [null, Door.cli]])
  })

  it('idempotency: same key + a different chatId rejects instead of sharing the key', async () => {
    const log = await freshLog()
    const keyed = { ...statusEvent(), idempotencyKey: 'r1:status:0' }
    await log.append(keyed)
    const err = await log.append({ ...keyed, chatId: 'c1' }).catch((e: unknown) => e)
    expect(err instanceof KernelError ? err.code : err).toBe(KERNEL_ERROR_CODE.idempotency_conflict)
    expect(await log.all()).toHaveLength(1)
  })

  it('idempotency: same key + a different door rejects instead of sharing the key', async () => {
    const log = await freshLog()
    const keyed = { ...statusEvent(), idempotencyKey: 'r1:status:0' }
    await log.append(keyed)
    const err = await log.append({ ...keyed, door: Door.mcp }).catch((e: unknown) => e)
    expect(err instanceof KernelError ? err.code : err).toBe(KERNEL_ERROR_CODE.idempotency_conflict)
    expect(await log.all()).toHaveLength(1)
  })

  it('concurrent transactions serialize per project; unrelated projects stay concurrent', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    db.onClose(() => log.close())
    const other = (await openStorage(db.url, { projectId: '00000000-0000-4000-8000-000000000002' })).events
    db.onClose(() => other.close())

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
  })

  it('redacts sensitive keys and configured env secrets before storage', async () => {
    const db = await createTestDb()
    dbs.push(db)
    process.env.ORC_TEST_FAKE_SECRET = 'embedded-secret-value-42'
    process.env.ORC_TEST_CUSTOM_CREDS = 'custom-credential-value-9'
    try {
      const log = (await openStorage(db.url, {
        projectId: TEST_PROJECT_ID,
        redactEnv: ['ORC_TEST_CUSTOM_CREDS'],
      })).events
      db.onClose(() => log.close())
      await log.append({
        ...ORIGIN, taskId: 't1', stepId: 's1', runToken: 'r1', kind: EVENT_KIND.tool_result,
        payload: {
          stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'http',
          isError: false,
          output: {
            config: {
              apiKey: 'raw-api-key-material',
              client_secret: 'raw-client-secret',
              private_key: 'raw-private-key',
              x_api_key: 'raw-prefixed-api-key',
              servicePassword: 'raw-service-password',
              credentials: 'raw-credentials',
              // minted-during-a-run secrets: never in process.env, so key matching is the ONLY
              // thing that catches them
              authToken: 'raw-auth-token', bearer_token: 'raw-bearer-token',
              sessionToken: 'raw-session-token', apiToken: 'raw-api-token',
              publicKey: 'safe-public-key',
            },
            headers: { Authorization: 'Bearer embedded-secret-value-42' },
            text: 'curl -H "X: embedded-secret-value-42" used custom-credential-value-9 here',
          },
        },
      })
      const stored = JSON.stringify(await log.all())
      for (const secret of [
        'raw-api-key-material', 'raw-client-secret', 'raw-private-key', 'raw-prefixed-api-key',
        'raw-service-password', 'raw-credentials', 'embedded-secret-value-42', 'custom-credential-value-9',
        'raw-auth-token', 'raw-bearer-token', 'raw-session-token', 'raw-api-token',
      ]) expect(stored).not.toContain(secret)
      expect(stored).toContain('safe-public-key')
      // the trap: runToken normalizes to 'runtoken'. Redacting it would fail PAYLOAD_SCHEMAS
      // validation, which runs after redaction — so it must survive intact.
      expect(stored).toContain('"runToken":"r1"')
      expect(stored).toContain('[REDACTED]')
      expect(stored).toContain('[REDACTED:ORC_TEST_FAKE_SECRET]')
      expect(stored).toContain('[REDACTED:ORC_TEST_CUSTOM_CREDS]')
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
    } finally {
      mock.restore()
    }
  })
})

const OP_CONTEXT = { taskId: 't1', stepId: 's1', runToken: 'step:t1:s1:a1', origin: ORIGIN }
const OP_SPEC: OperationSpec = { operationId: 'step:t1:s1:a1:model:1', kind: 'model', name: 'fake/m', before: { messages: ['hi'] } }

describe('OperationJournal', () => {
  it('beginOperation commits a started node and its transition before external code runs', async () => {
    const { events: log, operations: journal } = await freshStorage()
    const begin = await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    expect(begin).toEqual({ reused: false, attempt: 1 })
    const op = must((await journal.operationsFor('t1'))[0], 'first operation for task t1')
    expect(op.status).toBe('started')
    expect(op.attempts).toBe(1)
    expect(op.name).toBe('fake/m')
    const kinds = (await log.byTask('t1')).map(e => e.kind)
    expect(kinds).toEqual(['operation_started'])
  })

  it('completeOperation stores after and appends completion plus drafts atomically', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'answer' }, [
      { kind: EVENT_KIND.agent_call, payload: { stepId: 's1', runToken: OP_CONTEXT.runToken, iteration: 1, request: {}, response: { text: 'answer' } } },
    ])
    const op = must((await journal.operationsFor('t1'))[0], 'first operation for task t1')
    expect(op.status).toBe('completed')
    expect(op.after).toEqual({ text: 'answer' })
    expect(op.finishedSeq).not.toBeNull()
    const kinds = (await log.byTask('t1')).map(e => e.kind)
    expect(kinds).toEqual(['operation_started', 'operation_completed', 'agent_call'])
  })

  it('beginOperation after completion reuses the stored value without another attempt', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'answer' })
    const again = await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    expect(again).toEqual({ reused: true, attempt: 1, value: { text: 'answer' } })
    expect((await log.byTask('t1')).filter(e => e.kind === 'operation_started')).toHaveLength(1)
  })

  it('beginOperation on a still-started node records the ambiguous retry as attempt 2', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    const second = await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    expect(second).toEqual({ reused: false, attempt: 2 })
    const op = must((await journal.operationsFor('t1'))[0], 'first operation for task t1')
    expect(op.attempts).toBe(2)
    expect(op.status).toBe('started')
    expect((await log.byTask('t1')).filter(e => e.kind === 'operation_started')).toHaveLength(2)
  })

  it('a failed completion draft rolls back the whole completion', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await expect(
      journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'x' }, [
        { kind: EVENT_KIND.agent_call, payload: { wrong: true } }, // fails payload validation
      ]),
    ).rejects.toThrow()
    const op = must((await journal.operationsFor('t1'))[0], 'first operation for task t1')
    expect(op.status).toBe('started') // update rolled back with the event
    expect((await log.byTask('t1')).map(e => e.kind)).toEqual(['operation_started'])
  })

  it('failOperation records the error and a stale attempt is rejected', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.failOperation(OP_CONTEXT, OP_SPEC, 1, { message: 'boom' })
    const op = must((await journal.operationsFor('t1'))[0], 'first operation for task t1')
    expect(op.status).toBe('failed')
    expect(op.error).toEqual({ message: 'boom' })
    await expect(journal.completeOperation(OP_CONTEXT, OP_SPEC, 2, {})).rejects.toThrow(/stale/)
  })

  it('redacts secrets in before, after, and error — in the row and the transitions', async () => {
    const db = await createTestDb()
    dbs.push(db)
    process.env.ORC_TEST_OP_SECRET = 'operation-secret-value-7'
    try {
      const { events: log, operations: journal } = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
      db.onClose(() => log.close())
      const spec = {
        ...OP_SPEC,
        before: {
          apiKey: 'raw-key-1', client_secret: 'raw-op-client-secret',
          prompt: 'use operation-secret-value-7',
        },
      }
      await journal.beginOperation(OP_CONTEXT, spec)
      await journal.failOperation(OP_CONTEXT, spec, 1, {
        message: 'failed with operation-secret-value-7', private_key: 'raw-op-private-key',
      })
      const second = await journal.beginOperation(OP_CONTEXT, spec)
      await journal.completeOperation(OP_CONTEXT, spec, second.attempt, {
        echo: 'operation-secret-value-7', credentials: 'raw-op-credentials',
      })
      const stored = JSON.stringify(await journal.operationsFor('t1')) + JSON.stringify(await log.byTask('t1'))
      for (const secret of [
        'raw-key-1', 'raw-op-client-secret', 'raw-op-private-key',
        'raw-op-credentials', 'operation-secret-value-7',
      ]) expect(stored).not.toContain(secret)
    } finally {
      delete process.env.ORC_TEST_OP_SECRET
    }
  })

  it('a keyed replay whose payload has an undefined-valued key is still the same event', async () => {
    const log = await freshLog()
    const payload = {
      stepId: 's1', runToken: 'r1',
      signal: { stepId: 's1', runToken: 'r1', outcome: 'success', summary: 'ok', outputs: undefined },
    }
    const first = await log.append({ ...ORIGIN, taskId: 't1', stepId: 's1', runToken: 'r1', kind: EVENT_KIND.signal_received, payload, idempotencyKey: 'r1:signal' })
    const replay = await log.append({ ...ORIGIN, taskId: 't1', stepId: 's1', runToken: 'r1', kind: EVENT_KIND.signal_received, payload, idempotencyKey: 'r1:signal' })
    expect(replay.seq).toBe(first.seq) // jsonb drops the key; the comparison must agree
  })

  it('failOperation never regresses a completed node; complete re-entry is idempotent; stale is terminal', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'done' })

    // lost-ack failure path after a durable completion: must be a no-op
    await journal.failOperation(OP_CONTEXT, OP_SPEC, 1, { message: 'connection reset' })
    expect(must((await journal.operationsFor('t1'))[0], 'first operation for task t1').status).toBe('completed')

    // re-entry of the committed attempt returns the stored value instead of throwing
    expect(await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'done' })).toEqual({ text: 'done' })

    // a stale attempt must be terminal — the durable-step wrapper must not re-fire the effect
    const stale = await journal.completeOperation(OP_CONTEXT, OP_SPEC, 7, {}).catch(e => e)
    expect(isTerminalError(stale)).toBe(true)
  })

  it('rebuildOperations reproduces the journal byte-for-byte from transitions, per project', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const s1 = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    db.onClose(() => s1.close())
    const s2 = await openStorage(db.url, { projectId: '00000000-0000-4000-8000-000000000002' })
    db.onClose(() => s2.close())
    const journal = s1.operations
    const spec2: OperationSpec = { ...OP_SPEC, operationId: 'step:t1:s1:a1:tool:1:c1', kind: 'tool', name: 'echo' }
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'a' })
    await journal.beginOperation(OP_CONTEXT, spec2)
    await journal.completeOperation(OP_CONTEXT, spec2, 1, { ok: true })
    await s2.operations.beginOperation(OP_CONTEXT, OP_SPEC)

    const before = await journal.operationsFor('t1')
    // wipe this project's journal rows out from under it, then rebuild from events
    const wiped = await journal.rebuildOperations()
    expect(wiped).toBe(2)
    expect(await journal.operationsFor('t1')).toEqual(before)
    expect(await s2.operations.operationsFor('t1')).toHaveLength(1) // untouched
  })
})

// store.write needs ONE note as its merge base, and used to fold the project's entire memory
// history to find it — inside the project advisory lock, which serializes every other writer.
describe('latestNoteEvent', () => {
  const wrote = (id: string, scope: string, body: string) => ({
    ...ORIGIN, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
    payload: { note: { id, scope, title: id, body }, author: authorFixture() },
  })
  const deleted = (id: string, scope: string) => ({
    ...ORIGIN, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted,
    payload: { id, scope, author: authorFixture() },
  })

  it('returns the newest event for that note, ignoring other notes and other scopes', async () => {
    const log = await freshLog()
    await log.append(wrote('auth', 'project', 'first'))
    await log.append(wrote('other', 'project', 'noise'))
    await log.append(wrote('auth', 'plan-t1', 'different lane'))
    await log.append(wrote('auth', 'project', 'second'))
    const found = await log.latestNoteEvent('project', 'auth')
    expect(found?.kind).toBe(EVENT_KIND.memory_written)
    expect(JSON.stringify(found?.payload)).toContain('second')
  })

  it('a delete is the newest event, so the caller sees no live base', async () => {
    const log = await freshLog()
    await log.append(wrote('auth', 'project', 'first'))
    await log.append(deleted('auth', 'project'))
    expect((await log.latestNoteEvent('project', 'auth'))?.kind).toBe(EVENT_KIND.memory_deleted)
  })

  it('a re-write after a delete wins again', async () => {
    const log = await freshLog()
    await log.append(wrote('auth', 'project', 'first'))
    await log.append(deleted('auth', 'project'))
    await log.append(wrote('auth', 'project', 'reborn'))
    const found = await log.latestNoteEvent('project', 'auth')
    expect(found?.kind).toBe(EVENT_KIND.memory_written)
    expect(JSON.stringify(found?.payload)).toContain('reborn')
  })

  it('an unknown note is null', async () => {
    const log = await freshLog()
    expect(await log.latestNoteEvent('project', 'nope')).toBeNull()
  })
})
