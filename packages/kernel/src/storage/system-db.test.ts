import { afterAll, describe, expect, it } from 'bun:test'
import pg from 'pg'
import { createTestDb } from '../test-helpers'
import { deriveSystemUrl } from '../config'
import { dropSystemDatabase, resetSystemDatabase } from './system-db'

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

describe('dropSystemDatabase', () => {
  it('removes the database itself, so a deleted project leaves nothing behind', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const sysUrl = deriveSystemUrl(db.url, 'deleted-project')
    const name = decodeURIComponent(new URL(sysUrl).pathname.slice(1))
    const adminUrl = new URL(db.url)
    adminUrl.pathname = '/postgres'
    const admin = new pg.Client({ connectionString: adminUrl.toString() })
    await admin.connect()
    try {
      await admin.query(`create database "${name}"`)

      expect(await dropSystemDatabase(sysUrl)).toBe('dropped')
      // the point of the drop over a truncate: the database OBJECT is gone, not just its rows
      const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name])
      expect(rowCount).toBe(0)

      // dropping what is already gone is the normal case on a second delete, not an error
      expect(await dropSystemDatabase(sysUrl)).toBe('absent')
    } finally {
      await admin.query(`drop database if exists "${name}" with (force)`).catch(() => {})
      await admin.end()
    }
  })
})
