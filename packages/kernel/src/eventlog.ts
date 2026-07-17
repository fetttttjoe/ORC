import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { EventInput, PAYLOAD_SCHEMAS, type EventRecord } from '@orc/contracts'
import { events } from './schema'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

type Row = typeof events.$inferSelect
type Queryable = Pick<NodePgDatabase, 'insert' | 'select'>

// Postgres jsonb rejects \u0000 inside strings (22P05) — strip NULs at the boundary so
// binary-ish tool output can never fail an append (the old TEXT-mode log accepted them).
const stripNul = (v: unknown): unknown =>
  typeof v === 'string' ? v.replaceAll('\u0000', '')
  : Array.isArray(v) ? v.map(stripNul)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripNul(x)]))
  : v

const toRecord = (r: Row): EventRecord => ({
  seq: r.seq,
  taskId: r.taskId,
  stepId: r.stepId,
  runToken: r.runToken,
  kind: r.kind,
  payload: r.payload,
  usage: (r.usage as EventRecord['usage']) ?? null,
  ts: r.ts.toISOString(),
})

export interface EventLogOps {
  append(input: EventInput): Promise<EventRecord>
  byTask(taskId: string): Promise<EventRecord[]>
  byTaskSince(taskId: string, afterSeq: number): Promise<EventRecord[]>
  all(): Promise<EventRecord[]>
}

const makeOps = (db: Queryable): EventLogOps => ({
  async append(input) {
    const parsed = EventInput.parse(input)
    PAYLOAD_SCHEMAS[parsed.kind].parse(parsed.payload)
    const payload = stripNul(parsed.payload) as Record<string, unknown>
    const [row] = await db
      .insert(events)
      .values({
        taskId: parsed.taskId,
        stepId: parsed.stepId,
        runToken: parsed.runToken,
        kind: parsed.kind,
        payload,
        usage: parsed.usage ?? null,
      })
      .returning({ seq: events.seq, ts: events.ts })
    return { ...parsed, payload, usage: parsed.usage ?? null, seq: row!.seq, ts: row!.ts.toISOString() }
  },
  async byTask(taskId) {
    const rows = await db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.seq))
    return rows.map(toRecord)
  },
  async byTaskSince(taskId, afterSeq) {
    const rows = await db
      .select().from(events)
      .where(and(eq(events.taskId, taskId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
    return rows.map(toRecord)
  },
  async all() {
    const rows = await db.select().from(events).orderBy(asc(events.seq))
    return rows.map(toRecord)
  },
})

export class EventLog implements EventLogOps {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: NodePgDatabase,
    private readonly ops: EventLogOps,
  ) {}

  static async open(url: string): Promise<EventLog> {
    const pool = new pg.Pool({ connectionString: url })
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    return new EventLog(pool, db, makeOps(db))
  }

  append(input: EventInput): Promise<EventRecord> {
    return this.ops.append(input)
  }
  byTask(taskId: string): Promise<EventRecord[]> {
    return this.ops.byTask(taskId)
  }
  byTaskSince(taskId: string, afterSeq: number): Promise<EventRecord[]> {
    return this.ops.byTaskSince(taskId, afterSeq)
  }
  all(): Promise<EventRecord[]> {
    return this.ops.all()
  }

  // reads/appends inside fn MUST go through tx — pool queries would escape the transaction (spec §4)
  transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      // Postgres READ COMMITTED lets two check-then-append transactions interleave (write skew);
      // the advisory lock restores the old bun:sqlite single-writer serialization.
      // ponytail: one global lock — per-task locks if concurrent-writer throughput matters
      await tx.execute(sql`select pg_advisory_xact_lock(7303779)`) // 0x6f7263 'orc'
      return fn(makeOps(tx as unknown as Queryable))
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
