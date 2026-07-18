import { Surreal } from 'surrealdb'

const URL = process.env.ORC_PROJECT_DB_URL ?? 'ws://127.0.0.1:8000/rpc'

export async function createTestSurreal(): Promise<{ url: string; ns: string; db: string; drop: () => Promise<void> }> {
  const ns = 'orc'
  const db = `t_${Math.random().toString(36).slice(2, 10)}`
  return {
    url: URL, ns, db,
    drop: async () => {
      const s = new Surreal()
      await s.connect(URL)
      await s.signin({ username: 'root', password: 'orc' })
      await s.use({ namespace: ns, database: db })
      await s.query('REMOVE DATABASE IF EXISTS type::database($db)', { db }).catch(() => {})
      await s.close()
    },
  }
}
