import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { EventInput, PAYLOAD_SCHEMAS, type EventKind, type EventRecord } from '@orc/contracts'
import { events } from './schema'
import { buildRedactor, type Redactor } from './redact'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))
const NOTIFY_CHANNEL = 'orc_events'
const RECONNECT_DELAYS_MS = [100, 200, 400, 800, 1600, 3000]
const PUMP_RETRY_MS = 250

type Row = typeof events.$inferSelect
type Queryable = Pick<NodePgDatabase, 'insert' | 'select' | 'execute'>

const toRecord = (r: Row): EventRecord => ({
  seq: r.seq,
  projectId: r.projectId,
  idempotencyKey: r.idempotencyKey,
  taskId: r.taskId,
  stepId: r.stepId,
  runToken: r.runToken,
  kind: r.kind,
  payload: r.payload,
  usage: r.usage ?? null,
  ts: r.ts.toISOString(),
})

export interface EventLogOps {
  append(input: EventInput): Promise<EventRecord>
  byTask(taskId: string): Promise<EventRecord[]>
  byTaskSince(taskId: string, afterSeq: number): Promise<EventRecord[]>
  after(afterSeq: number, kinds?: EventKind[]): Promise<EventRecord[]>
  all(): Promise<EventRecord[]>
}

interface LogContext {
  projectId: string
  redact: Redactor
  notify?: (e: EventRecord) => void
}

const makeOps = (db: Queryable, ctx: LogContext): EventLogOps => {
  const scoped = eq(events.projectId, ctx.projectId)
  return {
    // callers route through EventLog.append/transaction — both hold the project lock,
    // so insert + pg_notify commit atomically and sequence allocation cannot cross
    async append(input) {
      const parsed = EventInput.parse(input)
      PAYLOAD_SCHEMAS[parsed.kind].parse(parsed.payload)
      const payload = ctx.redact.record(parsed.payload)
      PAYLOAD_SCHEMAS[parsed.kind].parse(payload) // redaction must never invalidate a payload
      const values = {
        projectId: ctx.projectId,
        idempotencyKey: parsed.idempotencyKey,
        taskId: parsed.taskId,
        stepId: parsed.stepId,
        runToken: parsed.runToken,
        kind: parsed.kind,
        payload,
        usage: parsed.usage ?? null,
      }
      const [row] = await db.insert(events).values(values).onConflictDoNothing().returning()
      if (!row) {
        // conflict: the same (project, key) already committed — reuse only on identical data
        const key = parsed.idempotencyKey
        if (!key) throw new Error('event insert affected no row without an idempotency key')
        const [existing] = await db.select().from(events)
          .where(and(scoped, eq(events.idempotencyKey, key)))
        if (!existing) throw new Error(`idempotency key '${key}' conflicted but no stored event was found`)
        const record = toRecord(existing)
        const same = record.kind === values.kind && record.taskId === values.taskId
          && record.stepId === values.stepId && record.runToken === values.runToken
          && isDeepStrictEqual(record.payload, values.payload)
          && isDeepStrictEqual(record.usage, values.usage)
        if (!same) throw new Error(`idempotency key '${key}' reused with different event data`)
        return record
      }
      await db.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${String(row.seq)})`)
      const record = toRecord(row)
      try {
        ctx.notify?.(record)
      } catch (err) {
        console.warn(`event observer failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return record
    },
    async byTask(taskId) {
      const rows = await db.select().from(events)
        .where(and(scoped, eq(events.taskId, taskId))).orderBy(asc(events.seq))
      return rows.map(toRecord)
    },
    async byTaskSince(taskId, afterSeq) {
      const rows = await db.select().from(events)
        .where(and(scoped, eq(events.taskId, taskId), gt(events.seq, afterSeq)))
        .orderBy(asc(events.seq))
      return rows.map(toRecord)
    },
    async after(afterSeq, kinds) {
      const rows = await db.select().from(events)
        .where(and(scoped, gt(events.seq, afterSeq), kinds ? inArray(events.kind, kinds) : undefined))
        .orderBy(asc(events.seq))
      return rows.map(toRecord)
    },
    async all() {
      const rows = await db.select().from(events).where(scoped).orderBy(asc(events.seq))
      return rows.map(toRecord)
    },
  }
}

// onAppend is best-effort/observe-only (spec D6): it fires inside the open transaction,
// so it may see events that later roll back. Acceptable — observers must not assume
// durability of what they saw, only that it was appended at the time of the call.
export class EventLog implements EventLogOps {
  onAppend?: (e: EventRecord) => void
  private readonly ctx: LogContext

  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: NodePgDatabase,
    private readonly url: string,
    readonly projectId: string,
    redact: Redactor,
  ) {
    this.ctx = { projectId, redact, notify: e => this.onAppend?.(e) }
  }

  static async open(url: string, opts: { projectId: string; redactEnv?: string[] }): Promise<EventLog> {
    const pool = new pg.Pool({ connectionString: url })
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    return new EventLog(pool, db, url, opts.projectId, buildRedactor(process.env, opts.redactEnv ?? []))
  }

  private async latestSeq(): Promise<number> {
    const [row] = await this.db.select({ seq: events.seq }).from(events)
      .where(eq(events.projectId, this.projectId)).orderBy(desc(events.seq)).limit(1)
    return row?.seq ?? 0
  }

  // Durable, ordered, lossless event stream (spec §5.4). One dedicated LISTEN connection;
  // reads go through the pool. NOTIFY is only a wake-up — catch-up queries are authoritative.
  // The cursor advances only after the handler succeeds; a failed handler is retried from
  // the same cursor. A dropped LISTEN connection reconnects with bounded backoff and
  // catches up before resuming live delivery.
  async subscribe(
    opts: { fromSeq?: number },
    handler: (e: EventRecord) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    let cursor = opts.fromSeq ?? (await this.latestSeq())
    let closed = false
    let client: pg.Client | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let backoff = 0
    let pumping = false
    let wakeAgain = false

    const pump = async (): Promise<void> => {
      if (pumping) { wakeAgain = true; return }
      pumping = true
      try {
        do {
          wakeAgain = false
          const rows = await this.db.select().from(events)
            .where(and(eq(events.projectId, this.projectId), gt(events.seq, cursor)))
            .orderBy(asc(events.seq))
          for (const r of rows) {
            await handler(toRecord(r)) // cursor moves ONLY after success — no lost events
            cursor = r.seq
          }
        } while (wakeAgain)
      } finally {
        pumping = false
      }
    }
    const pumpSafe = (): void => {
      void pump().catch(err => {
        console.warn(`event stream pump failed: ${err instanceof Error ? err.message : String(err)}`)
        if (!closed && timer === null) timer = setTimeout(() => { timer = null; pumpSafe() }, PUMP_RETRY_MS)
      })
    }
    const scheduleReconnect = (): void => {
      if (closed || timer !== null) return
      const delay = RECONNECT_DELAYS_MS[Math.min(backoff, RECONNECT_DELAYS_MS.length - 1)]!
      backoff += 1
      timer = setTimeout(() => {
        timer = null
        void connect(false)
      }, delay)
    }
    const connect = async (initial: boolean): Promise<void> => {
      if (closed) return
      const c = new pg.Client({ connectionString: this.url, application_name: `orc-events-${this.projectId}` })
      // an 'error' event with no listener crashes the process (Node default), so log + reconnect
      c.on('error', err => console.warn(`event stream listener error: ${err instanceof Error ? err.message : String(err)}`))
      try {
        await c.connect()
        await c.query(`LISTEN ${NOTIFY_CHANNEL}`)
        client = c
        c.on('notification', () => pumpSafe())
        c.once('end', () => {
          if (!closed) scheduleReconnect()
        })
        await pump() // catch-up closes the gap before live delivery resumes
        backoff = 0
      } catch (err) {
        await c.end().catch(() => {})
        if (initial) throw err
        console.warn(`event stream reconnect failed: ${err instanceof Error ? err.message : String(err)}`)
        scheduleReconnect()
      }
    }
    await connect(true)
    return async () => {
      closed = true
      if (timer !== null) clearTimeout(timer)
      client?.removeAllListeners('notification')
      await client?.end()
    }
  }

  // public append is the same atomic path as transaction(): project lock, insert,
  // pg_notify, commit — all one Postgres transaction
  append(input: EventInput): Promise<EventRecord> {
    return this.transaction(tx => tx.append(input))
  }
  byTask(taskId: string): Promise<EventRecord[]> {
    return makeOps(this.db, this.ctx).byTask(taskId)
  }
  byTaskSince(taskId: string, afterSeq: number): Promise<EventRecord[]> {
    return makeOps(this.db, this.ctx).byTaskSince(taskId, afterSeq)
  }
  after(afterSeq: number, kinds?: EventKind[]): Promise<EventRecord[]> {
    return makeOps(this.db, this.ctx).after(afterSeq, kinds)
  }
  all(): Promise<EventRecord[]> {
    return makeOps(this.db, this.ctx).all()
  }

  // reads/appends inside fn MUST go through tx — pool queries would escape the transaction (spec §4)
  transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      // Postgres READ COMMITTED lets two check-then-append transactions interleave (write
      // skew); the per-project advisory lock serializes writers within a project while
      // unrelated projects stay concurrent.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${this.projectId}, 0))`)
      return fn(makeOps(tx, this.ctx))
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
