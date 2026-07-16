import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { asc, eq } from 'drizzle-orm'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { EventInput, PAYLOAD_SCHEMAS, type EventRecord } from '@orc/contracts'
import { events } from './schema'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

type Row = typeof events.$inferSelect

const toRecord = (r: Row): EventRecord => ({
  seq: r.seq,
  taskId: r.taskId,
  stepId: r.stepId,
  runToken: r.runToken,
  kind: r.kind,
  payload: r.payload,
  ts: r.ts,
})

export class EventLog {
  private readonly sqlite: Database
  private readonly db: BunSQLiteDatabase

  constructor(path: string) {
    this.sqlite = new Database(path)
    this.sqlite.exec('PRAGMA journal_mode = WAL;')
    this.db = drizzle(this.sqlite)
    migrate(this.db, { migrationsFolder: MIGRATIONS_FOLDER })
  }

  append(input: EventInput): EventRecord {
    const parsed = EventInput.parse(input)
    PAYLOAD_SCHEMAS[parsed.kind].parse(parsed.payload)
    const row = this.db
      .insert(events)
      .values({
        taskId: parsed.taskId,
        stepId: parsed.stepId,
        runToken: parsed.runToken,
        kind: parsed.kind,
        payload: parsed.payload,
      })
      .returning({ seq: events.seq, ts: events.ts })
      .get()
    return { ...parsed, seq: row.seq, ts: row.ts }
  }

  byTask(taskId: string): EventRecord[] {
    return this.db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.seq)).all().map(toRecord)
  }

  all(): EventRecord[] {
    return this.db.select().from(events).orderBy(asc(events.seq)).all().map(toRecord)
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(() => fn())
  }

  close(): void {
    this.sqlite.close()
  }
}
