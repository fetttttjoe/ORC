import pg from 'pg'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { errorMessage } from '@orc/contracts'
import { buildRedactor, type Redactor } from '../redact'
import { assertMigrated } from './migrate'
import { pgListen } from './pg-listen'

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

export const NOTIFY_CHANNEL = 'orc_events'

// a dead or unreachable Postgres must fail fast, not hang every caller for the OS default
export const CONNECT_TIMEOUT_MS = 3_000
export const PG_CONNECT_OPTIONS = { connectionTimeoutMillis: CONNECT_TIMEOUT_MS }

// reconnects that can never succeed (database gone, credentials wrong): retrying only leaks
export const TERMINAL_PG_CODES = new Set(['3D000', '28P01', '28000'])
const pgErrorCode = z.object({ code: z.string() })
export const isGonePermanently = (err: unknown): boolean => {
  const parsed = pgErrorCode.safeParse(err)
  return parsed.success && TERMINAL_PG_CODES.has(parsed.data.code)
}

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
    // max 4: writers serialize on one advisory lock, and idle pools stacked past 100 server slots
    const pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 2_000, ...PG_CONNECT_OPTIONS })
    const db = drizzle(pool)
    try {
      await assertMigrated(db, url)
    } catch (err) {
      await pool.end()
      throw err
    }
    return new PostgresStore(pool, db, url, opts.projectId, buildRedactor(process.env, opts.redactEnv ?? []))
  }

  // READ COMMITTED lets check-then-append interleave (write skew); the lock serializes writers
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

// not on PostgresStore, which is bound to one project; ordered by recent activity
export async function listProjectIds(url: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1, ...PG_CONNECT_OPTIONS })
  try {
    const r = await pool.query<{ project_id: string }>(
      'SELECT project_id, MAX(seq) AS last FROM events GROUP BY project_id ORDER BY last DESC',
    )
    return r.rows.map(row => row.project_id)
  } finally {
    await pool.end()
  }
}

// emits on every wake: a rename changes names, not membership; deletes send no NOTIFY
export interface ProjectIdsWatch {
  close(): Promise<void>
}

const WATCH_DEBOUNCE_MS = 150

export async function watchProjectIds(url: string, onWake: (ids: string[]) => void): Promise<ProjectIdsWatch> {
  let closed = false
  let debounce: ReturnType<typeof setTimeout> | null = null

  const refresh = async (): Promise<void> => {
    if (closed) return
    onWake(await listProjectIds(url))
  }
  const wake = (): void => {
    if (closed || debounce !== null) return
    debounce = setTimeout(() => {
      debounce = null
      void refresh().catch(err => console.warn(`project watch refresh failed: ${errorMessage(err)}`))
    }, WATCH_DEBOUNCE_MS)
  }

  const listener = await pgListen({
    url,
    applicationName: 'orc-project-watch',
    channel: NOTIFY_CHANNEL,
    onNotification: () => wake(),
    onConnected: () => wake(), // catch up on anything that landed while (re)connecting
    isGonePermanently,
    onStopped: () => {
      closed = true
      if (debounce) { clearTimeout(debounce); debounce = null }
    },
    warn: msg => console.warn(`project watch ${msg}`),
  })
  return {
    async close() {
      closed = true
      if (debounce) clearTimeout(debounce)
      await listener.close()
    },
  }
}
