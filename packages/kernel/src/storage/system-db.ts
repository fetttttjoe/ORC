import pg from 'pg'

// Reset a project's DBOS system database by truncating every table — pending workflows
// vanish, so nothing gets recovered into a purged event log. Plain SQL on the project-suffixed
// database: no DBOS launch (launching would START recovery — the exact storm this avoids).
// 'absent' = the database was never created (no run ever happened); schema stays intact for
// an already-launched runtime in this process.
// ponytail: truncate-under-a-live-workflow kills it mid-step; purge is a test-reset tool and
// accepts that — a coordinated drain would need the runtime we deliberately avoid.
// Deleting a project takes its durable-execution state WITH it — the database, not just the rows.
// Truncating is right for `purge`, which re-seeds identity and keeps the chat alive, but a DELETED
// project has no runtime left to hold a schema for: the emptied database object just sits there, and
// nothing ever collects it. Measured on a real machine: nine such shells at ~8MB each, for projects
// whose directories were long gone.
//
// DROP cannot run from inside the database it removes, so this connects to the server's default one.
// FORCE (Postgres 13+) evicts a connection still attached — the alternative is a drop that fails
// whenever a runtime is mid-shutdown, leaving behind exactly the dangling resource this exists to
// remove. 'absent' when there is nothing to drop, matching resetSystemDatabase: a project that never
// ran is data, not an error.
export async function dropSystemDatabase(url: string): Promise<'dropped' | 'absent'> {
  const name = decodeURIComponent(new URL(url).pathname.slice(1))
  const admin = new URL(url)
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  await client.connect()
  try {
    // existence decides the return value AND guards the interpolation below: the identifier is a
    // name Postgres itself just confirmed, not the caller's string
    const { rows } = await client.query<{ datname: string }>('select datname from pg_database where datname = $1', [name])
    const found = rows[0]?.datname
    if (found === undefined) return 'absent'
    await client.query(`drop database "${found.replaceAll('"', '""')}" with (force)`)
    return 'dropped'
  } finally {
    await client.end()
  }
}

export async function resetSystemDatabase(url: string): Promise<'reset' | 'absent'> {
  const client = new pg.Client({ connectionString: url })
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
