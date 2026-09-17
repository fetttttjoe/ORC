import pg from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { errorMessage } from '@orc/contracts'
import { buildRedactor, type Redactor } from '../redact'
import { assertMigrated } from './migrate'
import { pgListen } from './pg-listen'

export type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0]

// The shared append wake-up channel — owned here (the Postgres owner) so EventLog.subscribe and
// watchProjectIds speak through one declaration, never two literals.
export const NOTIFY_CHANNEL = 'orc_events'

// A reconnect that can NEVER succeed, so retrying it is a leak rather than resilience.
//   3D000 invalid_catalog_name — the database is gone. It is not coming back: a dropped project
//     database, or a test database dropped while a subscription was still live.
//   28P01/28000 — the credentials are wrong. A retry loop cannot fix a password.
// Left running, these spin at the 3s backoff ceiling forever, logging on every attempt. Measured on
// CI: one test file dropped its database and the orphaned loop then logged into every LATER file's
// output, which is the same "poisons every later test file" shape unconditional teardown exists to
// prevent — except here the noise also buries the failures a reader is looking for.
const TERMINAL_PG_CODES = new Set(['3D000', '28P01', '28000'])
export const isGonePermanently = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && 'code' in err
  && typeof (err as { code: unknown }).code === 'string'
  && TERMINAL_PG_CODES.has((err as { code: string }).code)

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
    // Sized deliberately, not left at node-postgres's generic default of 10. Every writer here
    // serializes on ONE per-project advisory lock (withProjectLock), so connections beyond a
    // couple cannot buy write throughput — they only reserve server slots. Reads are short.
    //
    // The default cost real failures: a store that had ten concurrent queries kept ten idle
    // connections for the default ten seconds, so sequential test files stacked their idle pools
    // on top of each other and, with a live supervisor also holding one, the suite exhausted
    // Postgres' 100-connection default and failed with `sorry, too many clients already` —
    // tests that pass in isolation. Four is headroom for concurrent reads plus a transaction plus
    // a spare; the short idle timeout returns slots quickly instead of hoarding them.
    const pool = new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 2_000 })
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
// no NOTIFY; the layer above pushes those changes through its own channel. Reconnects with the
// same bounded backoff as EventLog.subscribe and re-queries on every reconnect, so a dropped
// LISTEN delays a membership change but never loses it.
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
