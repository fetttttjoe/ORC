import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { EventInput, PAYLOAD_SCHEMAS, type EventKind, type EventRecord } from '@orc/contracts'
import { events } from '../schema'
import type { Redactor } from '../redact'
import { PostgresStore, type Tx } from './postgres'

const NOTIFY_CHANNEL = 'orc_events'
const RECONNECT_DELAYS_MS = [100, 200, 400, 800, 1600, 3000]
const PUMP_RETRY_MS = 250

type Row = typeof events.$inferSelect
type Queryable = Pick<Tx, 'insert' | 'select' | 'execute'>

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
    async append(input) {
      const parsed = EventInput.parse(input)
      // jsonb-shape the payload (drops undefined keys) before redact/compare — otherwise a
      // byte-identical keyed replay deep-compares unequal against the stored row and throws
      const payload = ctx.redact(JSON.parse(JSON.stringify(parsed.payload)))
      PAYLOAD_SCHEMAS[parsed.kind].parse(payload) // validated AFTER redaction: zod errors never quote raw secrets
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

// onAppend is observe-only (spec D6): it fires inside the open transaction and may see
// events that later roll back — observers must not assume durability.
export class EventLog implements EventLogOps {
  onAppend?: (e: EventRecord) => void
  private readonly ctx: LogContext
  private readonly ops: EventLogOps

  constructor(private readonly store: PostgresStore) {
    this.ctx = { projectId: store.projectId, redact: store.redact, notify: e => this.onAppend?.(e) }
    this.ops = makeOps(store.db, this.ctx)
  }

  get projectId(): string {
    return this.store.projectId
  }

  // tx-scoped ops on this log's context — the journal appends through this
  txOps(tx: Tx): EventLogOps {
    return makeOps(tx, this.ctx)
  }

  append(input: EventInput): Promise<EventRecord> {
    return this.transaction(tx => tx.append(input))
  }
  byTask(taskId: string): Promise<EventRecord[]> {
    return this.ops.byTask(taskId)
  }
  byTaskSince(taskId: string, afterSeq: number): Promise<EventRecord[]> {
    return this.ops.byTaskSince(taskId, afterSeq)
  }
  after(afterSeq: number, kinds?: EventKind[]): Promise<EventRecord[]> {
    return this.ops.after(afterSeq, kinds)
  }
  all(): Promise<EventRecord[]> {
    return this.ops.all()
  }

  // events with seq > afterSeq, counted in SQL — health probes must not materialize payloads
  async countAfter(afterSeq: number, kinds?: EventKind[]): Promise<number> {
    const [row] = await this.store.db.select({ n: count() }).from(events)
      .where(and(eq(events.projectId, this.store.projectId), gt(events.seq, afterSeq), kinds ? inArray(events.kind, kinds) : undefined))
    return row?.n ?? 0
  }

  // reads/appends inside fn MUST go through tx — pool queries would escape the transaction (spec §4)
  transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T> {
    return this.store.withProjectLock(tx => fn(this.txOps(tx)))
  }

  private async latestSeq(): Promise<number> {
    const [row] = await this.store.db.select({ seq: events.seq }).from(events)
      .where(eq(events.projectId, this.store.projectId)).orderBy(desc(events.seq)).limit(1)
    return row?.seq ?? 0
  }

  // Lossless stream (spec §5.4): NOTIFY is only a wake-up, catch-up queries are
  // authoritative; the cursor advances only after the handler succeeds; a dropped LISTEN
  // connection reconnects with bounded backoff and catches up first.
  async subscribe(
    opts: { fromSeq?: number },
    handler: (e: EventRecord) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    let cursor = opts.fromSeq ?? (await this.latestSeq())
    let closed = false
    let client: pg.Client | null = null
    let pumpTimer: ReturnType<typeof setTimeout> | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null
    let backoff = 0
    let pumping = false
    let wakeAgain = false

    const pump = async (): Promise<void> => {
      if (pumping) { wakeAgain = true; return }
      pumping = true
      try {
        do {
          wakeAgain = false
          const rows = await this.store.db.select().from(events)
            .where(and(eq(events.projectId, this.store.projectId), gt(events.seq, cursor)))
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
        if (!closed && pumpTimer === null) pumpTimer = setTimeout(() => { pumpTimer = null; pumpSafe() }, PUMP_RETRY_MS)
      })
    }
    const scheduleReconnect = (): void => {
      if (closed || reconnectTimer !== null) return
      const delay = RECONNECT_DELAYS_MS[Math.min(backoff, RECONNECT_DELAYS_MS.length - 1)]!
      backoff += 1
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connect(false)
      }, delay)
    }
    const connect = async (initial: boolean): Promise<void> => {
      if (closed) return
      const c = new pg.Client({ connectionString: this.store.url, application_name: `orc-events-${this.store.projectId}` })
      // an 'error' event with no listener crashes the process (Node default), so the handler must
      // stay attached even after close — but it must stop TALKING, the way the 'end' handler
      // already does. A subscription that was disposed has nothing to report: the socket dying
      // afterwards is the expected consequence of closing it, and warning about it prints an
      // alarming line after the user's command already finished.
      c.on('error', err => {
        if (!closed) console.warn(`event stream listener error: ${err instanceof Error ? err.message : String(err)}`)
      })
      try {
        await c.connect()
        await c.query(`LISTEN ${NOTIFY_CHANNEL}`)
        // the disposer may have run during the awaits above; if so, don't adopt this
        // fresh LISTEN client — the disposer already ended the previous `client` and left.
        if (closed) { await c.end().catch(() => {}); return }
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
      if (pumpTimer !== null) clearTimeout(pumpTimer)
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
      client?.removeAllListeners('notification')
      await client?.end()
    }
  }

  close(): Promise<void> {
    return this.store.close()
  }
}
