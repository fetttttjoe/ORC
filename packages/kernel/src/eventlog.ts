import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import pg from 'pg'
import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import {
  EVENT_KIND, EventInput, OPERATION_STATUS, PAYLOAD_SCHEMAS, terminalError,
  type EventDraft, type EventKind, type EventRecord, type OperationRecord, type OperationSpec,
} from '@orc/contracts'
import { events, operations } from './schema'
import { applyOperationEvent, foldOperations } from './projections'
import { buildRedactor, type Redactor } from './redact'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))
const NOTIFY_CHANNEL = 'orc_events'
const RECONNECT_DELAYS_MS = [100, 200, 400, 800, 1600, 3000]
const PUMP_RETRY_MS = 250

type Row = typeof events.$inferSelect
type OperationRow = typeof operations.$inferSelect
type Queryable = Pick<NodePgDatabase, 'insert' | 'select' | 'execute'>
type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

const toOperation = (r: OperationRow): OperationRecord => ({
  projectId: r.projectId,
  operationId: r.operationId,
  taskId: r.taskId,
  stepId: r.stepId,
  runToken: r.runToken,
  kind: r.kind,
  name: r.name,
  status: r.status,
  attempts: r.attempts,
  before: r.before,
  after: r.after,
  error: r.error,
  startedSeq: r.startedSeq,
  finishedSeq: r.finishedSeq,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
})

const toOperationRow = (o: OperationRecord) => ({
  ...o,
  startedAt: new Date(o.startedAt),
  finishedAt: o.finishedAt === null ? null : new Date(o.finishedAt),
})

export interface OperationContext {
  taskId: string
  stepId: string
  runToken: string
}

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
      // normalize to exactly what jsonb will store (undefined-valued keys dropped) BEFORE
      // redacting and comparing — otherwise a byte-identical replay under an idempotency
      // key deep-compares unequal against the stored round-tripped row and throws
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

// onAppend is best-effort/observe-only (spec D6): it fires inside the open transaction,
// so it may see events that later roll back. Acceptable — observers must not assume
// durability of what they saw, only that it was appended at the time of the call.
export class EventLog implements EventLogOps {
  onAppend?: (e: EventRecord) => void
  private readonly ctx: LogContext

  private readonly ops: EventLogOps

  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: NodePgDatabase,
    private readonly url: string,
    readonly projectId: string,
    redact: Redactor,
  ) {
    this.ctx = { projectId, redact, notify: e => this.onAppend?.(e) }
    this.ops = makeOps(db, this.ctx)
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
      if (pumpTimer !== null) clearTimeout(pumpTimer)
      if (reconnectTimer !== null) clearTimeout(reconnectTimer)
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
    const [row] = await this.db.select({ n: count() }).from(events)
      .where(and(eq(events.projectId, this.projectId), gt(events.seq, afterSeq), kinds ? inArray(events.kind, kinds) : undefined))
    return row?.n ?? 0
  }

  // reads/appends inside fn MUST go through tx — pool queries would escape the transaction (spec §4)
  transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T> {
    return this.inTx((_tx, ops) => fn(ops))
  }

  private inTx<T>(fn: (tx: Tx, ops: EventLogOps) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      // Postgres READ COMMITTED lets two check-then-append transactions interleave (write
      // skew); the per-project advisory lock serializes writers within a project while
      // unrelated projects stay concurrent.
      // ponytail: one lock per project — every append (traces included) serializes on it;
      // move to per-task locks or a plain-append fast path if writer throughput matters
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${this.projectId}, 0))`)
      return fn(tx, makeOps(tx, this.ctx))
    })
  }

  private async operationRow(tx: Tx, operationId: string): Promise<OperationRow | undefined> {
    const [row] = await tx.select().from(operations)
      .where(and(eq(operations.projectId, this.projectId), eq(operations.operationId, operationId)))
    return row
  }

  private async upsertOperation(tx: Tx, rec: OperationRecord): Promise<void> {
    await tx.insert(operations).values(toOperationRow(rec))
      .onConflictDoUpdate({ target: [operations.projectId, operations.operationId], set: toOperationRow(rec) })
  }

  // The before-record of the durable journal (design §5.2): commits the start transition and
  // the current node in one transaction BEFORE any external code runs. A completed node is
  // reused (its redacted stored result), a started/failed node begins the next attempt —
  // explicitly at-least-once, the ambiguity is recorded rather than hidden.
  beginOperation(
    context: OperationContext,
    spec: OperationSpec,
  ): Promise<{ reused: boolean; attempt: number; value?: unknown }> {
    return this.inTx(async (tx, ops) => {
      const existing = await this.operationRow(tx, spec.operationId)
      if (existing?.status === OPERATION_STATUS.completed)
        return { reused: true, attempt: existing.attempts, value: existing.after }
      const attempt = (existing?.attempts ?? 0) + 1
      const event = await ops.append({
        taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
        kind: EVENT_KIND.operation_started,
        payload: { operationId: spec.operationId, attempt, operationKind: spec.kind, name: spec.name, before: spec.before },
        idempotencyKey: `${spec.operationId}:${attempt}:started`,
      })
      await this.upsertOperation(tx, applyOperationEvent(undefined, event))
      return { reused: false, attempt }
    })
  }

  // after-record: transition event, node update, and completion drafts commit atomically —
  // the graph node and the append-only history can never disagree.
  // Re-entry for an attempt that already committed is idempotent; a stale attempt throws
  // TERMINAL so the durable-step wrapper never re-fires the external effect over it.
  completeOperation(
    context: OperationContext,
    spec: OperationSpec,
    attempt: number,
    value: unknown,
    drafts: EventDraft[] = [],
  ): Promise<unknown> {
    return this.inTx(async (tx, ops) => {
      const existing = await this.operationRow(tx, spec.operationId)
      if (!existing) throw terminalError(`operation '${spec.operationId}' was never started`)
      if (existing.status === OPERATION_STATUS.completed) {
        if (existing.attempts === attempt) return existing.after // lost-ack re-entry: already durable
        throw terminalError(`operation '${spec.operationId}' already completed at attempt ${existing.attempts}`)
      }
      if (existing.attempts !== attempt)
        throw terminalError(`operation '${spec.operationId}' attempt ${attempt} is stale (current attempt is ${existing.attempts})`)
      const event = await ops.append({
        taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
        kind: EVENT_KIND.operation_completed,
        payload: { operationId: spec.operationId, attempt, after: value },
        idempotencyKey: `${spec.operationId}:${attempt}:completed`,
      })
      const next = applyOperationEvent(toOperation(existing), event)
      await this.upsertOperation(tx, next)
      for (const [i, d] of drafts.entries())
        await ops.append({
          taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
          kind: d.kind, payload: d.payload, usage: d.usage ?? null,
          idempotencyKey: d.idempotencyKey ?? `${spec.operationId}:${attempt}:draft:${i}`,
        })
      return next.after
    })
  }

  // Non-throwing on ambiguity: this runs from failure paths whose original error must
  // surface — and a COMPLETED node is never regressed (a lost commit-ack from
  // completeOperation must not flip a durable success into failed + re-run).
  failOperation(context: OperationContext, spec: OperationSpec, attempt: number, error: unknown): Promise<void> {
    return this.inTx(async (tx, ops) => {
      const existing = await this.operationRow(tx, spec.operationId)
      if (!existing) throw terminalError(`operation '${spec.operationId}' was never started`)
      if (existing.status === OPERATION_STATUS.completed || existing.attempts !== attempt) return
      const event = await ops.append({
        taskId: context.taskId, stepId: context.stepId, runToken: context.runToken,
        kind: EVENT_KIND.operation_failed,
        payload: { operationId: spec.operationId, attempt, error },
        idempotencyKey: `${spec.operationId}:${attempt}:failed`,
      })
      await this.upsertOperation(tx, applyOperationEvent(toOperation(existing), event))
    })
  }

  async operationsFor(taskId: string): Promise<OperationRecord[]> {
    const rows = await this.db.select().from(operations)
      .where(and(eq(operations.projectId, this.projectId), eq(operations.taskId, taskId)))
      .orderBy(asc(operations.startedSeq))
    return rows.map(toOperation)
  }

  // the journal is an index over the append-only truth: rebuild THIS project's rows from
  // its committed operation transitions
  rebuildOperations(): Promise<number> {
    return this.inTx(async (tx, ops) => {
      const transitions = await ops.after(0, [
        EVENT_KIND.operation_started, EVENT_KIND.operation_completed, EVENT_KIND.operation_failed,
      ])
      const folded = foldOperations(transitions)
      await tx.delete(operations).where(eq(operations.projectId, this.projectId))
      const rows = [...folded.values()].map(toOperationRow)
      if (rows.length > 0) await tx.insert(operations).values(rows)
      return folded.size
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
