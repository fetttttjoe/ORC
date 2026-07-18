import { Client } from 'pg'
import type { ModelProvider } from '@orc/contracts'
import { loadConfig, requireProject, type ProjectConfig } from './config'

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

// ponytail: test-only helper; ephemeral DB per test file, dropped after
export async function createTestDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  const name = `orc_test_${Math.random().toString(36).slice(2, 10)}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
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
