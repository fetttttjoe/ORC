import { PostgresStore } from './postgres'
import { EventLog } from './event-log'
import { OperationJournal } from './operation-journal'

export { PostgresStore, type Tx } from './postgres'
export { EventLog, type EventLogOps } from './event-log'
export { OperationJournal, type OperationContext } from './operation-journal'
export { assertMigrated, migrateDatabase } from './migrate'

// Postgres facade: callers use `events`/`operations`, never pools/locks/migrations.
export interface Storage {
  events: EventLog
  operations: OperationJournal
  close(): Promise<void>
}

export async function openStorage(url: string, opts: { projectId: string; redactEnv?: string[] }): Promise<Storage> {
  const store = await PostgresStore.open(url, opts)
  const events = new EventLog(store)
  const operations = new OperationJournal(store, events)
  return { events, operations, close: () => store.close() }
}
