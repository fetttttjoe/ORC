import pg from 'pg'
import { PG_CONNECT_OPTIONS } from './postgres'

// FORCE evicts attached connections; DROP cannot run inside the database it removes
export async function dropSystemDatabase(url: string): Promise<'dropped' | 'absent'> {
  const name = decodeURIComponent(new URL(url).pathname.slice(1))
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString(), ...PG_CONNECT_OPTIONS })
  await client.connect()
  try {
    // existence decides the return and guards the interpolation: Postgres confirmed the name
    const { rows } = await client.query<{ datname: string }>('select datname from pg_database where datname = $1', [name])
    const found = rows[0]?.datname
    if (found === undefined) return 'absent'
    await client.query(`drop database "${found.replaceAll('"', '""')}" with (force)`)
    return 'dropped'
  } finally {
    await client.end()
  }
}

// truncating under a live workflow kills it mid-step; accepted for a reset tool
export async function resetSystemDatabase(url: string): Promise<'reset' | 'absent'> {
  const client = new pg.Client({ connectionString: url, ...PG_CONNECT_OPTIONS })
  try {
    await client.connect()
  } catch (err) {
    if ((err as { code?: string }).code === '3D000') return 'absent' // invalid_catalog_name
    throw err
  }
  try {
    const { rows } = await client.query<{ s: string; t: string }>(
      `select table_schema as s, table_name as t from information_schema.tables
       where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`,
    )
    if (rows.length > 0) // identifiers come from the catalog, not user input
      await client.query(`truncate table ${rows.map(r => `"${r.s}"."${r.t}"`).join(', ')} cascade`)
    return 'reset'
  } finally {
    await client.end()
  }
}
