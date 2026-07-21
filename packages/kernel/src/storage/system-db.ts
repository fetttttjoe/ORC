import pg from 'pg'

// Reset a project's DBOS system database by truncating every table — pending workflows
// vanish, so nothing gets recovered into a purged event log. Plain SQL on the project-suffixed
// database: no DBOS launch (launching would START recovery — the exact storm this avoids).
// 'absent' = the database was never created (no run ever happened); schema stays intact for
// an already-launched runtime in this process.
// ponytail: truncate-under-a-live-workflow kills it mid-step; purge is a test-reset tool and
// accepts that — a coordinated drain would need the runtime we deliberately avoid.
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
