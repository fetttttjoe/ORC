import { Client } from 'pg'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { EVENT_KIND, WORKSPACE_KIND, type LoadedSkill, type ModelProvider, type Origin, type Workspace } from '@orc/contracts'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { loadConfig, requireProject, type OrcConfig, type ProjectConfig } from './config'
import type { EventLogOps } from './storage'
import { migrateDatabase } from './storage/migrate'
import { staleTestDbs, testDbName } from './stale-test-dbs'

export { STALE_TEST_DB_MS, staleTestDbs, testDbName } from './stale-test-dbs'

const ADMIN_URL = process.env.ORC_DATABASE_URL ?? 'postgresql://postgres:orc@localhost:5433/orc'

// shared by the port integration test and the kill-9 resume fixture — one shape to drift
export const fakeProvider: ModelProvider<unknown> = { costs: {}, languageModel: () => ({}) }

// a port with no skill index fails the finish step's init; loads any name
export const fakeSkills: { load(name: string): Promise<LoadedSkill> } = {
  load: async (name: string) => ({ name, body: `body of ${name}`, hash: `hash-${name}` }),
}

export const TEST_PROJECT_ID = '00000000-0000-4000-8000-000000000001'

// a fixed uuid so hand-built TaskNode fixtures can name the seeded workspace
export { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
export const TEST_WORKSPACE: Workspace = {
  id: TEST_WORKSPACE_ID, title: 'test', cwd: '/test/workspace', branch: 'main', baseBranch: null,
  kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: true,
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
}

// callers must pass a REALPATH: doors resolve theirs, and the fold matches the string exactly
export async function seedTestWorkspace(log: Pick<EventLogOps, 'append'>, origin: Origin, cwd: string = TEST_WORKSPACE.cwd): Promise<void> {
  await log.append({
    ...origin, taskId: null, stepId: null, runToken: null,
    kind: EVENT_KIND.workspace_created, payload: { workspace: { ...TEST_WORKSPACE, cwd } },
  })
}

export function testConfig(databaseUrl: string, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return requireProject({
    ...loadConfig(),
    databaseUrl,
    projectId: TEST_PROJECT_ID,
    projectName: 'test',
    ...overrides,
  })
}

// schema defaults only: an explicit dir skips loadConfig's walk-up, and the dir never exists
export function testOrcConfig(overrides: Partial<OrcConfig> = {}): OrcConfig {
  const dir = path.join(tmpdir(), `orc-hermetic-config-${Math.random().toString(36).slice(2, 10)}`)
  return { ...loadConfig(dir), ...overrides }
}

// the ONE polling loop for router and port assertions
export const waitFor = async (pred: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await pred()) return true; await Bun.sleep(50) }
  return false
}

export interface TestDb {
  url: string
  // closes BEFORE the database is dropped, LIFO; a throwing closer never masks the test failure
  onClose(fn: () => Promise<void> | void): void
  drop(): Promise<void>
}

// the handle owns teardown ORDER: FORCE is a backstop for a wedged backend, not routine teardown
async function withAdmin<T>(fn: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  try { return await fn(admin) } finally { await admin.end() }
}

const TEST_DB_PREFIX = 'orc_test_'
const DbNameRow = z.object({ datname: z.string() })

// a live backend marks a running test's database; the age rule alone decides the rest
async function sweepStaleTestDbs(admin: Client): Promise<void> {
  const all = DbNameRow.array().parse(
    (await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${TEST_DB_PREFIX}%`])).rows,
  )
  const active = DbNameRow.array().parse(
    (await admin.query('SELECT DISTINCT datname FROM pg_stat_activity WHERE datname IS NOT NULL')).rows,
  )
  const activeNames = new Set(active.map(r => r.datname))
  const candidates = all.map(r => r.datname).filter(name => !activeNames.has(name))
  for (const name of staleTestDbs(candidates, TEST_DB_PREFIX, Date.now())) {
    try {
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unexpected database name: ${name}`)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    } catch { /* best-effort: a failing sweep must never fail the test that triggered it */ }
  }
}

export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const name = testDbName(TEST_DB_PREFIX, Date.now(), Math.random().toString(36).slice(2, 10))
  await withAdmin(async admin => {
    await sweepStaleTestDbs(admin)
    await admin.query(`CREATE DATABASE ${name}`)
  })
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  if (opts.migrate !== false) await migrateDatabase(url.toString()) // schema setup is explicit — open() only verifies
  const closers: (() => Promise<void> | void)[] = []
  return {
    url: url.toString(),
    onClose: fn => { closers.push(fn) },
    drop: async () => {
      // LIFO teardown, errors swallowed: it must not overwrite a real failure
      for (const close of closers.reverse()) {
        try { await close() } catch { /* already-closed or mid-failure teardown */ }
      }
      // also drop every per-project DBOS system DB a port test may have auto-created
      await withAdmin(async admin => {
        const derived = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${name}_dbos_%`])
        for (const row of derived.rows) {
          if (!/^[a-z0-9_]+$/.test(row.datname)) throw new Error(`unexpected database name: ${row.datname}`)
          await admin.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`)
        }
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      })
    },
  }
}

// runs real git: this suite tests the shape of git's output; a failed call throws with stderr
export const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr))
  return new TextDecoder().decode(r.stdout).trim()
}

// a main checkout plus one linked worktree for tests of --git-dir / --git-common-dir
export function tmpGitRepo(): { main: string; worktree: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orc-git-'))
  const main = path.join(root, 'main')
  sh(root, 'init', '-q', '-b', 'main', main)
  sh(main, 'config', 'user.email', 't@t')
  sh(main, 'config', 'user.name', 't')
  writeFileSync(path.join(main, 'README'), 'x\n')
  sh(main, 'add', 'README')
  sh(main, 'commit', '-q', '-m', 'init')
  const worktree = path.join(root, 'wt')
  sh(main, 'worktree', 'add', '-q', '-b', 'feature', worktree)
  return { main, worktree }
}
