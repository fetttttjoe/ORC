import pg from 'pg'

// session-scoped, so a crash releases it too, which a lease row would not
export interface RuntimeLock { release(): Promise<void> }

// distinct from the append lock, which hashes the bare projectId
const runtimeLockKey = (projectId: string): string => `orc:execution-runtime:${projectId}`

export class RuntimeBusyError extends Error {
  constructor(readonly projectId: string) {
    super(`another orc execution runtime is already driving this project (${projectId}) — stop it (typically the 'orc graph' server) and retry, or drive the run from there`)
    this.name = 'RuntimeBusyError'
  }
}

// read from pg_locks: a try-then-release probe could fail a legitimate acquirer when polled
const RUNTIME_LOCK_HELD_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory' AND objsubid = 1
      AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::bigint::oid
      AND objid   = ( hashtextextended($1, 0)        & 4294967295)::bigint::oid
  ) AS held`

export async function runtimeLockHeld(url: string, projectId: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url })
  try {
    await client.connect()
    const r = await client.query<{ held: boolean }>(RUNTIME_LOCK_HELD_SQL, [runtimeLockKey(projectId)])
    return r.rows[0]?.held === true
  } catch {
    // advisory only: a probe that cannot reach Postgres must not claim the runtime is idle
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

export async function acquireRuntimeLock(url: string, projectId: string): Promise<RuntimeLock> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const r = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [runtimeLockKey(projectId)])
    if (r.rows[0]?.locked !== true) throw new RuntimeBusyError(projectId)
    return { release: async () => { await client.end() } }
  } catch (err) {
    await client.end().catch(() => {})
    throw err
  }
}
