import { afterAll, describe, expect, it } from 'bun:test'
import { Surreal } from 'surrealdb'
import { STALE_TEST_DB_MS, testDbName } from '@orc/kernel/test-helpers'
import { createTestSurreal } from './test-helpers'

const rand = (): string => Math.random().toString(36).slice(2, 10)

const drops: (() => Promise<void>)[] = []
afterAll(async () => { await Promise.all(drops.map(d => d())) }, 30_000)

async function connect(seed: { url: string; ns: string; username: string; password: string }): Promise<Surreal> {
  const s = new Surreal()
  await s.connect(seed.url)
  await s.signin({ username: seed.username, password: seed.password })
  await s.use({ namespace: seed.ns })
  return s
}

async function materialize(admin: Surreal, ns: string, name: string): Promise<void> {
  await admin.use({ namespace: ns, database: name })
  await admin.query('DEFINE TABLE x SCHEMALESS; CREATE x SET a = 1;')
  await admin.use({ namespace: ns })
}

async function nsDatabaseNames(admin: Surreal): Promise<string[]> {
  const [info] = await admin.query<[{ databases: Record<string, unknown> }]>('INFO FOR NS;')
  return Object.keys(info?.databases ?? {})
}

describe('createTestSurreal stale sweep', () => {
  it('removes an old-format and a stale-timestamp t_* leftover on the next call, and keeps a same-instant one alive on freshness alone — Surreal has no activity table to also protect it', async () => {
    const seed = await createTestSurreal()
    drops.push(seed.drop)
    const admin = await connect(seed)
    try {
      const oldFormatLeftover = `t_${rand()}`
      const staleTimestampLeftover = testDbName('t_', Date.now() - (STALE_TEST_DB_MS + 60_000), rand())
      const freshSurvivor = testDbName('t_', Date.now(), rand())
      try {
        for (const name of [oldFormatLeftover, staleTimestampLeftover, freshSurvivor])
          await materialize(admin, seed.ns, name)

        const before = await nsDatabaseNames(admin)
        expect([oldFormatLeftover, staleTimestampLeftover, freshSurvivor].map(n => before.includes(n)))
          .toEqual([true, true, true])

        const swept = await createTestSurreal()
        drops.push(swept.drop)

        const after = await nsDatabaseNames(admin)
        expect([oldFormatLeftover, staleTimestampLeftover, freshSurvivor].map(n => after.includes(n)))
          .toEqual([false, false, true])
      } finally {
        await admin.query(`REMOVE DATABASE IF EXISTS \`${freshSurvivor}\`;`).catch(() => {})
      }
    } finally {
      await admin.close()
    }
  })
})
