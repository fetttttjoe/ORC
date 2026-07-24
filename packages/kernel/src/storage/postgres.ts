import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { errorMessage } from '@orc/contracts'
import { buildRedactor, type Redactor } from '../redact'
import { assertMigrated } from './migrate'

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

// The shared append wake-up channel and listener backoff — owned here (the Postgres owner)
// so EventLog.subscribe and watchProjectIds speak through one declaration, never two literals.
export const NOTIFY_CHANNEL = 'orc_events'
export const RECONNECT_DELAYS_MS = [100, 200, 400, 800, 1600, 3000]

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
      await assertMigrated(db, url)
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

// Cross-project discovery for read-only viewers. Deliberately outside PostgresStore, which is
// bound to ONE project by design. Ordered by most recent activity.
export async function listProjectIds(url: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  try {
    const r = await pool.query<{ project_id: string }>(
      'SELECT project_id, MAX(seq) AS last FROM events GROUP BY project_id ORDER BY last DESC',
    )
    return r.rows.map(row => row.project_id)
  } finally {
    await pool.end()
  }
}

// Push complement of listProjectIds, for viewers that render the chats list live. The shared
// orc_events NOTIFY is only a wake-up (its payload is a seq, project unknown): the authoritative
// re-query happens here, debounced so an append burst costs one query. Emits the fresh id list
// on EVERY wake — subscribers own change detection, because names resolve above this layer and
// a rename wakes without changing membership. Row-DELETING operations (project deletion) send
// no NOTIFY; callers with such a path invoke refresh() explicitly. Reconnects with the same
// bounded backoff as EventLog.subscribe and re-queries on every reconnect, so a dropped LISTEN
// delays a membership change but never loses it.
export interface ProjectIdsWatch {
  refresh(): Promise<void>
  close(): Promise<void>
}

const WATCH_DEBOUNCE_MS = 150

export async function watchProjectIds(url: string, onWake: (ids: string[]) => void): Promise<ProjectIdsWatch> {
  let closed = false
  let client: pg.Client | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff = 0

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
  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return
    const delay = RECONNECT_DELAYS_MS[Math.min(backoff, RECONNECT_DELAYS_MS.length - 1)]!
    backoff += 1
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(false) }, delay)
  }
  const connect = async (initial: boolean): Promise<void> => {
    if (closed) return
    const c = new pg.Client({ connectionString: url, application_name: 'orc-project-watch' })
    // same rule as EventLog.subscribe: an 'error' event with no listener crashes the process,
    // and a closed watch has nothing left worth reporting
    c.on('error', err => { if (!closed) console.warn(`project watch listener error: ${errorMessage(err)}`) })
    try {
      await c.connect()
      await c.query(`LISTEN ${NOTIFY_CHANNEL}`)
      // the disposer may have run during the awaits — don't adopt a client it can't see
      if (closed) { await c.end().catch(() => {}); return }
      client = c
      c.on('notification', wake)
      c.once('end', () => { if (!closed) scheduleReconnect() })
      backoff = 0
      wake() // catch up on anything that landed while (re)connecting
    } catch (err) {
      await c.end().catch(() => {})
      if (initial) throw err
      console.warn(`project watch reconnect failed: ${errorMessage(err)}`)
      scheduleReconnect()
    }
  }
  await connect(true)
  return {
    refresh,
    async close() {
      closed = true
      if (debounce) clearTimeout(debounce)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      await client?.end().catch(() => {})
    },
  }
}
