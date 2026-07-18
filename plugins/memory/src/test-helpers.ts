import { Surreal } from 'surrealdb'

// single source for test connection defaults — env-overridable, matching orc's own config
// (see packages/kernel/src/config.ts's projectDb* fields); literals appear exactly once here.
const URL = process.env.ORC_PROJECT_DB_URL ?? 'ws://127.0.0.1:8000/rpc'
const NS = process.env.ORC_PROJECT_DB_NAMESPACE ?? 'orc'
const USERNAME = process.env.ORC_PROJECT_DB_USER ?? 'root'
const PASSWORD = process.env.ORC_PROJECT_DB_PASSWORD ?? 'orc'

export async function createTestSurreal(): Promise<{
  url: string; ns: string; db: string; username: string; password: string; drop: () => Promise<void>
}> {
  const db = `t_${Math.random().toString(36).slice(2, 10)}`
  return {
    url: URL, ns: NS, db, username: USERNAME, password: PASSWORD,
    drop: async () => {
      const s = new Surreal()
      await s.connect(URL)
      await s.signin({ username: USERNAME, password: PASSWORD })
      // `use()` selects only the namespace (no database) — verified live against SurrealDB
      // v3.2.0 that `REMOVE DATABASE IF EXISTS type::database($db)` is not a valid function path
      // (a parse ValidationError, previously swallowed by a bare .catch here, which silently
      // left ~80 throwaway `t_*` dbs behind). The working shape inlines the db name directly;
      // safe because `db` is generated above from `[a-z0-9]` only, never external input.
      await s.use({ namespace: NS })
      // createMemory derives `${db}_<projectSuffix>` from this base name — remove those too.
      // INFO FOR NS lists databases; names are internally generated, never external input.
      const [info] = await s.query<[{ databases: Record<string, unknown> }]>('INFO FOR NS;')
      const derived = Object.keys(info?.databases ?? {}).filter(name => name.startsWith(`${db}_`))
      for (const name of [db, ...derived])
        await s.query(`REMOVE DATABASE IF EXISTS \`${name}\`;`).catch(() => {})
      await s.close()
    },
  }
}
