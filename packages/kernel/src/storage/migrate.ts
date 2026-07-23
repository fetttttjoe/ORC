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

function isMissingMigrationTable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; cause?: unknown; errors?: unknown[] }
  if (value.code === '42P01' || value.code === '3F000') return true
  return isMissingMigrationTable(value.cause) || (value.errors ?? []).some(isMissingMigrationTable)
}

// credential-free database identity for error messages — WHICH database was checked is the
// first thing a "schema is behind" report needs (a wrong cwd resolves to a different database
// and the bare message reads like corruption)
const where = (url?: string): string => {
  if (!url) return ''
  try {
    const u = new URL(url)
    u.password = ''
    return ` (checked ${u.host}${u.pathname})`
  } catch {
    return ''
  }
}

// reads drizzle's bookkeeping table; fails loudly when the database is behind
export async function assertMigrated(db: NodePgDatabase, url?: string): Promise<void> {
  const expected = journalEntryCount()
  let applied: number
  try {
    const result = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
    const first = result.rows[0]
    applied = first && typeof first.n === 'number' ? first.n : 0
  } catch (error) {
    if (!isMissingMigrationTable(error)) throw error
    applied = 0
  }
  if (applied < expected)
    throw new Error(
      `database schema is behind (${applied}/${expected} migrations applied)${where(url)} — run 'orc db migrate'`,
    )
}
