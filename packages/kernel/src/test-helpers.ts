import { Client } from 'pg'
import type { ModelProvider } from '@orc/contracts'
import { loadConfig, requireProject, type ProjectConfig } from './config'
import { migrateDatabase } from './storage/migrate'

const ADMIN_URL = process.env.ORC_DATABASE_URL ?? 'postgresql://postgres:orc@localhost:5433/orc'

// shared by the port integration test and the kill-9 resume fixture — one shape to drift
export const fakeProvider: ModelProvider<unknown> = { costs: {}, languageModel: () => ({}) }

export const TEST_PROJECT_ID = '00000000-0000-4000-8000-000000000001'

// the ONE test config builder — every integration test binds the same project identity
// and gets the correctly derived DBOS system url for its throwaway database
export function testConfig(databaseUrl: string, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return requireProject({
    ...loadConfig(),
    databaseUrl,
    projectId: TEST_PROJECT_ID,
    projectName: 'test',
    ...overrides,
  })
}

export interface TestDb {
  url: string
  /**
   * Register a resource to close BEFORE the database is dropped. Runs LIFO, and a throwing
   * closer never masks the test's own failure.
   */
  onClose(fn: () => Promise<void> | void): void
  drop(): Promise<void>
}

// ponytail: test-only helper; ephemeral DB per test file, dropped after.
// migrate defaults on; the migration test opts out to stage a partial schema itself.
//
// The handle owns teardown ORDER, because it is the only thing that knows when the database is
// about to disappear. A caller that opens a pool/LISTEN client against `url` and does not
// register it leaves live backends at drop time, and `DROP DATABASE ... WITH (FORCE)` then
// terminates them — which is where "terminating connection due to administrator command" and
// "event stream reconnect failed: database does not exist" come from. FORCE is the backstop for
// a genuinely wedged backend, not the mechanism for routine teardown.
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  const name = `orc_test_${Math.random().toString(36).slice(2, 10)}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  if (opts.migrate !== false) await migrateDatabase(url.toString()) // schema setup is explicit — open() only verifies
  const closers: (() => Promise<void> | void)[] = []
  return {
    url: url.toString(),
    onClose: fn => { closers.push(fn) },
    drop: async () => {
      // LIFO: a port shuts down before the storage it appends through, which closes before the
      // database goes away. Swallowed because teardown must not overwrite a real failure.
      for (const close of closers.reverse()) {
        try { await close() } catch { /* already-closed or mid-failure teardown */ }
      }
      // also drop every per-project DBOS system DB a port test may have auto-created
      const derived = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${name}_dbos_%`])
      for (const row of derived.rows) {
        if (!/^[a-z0-9_]+$/.test(row.datname)) throw new Error(`unexpected database name: ${row.datname}`)
        await admin.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`)
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
  }
}
