import { eq } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { PostgresStore } from './postgres'
import { EventLog } from './event-log'
import { OperationJournal } from './operation-journal'
import { events, operations } from '../schema'
import type { Redactor } from '../redact'

export { PostgresStore, listProjectIds, watchProjectIds, type ProjectIdsWatch, type Tx } from './postgres'
export { EventLog, type EventLogOps } from './event-log'
export { OperationJournal, type OperationContext } from './operation-journal'
export {
  beat, claimSlot, forget, liveSupervisors, staleSupervisors,
  SUPERVISOR_BEAT_MS, SUPERVISOR_STALE_MS, type SupervisorRow,
} from './supervisors'
export { assertMigrated, migrateDatabase } from './migrate'
export { resetSystemDatabase } from './system-db'

// Postgres facade: callers use `events`/`operations`, never pools/locks/migrations. The one
// exception is `db`/`projectId`, exposed read-only for tables that don't warrant their own
// EventLog/OperationJournal-style wrapper (see storage/supervisors.ts) — a plain select/insert/
// delete, not a pool, lock, or migration. `withProjectLock`/`close`/`url` stay on PostgresStore,
// unreachable from here, same as EventLog/OperationJournal hold it privately and never hand it out.
// `redact` is exposed because DBOS persists step return values into its own system-database
// table, outside EventLog.append's boundary — see dbos-port's redactStepResult.
export interface Storage {
  events: EventLog
  operations: OperationJournal
  redact: Redactor
  readonly db: NodePgDatabase
  readonly projectId: string
  // destructive reset of THIS project: every event and journal row, one locked transaction.
  // Identity (.orc/identity.json) and the DBOS system database stay — finished workflow rows
  // are inert; callers must ensure nothing is running (see OrcActions.purgeProject's guard).
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
