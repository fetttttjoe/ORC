import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { asc, eq } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { EventInput, PAYLOAD_SCHEMAS, type EventRecord } from '@orc/contracts'
import { events } from './schema'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

type Row = typeof events.$inferSelect
type Queryable = Pick<NodePgDatabase, 'insert' | 'select'>

const toRecord = (r: Row): EventRecord => ({
  seq: r.seq,
  taskId: r.taskId,
  stepId: r.stepId,
  runToken: r.runToken,
  kind: r.kind,
  payload: r.payload,
  ts: r.ts.toISOString(),
})

export interface EventLogOps {
  append(input: EventInput): Promise<EventRecord>
  byTask(taskId: string): Promise<EventRecord[]>
  all(): Promise<EventRecord[]>
}

const makeOps = (db: Queryable): EventLogOps => ({
  async append(input) {
    const parsed = EventInput.parse(input)
    PAYLOAD_SCHEMAS[parsed.kind].parse(parsed.payload)
    const [row] = await db
      .insert(events)
      .values({
        taskId: parsed.taskId,
        stepId: parsed.stepId,
        runToken: parsed.runToken,
        kind: parsed.kind,
        payload: parsed.payload,
      })
      .returning({ seq: events.seq, ts: events.ts })
    return { ...parsed, seq: row!.seq, ts: row!.ts.toISOString() }
  },
  async byTask(taskId) {
    const rows = await db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.seq))
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
  all(): Promise<EventRecord[]> {
    return this.ops.all()
  }

  // reads/appends inside fn MUST go through tx — pool queries would escape the transaction (spec §4)
  transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => fn(makeOps(tx as unknown as Queryable)))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
