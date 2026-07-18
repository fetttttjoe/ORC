import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'

// schema changes are a deliberate act (orc db migrate / test setup), never an open()
// side effect; only this module knows where the committed SQL lives
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url))

const journalEntryCount = (): number => {
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'))
  return Array.isArray(journal.entries) ? journal.entries.length : 0
}

export async function migrateDatabase(url: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await pool.end()
  }
}

// reads drizzle's bookkeeping table; fails loudly when the database is behind
export async function assertMigrated(db: NodePgDatabase): Promise<void> {
  const expected = journalEntryCount()
  const applied = await db
    .execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
    .then(r => {
      const first = r.rows[0]
      return first && typeof first.n === 'number' ? first.n : 0
    })
    .catch(() => 0) // table absent → nothing applied
  if (applied < expected)
    throw new Error(
      `database schema is behind (${applied}/${expected} migrations applied) — run 'orc db migrate'`,
    )
}
