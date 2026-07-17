import { Client } from 'pg'

const ADMIN_URL = process.env.ORC_DATABASE_URL ?? 'postgresql://postgres:orc@localhost:5433/orc'

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
      // also drop the DBOS system DB a port test may have auto-created
      await admin.query(`DROP DATABASE IF EXISTS ${name}_dbos_sys WITH (FORCE)`)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
  }
}
