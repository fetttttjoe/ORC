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
