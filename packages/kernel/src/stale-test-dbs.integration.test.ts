import { afterAll, describe, expect, it } from 'bun:test'
import pg from 'pg'
import { createTestDb, STALE_TEST_DB_MS, testDbName, type TestDb } from './test-helpers'

const dbs: TestDb[] = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

const rand = (): string => Math.random().toString(36).slice(2, 10)

async function adminFor(url: string): Promise<pg.Client> {
  const adminUrl = new URL(url)
  adminUrl.pathname = '/postgres'
  const c = new pg.Client({ connectionString: adminUrl.toString() })
  await c.connect()
  return c
}

async function exists(admin: pg.Client, name: string): Promise<boolean> {
  const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name])
  return (rowCount ?? 0) > 0
}

// one pg.Client serializes its queries; a Promise.all of several here just races them on the
// same connection and pg logs a deprecation warning for it
async function existsAll(admin: pg.Client, names: readonly string[]): Promise<boolean[]> {
  const out: boolean[] = []
  for (const name of names) out.push(await exists(admin, name))
  return out
}

describe('createTestDb stale sweep', () => {
  it('drops an old-format leftover and a stale-timestamp leftover, keeping a fresh one, on the next createTestDb call', async () => {
    const anchor = await createTestDb({ migrate: false })
    dbs.push(anchor)
    const admin = await adminFor(anchor.url)
    try {
      const oldFormatLeftover = `orc_test_${rand()}`
      const staleTimestampLeftover = testDbName('orc_test_', Date.now() - (STALE_TEST_DB_MS + 60_000), rand())
      const freshSurvivor = testDbName('orc_test_', Date.now(), rand())
      try {
        for (const name of [oldFormatLeftover, staleTimestampLeftover, freshSurvivor])
          await admin.query(`CREATE DATABASE ${name}`)

        expect(await existsAll(admin, [oldFormatLeftover, staleTimestampLeftover, freshSurvivor]))
          .toEqual([true, true, true])

        const swept = await createTestDb({ migrate: false })
        dbs.push(swept)

        expect(await existsAll(admin, [oldFormatLeftover, staleTimestampLeftover, freshSurvivor]))
          .toEqual([false, false, true])
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${freshSurvivor} WITH (FORCE)`).catch(() => {})
      }
    } finally {
      await admin.end()
    }
  })

  it('never drops a stale-timestamp database that still has a live backend connected', async () => {
    const anchor = await createTestDb({ migrate: false })
    dbs.push(anchor)
    const admin = await adminFor(anchor.url)
    const staleButConnected = testDbName('orc_test_', Date.now() - (STALE_TEST_DB_MS + 60_000), rand())
    let liveBackend: pg.Client | undefined
    try {
      await admin.query(`CREATE DATABASE ${staleButConnected}`)
      const liveUrl = new URL(anchor.url)
      liveUrl.pathname = `/${staleButConnected}`
      liveBackend = new pg.Client({ connectionString: liveUrl.toString() })
      await liveBackend.connect()

      const swept = await createTestDb({ migrate: false })
      dbs.push(swept)

      expect(await exists(admin, staleButConnected)).toBe(true)
    } finally {
      await liveBackend?.end()
      await admin.query(`DROP DATABASE IF EXISTS ${staleButConnected} WITH (FORCE)`).catch(() => {})
      await admin.end()
    }
  })
})
