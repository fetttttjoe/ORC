import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { buildRedactor, type Redactor } from '../redact'
import { assertMigrated } from './migrate'

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

// The one Postgres owner: pool, project binding, redaction, write serialization.
export class PostgresStore {
  private constructor(
    private readonly pool: pg.Pool,
    readonly db: NodePgDatabase,
    readonly url: string,
    readonly projectId: string,
    readonly redact: Redactor,
  ) {}

  // verifies the schema instead of migrating — migration is an explicit step
  static async open(url: string, opts: { projectId: string; redactEnv?: string[] }): Promise<PostgresStore> {
    const pool = new pg.Pool({ connectionString: url })
    const db = drizzle(pool)
    try {
      await assertMigrated(db)
    } catch (err) {
      await pool.end()
      throw err
    }
    return new PostgresStore(pool, db, url, opts.projectId, buildRedactor(process.env, opts.redactEnv ?? []))
  }

  // READ COMMITTED lets check-then-append transactions interleave (write skew); the
  // per-project advisory lock serializes writers, unrelated projects stay concurrent.
  // ponytail: one lock per project — per-task locks if writer throughput matters
  withProjectLock<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${this.projectId}, 0))`)
      return fn(tx)
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
