import pg from 'pg'

// One execution runtime per project, enforced rather than assumed. DBOS recovers PENDING workflows
// for its executor at launch, so a second runtime does not queue behind the first — it re-executes
// the same step as a new attempt, and the operation journal fences the loser into a step_failed
// that blocks a healthy task. Observed live: `orc reply` launched a runtime while `orc graph` held
// one, both drove the analyze step, and the run died one second later.
//
// Session-scoped (`pg_try_advisory_lock`, not the `_xact_` variant the append path uses): held for
// the runtime's life on a dedicated connection, so it is released by a crash as well as a clean
// shutdown — which a lease row in a table would not be.
export interface RuntimeLock { release(): Promise<void> }

// distinct from the append lock, which hashes the bare projectId
const runtimeLockKey = (projectId: string): string => `orc:execution-runtime:${projectId}`

export class RuntimeBusyError extends Error {
  constructor(readonly projectId: string) {
    super(`another orc execution runtime is already driving this project (${projectId}) — stop it (typically the 'orc graph' server) and retry, or drive the run from there`)
    this.name = 'RuntimeBusyError'
  }
}

// Is a runtime holding the lock RIGHT NOW — asked without taking it. Read from pg_locks rather
// than probed with pg_try_advisory_lock: a try-then-release cannot evict the holder, but on a
// polled path (health asks every 3s) it would make a legitimate acquirer fail spuriously in the
// window it is held. Advisory keys live in pg_locks as classid/objid — the high and low 32 bits of
// the bigint key, objsubid 1 for the single-bigint form.
//
// Answers a DIFFERENT question from the supervisor heartbeat: that row says "a supervisor is
// beating", this says "something is driving" — which may be a supervisor, a `--no-daemon` command,
// or the graph server. The banner claimed "nothing will run" on the absence of the first alone,
// while a --no-daemon task was running.
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
