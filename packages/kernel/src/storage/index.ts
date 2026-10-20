import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { PostgresStore } from './postgres'
import { EventLog } from './event-log'
import { OperationJournal } from './operation-journal'
import { events, operations } from '../schema'
import type { Redactor } from '../redact'

export { PostgresStore, listProjectIds, watchProjectIds, type ProjectIdsWatch, type Tx } from './postgres'
export { EventLog, type EventLogOps } from './event-log'
export { OperationJournal } from './operation-journal'
export {
  beat, claimSlot, forget, liveSupervisors, staleSupervisors,
  SUPERVISOR_BEAT_MS, SUPERVISOR_STALE_MS, type SupervisorRow,
} from './supervisors'
export { assertMigrated, migrateDatabase } from './migrate'
// runtimeLockHeld is the READ side: health asks whether anything is driving without taking the lock
export { runtimeLockHeld } from './runtime-lock'
export { dropSystemDatabase, resetSystemDatabase } from './system-db'

// `db`/`projectId` are exposed read-only; pool, lock and migrations stay private
export interface Storage {
  events: EventLog
  operations: OperationJournal
  redact: Redactor
  readonly db: NodePgDatabase
  readonly projectId: string
  // resets THIS project's events and journal; callers must ensure nothing is running
  purge(): Promise<{ events: number; operations: number }>
  close(): Promise<void>
}

export async function openStorage(url: string, opts: { projectId: string; redactEnv?: string[] }): Promise<Storage> {
  const store = await PostgresStore.open(url, opts)
  const log = new EventLog(store)
  const journal = new OperationJournal(store, log)
  return {
    events: log,
    operations: journal,
    redact: store.redact,
    db: store.db,
    projectId: store.projectId,
    purge: () => store.withProjectLock(async tx => {
      const ops = await tx.delete(operations).where(eq(operations.projectId, store.projectId))
      const evs = await tx.delete(events).where(eq(events.projectId, store.projectId))
      return { events: evs.rowCount ?? 0, operations: ops.rowCount ?? 0 }
    }),
    close: () => store.close(),
  }
}
