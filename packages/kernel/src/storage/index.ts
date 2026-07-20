import { PostgresStore } from './postgres'
import { EventLog } from './event-log'
import { OperationJournal } from './operation-journal'
import type { Redactor } from '../redact'

export { PostgresStore, listProjectIds, type Tx } from './postgres'
export { EventLog, type EventLogOps } from './event-log'
export { OperationJournal, type OperationContext } from './operation-journal'
export { assertMigrated, migrateDatabase } from './migrate'

// Postgres facade: callers use `events`/`operations`, never pools/locks/migrations.
// `redact` is exposed because DBOS persists step return values into its own system-database
// table, outside EventLog.append's boundary — see dbos-port's redactStepResult.
export interface Storage {
  events: EventLog
  operations: OperationJournal
  redact: Redactor
  close(): Promise<void>
}

export async function openStorage(url: string, opts: { projectId: string; redactEnv?: string[] }): Promise<Storage> {
  const store = await PostgresStore.open(url, opts)
  const events = new EventLog(store)
  const operations = new OperationJournal(store, events)
  return { events, operations, redact: store.redact, close: () => store.close() }
}
