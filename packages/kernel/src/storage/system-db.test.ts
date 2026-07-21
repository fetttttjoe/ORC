import { afterAll, describe, expect, it } from 'bun:test'
import pg from 'pg'
import { createTestDb } from '../test-helpers'
import { deriveSystemUrl } from '../config'
import { resetSystemDatabase } from './system-db'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

describe('resetSystemDatabase', () => {
  it('truncates every table when the database exists; reports absent when it never did', async () => {
    const db = await createTestDb()
    dbs.push(db)
    // treat the test database as a stand-in system db: seed a table with a row
    const c = new pg.Client({ connectionString: db.url })
    await c.connect()
    await c.query('create table pending_workflows (id text primary key)')
    await c.query("insert into pending_workflows values ('w1')")
    await c.end()

    expect(await resetSystemDatabase(db.url)).toBe('reset')

    const check = new pg.Client({ connectionString: db.url })
    await check.connect()
    const { rows } = await check.query('select count(*)::int as n from pending_workflows')
    await check.end()
    expect(rows[0].n).toBe(0) // rows gone, schema intact

    // a project that never ran has no system database — that is data, not an error
    expect(await resetSystemDatabase(deriveSystemUrl(db.url, 'never-ran-project'))).toBe('absent')
  })
})
