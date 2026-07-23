import { afterAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { EVENT_KIND, isTerminalError, type EventInput, type OperationSpec } from '@orc/contracts'
import { listProjectIds, openStorage, type EventLog, type Storage } from './storage'
import { migrateDatabase } from './storage/migrate'
import { events } from './schema'
import { createTestDb, TEST_PROJECT_ID } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

async function freshStorage(): Promise<Storage> {
  const db = await createTestDb()
  dbs.push(db)
  return openStorage(db.url, { projectId: TEST_PROJECT_ID })
}
async function freshLog(): Promise<EventLog> {
  return (await freshStorage()).events
}

describe('listProjectIds', () => {
  it('lists every project with events, most recently active first', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const s1 = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const other = '99999999-9999-9999-9999-999999999999'
    const s2 = await openStorage(db.url, { projectId: other })
    const draft = { taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'p', title: 'p' }, author: { source: 'cli' } } } as const
    await s1.events.append(draft)
    await s2.events.append(draft)
    expect(await listProjectIds(db.url)).toEqual([other, TEST_PROJECT_ID]) // s2 wrote last
    await s1.close(); await s2.close()
  })
})

function errorCodes(error: unknown): string[] {
  if (!error || typeof error !== 'object') return []
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] }
  return [
    ...(typeof value.code === 'string' ? [value.code] : []),
    ...errorCodes(value.cause),
    ...(value.errors ?? []).flatMap(errorCodes),
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

    const err = await openStorage(db.url, { projectId: TEST_PROJECT_ID }).catch(e => e as Error)
    expect(err.message).toMatch(/database schema is behind \(0\/\d+ migrations applied\)/)
    // the "(checked host/db)" suffix says WHICH database (a wrong cwd hits a different one) —
    // but only host+path, never credentials, so a regression that interpolates the raw url is caught
    expect(err.message).toContain('(checked ')
    expect(err.message).toContain(new URL(db.url).host) // host:port is shown
    expect(err.message).not.toContain('@')              // no user/password ever reaches the message
  })
})

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
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    await log.append(statusEvent())
    await log.close()
    const reopened = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    expect(await reopened.all()).toHaveLength(1)
    await reopened.close()
  })

  it('migration 0002 assigns pre-existing rows to the unreachable legacy project', async () => {
    const db = await createTestDb({ migrate: false })
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

    // applying the remaining migration backfills project_id on the pre-existing rows
    await migrateDatabase(db.url)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
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
    const p1 = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const p2 = (await openStorage(db.url, { projectId: other })).events
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
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const other = (await openStorage(db.url, { projectId: '00000000-0000-4000-8000-000000000002' })).events

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
      const log = (await openStorage(db.url, {
        projectId: TEST_PROJECT_ID,
        redactEnv: ['ORC_TEST_CUSTOM_CREDS'],
      })).events
      await log.append({
        taskId: 't1', stepId: 's1', runToken: 'r1', kind: 'tool_result',
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

const OP_CONTEXT = { taskId: 't1', stepId: 's1', runToken: 'step:t1:s1:a1' }
const OP_SPEC: OperationSpec = { operationId: 'step:t1:s1:a1:model:1', kind: 'model', name: 'fake/m', before: { messages: ['hi'] } }

describe('OperationJournal', () => {
  it('beginOperation commits a started node and its transition before external code runs', async () => {
    const { events: log, operations: journal } = await freshStorage()
    const begin = await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    expect(begin).toEqual({ reused: false, attempt: 1 })
    const [op] = await journal.operationsFor('t1')
    expect(op!.status).toBe('started')
    expect(op!.attempts).toBe(1)
    expect(op!.name).toBe('fake/m')
    const kinds = (await log.byTask('t1')).map(e => e.kind)
    expect(kinds).toEqual(['operation_started'])
    await log.close()
  })

  it('completeOperation stores after and appends completion plus drafts atomically', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'answer' }, [
      { kind: 'agent_call', payload: { stepId: 's1', runToken: OP_CONTEXT.runToken, iteration: 1, request: {}, response: { text: 'answer' } } },
    ])
    const [op] = await journal.operationsFor('t1')
    expect(op!.status).toBe('completed')
    expect(op!.after).toEqual({ text: 'answer' })
    expect(op!.finishedSeq).not.toBeNull()
    const kinds = (await log.byTask('t1')).map(e => e.kind)
    expect(kinds).toEqual(['operation_started', 'operation_completed', 'agent_call'])
    await log.close()
  })

  it('beginOperation after completion reuses the stored value without another attempt', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'answer' })
    const again = await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    expect(again).toEqual({ reused: true, attempt: 1, value: { text: 'answer' } })
    expect((await log.byTask('t1')).filter(e => e.kind === 'operation_started')).toHaveLength(1)
    await log.close()
  })

  it('beginOperation on a still-started node records the ambiguous retry as attempt 2', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    const second = await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    expect(second).toEqual({ reused: false, attempt: 2 })
    const [op] = await journal.operationsFor('t1')
    expect(op!.attempts).toBe(2)
    expect(op!.status).toBe('started')
    expect((await log.byTask('t1')).filter(e => e.kind === 'operation_started')).toHaveLength(2)
    await log.close()
  })

  it('a failed completion draft rolls back the whole completion', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await expect(
      journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'x' }, [
        { kind: 'agent_call', payload: { wrong: true } }, // fails payload validation
      ]),
    ).rejects.toThrow()
    const [op] = await journal.operationsFor('t1')
    expect(op!.status).toBe('started') // update rolled back with the event
    expect((await log.byTask('t1')).map(e => e.kind)).toEqual(['operation_started'])
    await log.close()
  })

  it('failOperation records the error and a stale attempt is rejected', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.failOperation(OP_CONTEXT, OP_SPEC, 1, { message: 'boom' })
    const [op] = await journal.operationsFor('t1')
    expect(op!.status).toBe('failed')
    expect(op!.error).toEqual({ message: 'boom' })
    await expect(journal.completeOperation(OP_CONTEXT, OP_SPEC, 2, {})).rejects.toThrow(/stale/)
    await log.close()
  })

  it('redacts secrets in before, after, and error — in the row and the transitions', async () => {
    const db = await createTestDb()
    dbs.push(db)
    process.env.ORC_TEST_OP_SECRET = 'operation-secret-value-7'
    try {
      const { events: log, operations: journal } = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
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
      await log.close()
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
    const first = await log.append({ taskId: 't1', stepId: 's1', runToken: 'r1', kind: 'signal_received', payload, idempotencyKey: 'r1:signal' })
    const replay = await log.append({ taskId: 't1', stepId: 's1', runToken: 'r1', kind: 'signal_received', payload, idempotencyKey: 'r1:signal' })
    expect(replay.seq).toBe(first.seq) // jsonb drops the key; the comparison must agree
    await log.close()
  })

  it('failOperation never regresses a completed node; complete re-entry is idempotent; stale is terminal', async () => {
    const { events: log, operations: journal } = await freshStorage()
    await journal.beginOperation(OP_CONTEXT, OP_SPEC)
    await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'done' })

    // lost-ack failure path after a durable completion: must be a no-op
    await journal.failOperation(OP_CONTEXT, OP_SPEC, 1, { message: 'connection reset' })
    expect((await journal.operationsFor('t1'))[0]!.status).toBe('completed')

    // re-entry of the committed attempt returns the stored value instead of throwing
    expect(await journal.completeOperation(OP_CONTEXT, OP_SPEC, 1, { text: 'done' })).toEqual({ text: 'done' })

    // a stale attempt must be terminal — the durable-step wrapper must not re-fire the effect
    const stale = await journal.completeOperation(OP_CONTEXT, OP_SPEC, 7, {}).catch(e => e)
    expect(isTerminalError(stale)).toBe(true)
    await log.close()
  })

  it('rebuildOperations reproduces the journal byte-for-byte from transitions, per project', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const s1 = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
    const s2 = await openStorage(db.url, { projectId: '00000000-0000-4000-8000-000000000002' })
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
    await s1.close()
    await s2.close()
  })
})
