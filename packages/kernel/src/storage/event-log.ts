import { isDeepStrictEqual } from 'node:util'
import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { errorMessage, EVENT_KIND, EventInput, PAYLOAD_SCHEMAS, type EventKind, type EventRecord } from '@orc/contracts'
import { events } from '../schema'
import { KERNEL_ERROR_CODE, KernelError } from '../errors'
import type { Redactor } from '../redact'
import { isGonePermanently, NOTIFY_CHANNEL, PostgresStore, type Tx } from './postgres'
import { pgListen } from './pg-listen'

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
  // The newest memory_written/memory_deleted naming this note, or null. A memory_written result is
  // the note's current state; a memory_deleted means it has none. Indexed (0004), so a merge base
  // costs one row instead of a fold of every memory event ever written.
  latestNoteEvent(scope: string, id: string): Promise<EventRecord | null>
  // Oldest surviving seq for this project, or 0 when the log is empty. A cached reader compares it
  // against what it still believes in: history only moves forward when it was TRUNCATED (purge,
  // delete chat), which no event announces.
  earliestSeq(): Promise<number>
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
        if (!same) throw new KernelError(KERNEL_ERROR_CODE.idempotency_conflict, `idempotency key '${key}' reused with different event data`)
        return record
      }
      await db.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${String(row.seq)})`)
      const record = toRecord(row)
      try {
        ctx.notify?.(record)
      } catch (err) {
        console.warn(`event observer failed: ${errorMessage(err)}`)
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
    async earliestSeq() {
      const rows = await db.select({ seq: events.seq }).from(events).where(scoped).orderBy(asc(events.seq)).limit(1)
      return rows[0]?.seq ?? 0
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
    async latestNoteEvent(scope, id) {
      // expressions mirror idx_events_note_seq exactly — see drizzle/0004
      const rows = await db.select().from(events).where(and(
        scoped,
        inArray(events.kind, [EVENT_KIND.memory_written, EVENT_KIND.memory_deleted]),
        sql`coalesce(${events.payload}->'note'->>'scope', ${events.payload}->>'scope') = ${scope}`,
        sql`coalesce(${events.payload}->'note'->>'id', ${events.payload}->>'id') = ${id}`,
      )).orderBy(desc(events.seq)).limit(1)
      return rows[0] ? toRecord(rows[0]) : null
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

  earliestSeq(): Promise<number> {
    return this.ops.earliestSeq()
  }
  all(): Promise<EventRecord[]> {
    return this.ops.all()
  }
  latestNoteEvent(scope: string, id: string): Promise<EventRecord | null> {
    return this.ops.latestNoteEvent(scope, id)
  }

  // events with seq > afterSeq, counted in SQL — health probes must not materialize payloads
  async countAfter(afterSeq: number, kinds?: EventKind[]): Promise<number> {
    const [row] = await this.store.db.select({ n: count() }).from(events)
      .where(and(eq(events.projectId, this.store.projectId), gt(events.seq, afterSeq), kinds ? inArray(events.kind, kinds) : undefined))
    return row?.n ?? 0
  }

  // reads/appends inside fn MUST go through tx — pool queries would escape the transaction
  transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T> {
    return this.store.withProjectLock(tx => fn(this.txOps(tx)))
  }

  private async latestSeq(): Promise<number> {
    const [row] = await this.store.db.select({ seq: events.seq }).from(events)
      .where(eq(events.projectId, this.store.projectId)).orderBy(desc(events.seq)).limit(1)
    return row?.seq ?? 0
  }

  // Lossless stream: NOTIFY is only a wake-up, catch-up queries are
  // authoritative; the cursor advances only after the handler succeeds; a dropped LISTEN
  // connection reconnects with bounded backoff and catches up first.
  // `onReset` fires when delivery restarts from a DIFFERENT log (see rewindIfReplaced) — a
  // subscriber caching a fold must drop it, or it carries ghosts from the old history.
  async subscribe(
    opts: { fromSeq?: number; onReset?: () => void | Promise<void> },
    handler: (e: EventRecord) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    let cursor = opts.fromSeq ?? (await this.latestSeq())
    let closed = false
    let pumpTimer: ReturnType<typeof setTimeout> | null = null
    let pumping = false
    let wakeAgain = false
    let firstConnect = true

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
        console.warn(`event stream pump failed: ${errorMessage(err)}`)
        if (!closed && pumpTimer === null) pumpTimer = setTimeout(() => { pumpTimer = null; pumpSafe() }, PUMP_RETRY_MS)
      })
    }
    // A log that no longer reaches our cursor is a different log (dropped and re-created, restored,
    // repointed). `seq > cursor` would then match nothing forever — silently, with no error and no
    // dead connection to notice.
    const rewindIfReplaced = async (): Promise<void> => {
      if (cursor === 0 || (await this.latestSeq()) >= cursor) return
      cursor = 0
      await opts.onReset?.()
    }

    const listener = await pgListen({
      url: this.store.url,
      applicationName: `orc-events-${this.store.projectId}`,
      channel: NOTIFY_CHANNEL,
      onNotification: () => pumpSafe(),
      onConnected: async () => {
        await rewindIfReplaced() // a reconnect is exactly when the log underneath may have changed
        // catch-up closes the gap before live delivery resumes. On the INITIAL connect it must
        // throw — the caller is still waiting to learn whether the subscription came up. On a
        // RECONNECT it must not: pgListen reacts to a failure here by ending a perfectly healthy
        // LISTEN and backing off, so a handler that threw once cost the stream its socket and
        // pinned the backoff, where the steady-state path (pumpSafe, wired to onNotification)
        // would have warned and retried in 250ms with LISTEN intact.
        if (firstConnect) { firstConnect = false; await pump() }
        else pumpSafe()
      },
      isGonePermanently,
      // measured: with the database dropped mid-pump, the 250 ms retry re-armed on every failure
      // for the rest of the process — four warnings in the first 1.2 s
      onStopped: () => {
        closed = true
        if (pumpTimer !== null) { clearTimeout(pumpTimer); pumpTimer = null }
      },
      warn: msg => console.warn(`event stream ${msg}`),
    })
    return async () => {
      closed = true
      if (pumpTimer !== null) clearTimeout(pumpTimer)
      await listener.close()
    }
  }

  close(): Promise<void> {
    return this.store.close()
  }
}
