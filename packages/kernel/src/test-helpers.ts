import { Client } from 'pg'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND, WORKSPACE_KIND, type ModelProvider, type Workspace } from '@orc/contracts'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { loadConfig, requireProject, type ProjectConfig } from './config'
import type { EventLogOps } from './storage'
import { migrateDatabase } from './storage/migrate'

const ADMIN_URL = process.env.ORC_DATABASE_URL ?? 'postgresql://postgres:orc@localhost:5433/orc'

// shared by the port integration test and the kill-9 resume fixture — one shape to drift
export const fakeProvider: ModelProvider<unknown> = { costs: {}, languageModel: () => ({}) }

export const TEST_PROJECT_ID = '00000000-0000-4000-8000-000000000001'

// TaskNode.workspaceId is REQUIRED, and createTask refuses an id the fold has never seen — so every
// kernel-backed test needs one workspace on the log before it can create a task. A fixed id (not a
// randomUUID) so a hand-built TaskNode literal in a fixture can name the same workspace without
// plumbing a value through. Workspace.id is z.uuid(), which is why this is a uuid and not 'test-ws'.
//
// Defined in @orc/contracts/fixtures and re-exported here rather than spelled twice: contracts is
// the bottom of the dependency graph and its own tests need the id too (MemoryAuthor.workspaceId is
// required on every author), and two copies of one uuid is the literal-drift this repo keeps out.
export { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
export const TEST_WORKSPACE: Workspace = {
  id: TEST_WORKSPACE_ID, title: 'test', cwd: '/test/workspace', branch: 'main', baseBranch: null,
  kind: WORKSPACE_KIND.checkout, managed: false, onTrunk: true,
  createdAt: '2026-01-01T00:00:00.000Z', archivedAt: null,
}

// Appends the one workspace_created every kernel-backed test needs before createTask can succeed.
// Through the LOG, not kernel.ensureWorkspace: a test that seeds through the kernel would get a
// random id its fixtures cannot name, and several helpers here hold a log before a kernel exists.
//
// `cwd` overrides where that workspace lives, and a test driving a CLI/MCP/reactor door has to pass
// it. Those doors answer "which workspace am I writing from?" by matching their config.dir against
// this cwd EXACTLY (cwd-workspace.ts realpaths first), and a MemoryAuthor that cannot name a
// workspace is refused rather than defaulted — so a harness whose config.dir is a throwaway tmp
// directory gets "no workspace for this directory" from every memory write until it seeds here.
// CALLERS MUST PASS A REALPATH: a tmp dir is commonly a symlink, the doors resolve theirs before
// asking, and the fold matches the resolved string exactly — an unresolved spelling seeds a
// workspace nothing will ever find.
export async function seedTestWorkspace(log: Pick<EventLogOps, 'append'>, cwd: string = TEST_WORKSPACE.cwd): Promise<void> {
  await log.append({
    taskId: null, stepId: null, runToken: null,
    kind: EVENT_KIND.workspace_created, payload: { workspace: { ...TEST_WORKSPACE, cwd } },
  })
}

// the ONE test config builder — every integration test binds the same project identity
// and gets the correctly derived DBOS system url for its throwaway database
export function testConfig(databaseUrl: string, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return requireProject({
    ...loadConfig(),
    databaseUrl,
    projectId: TEST_PROJECT_ID,
    projectName: 'test',
    ...overrides,
  })
}

// the ONE polling loop for "the router/port will get there soon" assertions — five test files
// each carried their own copy of this exact shape before it was hoisted
export const waitFor = async (pred: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
  const start = Date.now()
  while (Date.now() - start < ms) { if (await pred()) return true; await Bun.sleep(50) }
  return false
}

export interface TestDb {
  url: string
  /**
   * Register a resource to close BEFORE the database is dropped. Runs LIFO, and a throwing
   * closer never masks the test's own failure.
   */
  onClose(fn: () => Promise<void> | void): void
  drop(): Promise<void>
}

// ponytail: test-only helper; ephemeral DB per test file, dropped after.
// migrate defaults on; the migration test opts out to stage a partial schema itself.
//
// The handle owns teardown ORDER, because it is the only thing that knows when the database is
// about to disappear. A caller that opens a pool/LISTEN client against `url` and does not
// register it leaves live backends at drop time, and `DROP DATABASE ... WITH (FORCE)` then
// terminates them — which is where "terminating connection due to administrator command" and
// "event stream reconnect failed: database does not exist" come from. FORCE is the backstop for
// a genuinely wedged backend, not the mechanism for routine teardown.
export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  const name = `orc_test_${Math.random().toString(36).slice(2, 10)}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  if (opts.migrate !== false) await migrateDatabase(url.toString()) // schema setup is explicit — open() only verifies
  const closers: (() => Promise<void> | void)[] = []
  return {
    url: url.toString(),
    onClose: fn => { closers.push(fn) },
    drop: async () => {
      // LIFO: a port shuts down before the storage it appends through, which closes before the
      // database goes away. Swallowed because teardown must not overwrite a real failure.
      for (const close of closers.reverse()) {
        try { await close() } catch { /* already-closed or mid-failure teardown */ }
      }
      // also drop every per-project DBOS system DB a port test may have auto-created
      const derived = await admin.query('SELECT datname FROM pg_database WHERE datname LIKE $1', [`${name}_dbos_%`])
      for (const row of derived.rows) {
        if (!/^[a-z0-9_]+$/.test(row.datname)) throw new Error(`unexpected database name: ${row.datname}`)
        await admin.query(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`)
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
  }
}

// git.test.ts's whole job is the shape of git's own output, so this runs real git rather than
// mocking it. Exported alongside tmpGitRepo because the tests that ARRANGE a merge (a commit on the
// worktree branch, a merge made by hand outside orc) need to drive the same repo the fixture built,
// and a second copy per test file would let the two disagree about how a failed git call surfaces —
// here it throws with git's stderr, so an arrangement that silently did nothing is impossible.
export const sh = (cwd: string, ...args: string[]): string => {
  const r = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(new TextDecoder().decode(r.stderr))
  return new TextDecoder().decode(r.stdout).trim()
}

// A throwaway main checkout plus one linked worktree, for tests of anything that reads git's
// `--git-dir` / `--git-common-dir` output. Shared here (not duplicated in git.test.ts) because
// config.test.ts's loadConfig/initializeProject tests need the same fixture.
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
