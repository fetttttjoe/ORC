import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Surreal } from 'surrealdb'
import { ClaimClass, claimId, MemoryNote, MemoryScope, NOTE_KIND, NOTE_TIER, type ClaimHit, type MemoryStore, type NoteSummary } from '@orc/contracts'
import { semanticNoteFixture, TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, sh, staleTestDbs, testDbName, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createMemoryStore } from './store'
import { createMemoryProjector, type MemoryProjector, type ProjectorStore } from './projector'

// single source for test connection defaults — env-overridable, matching orc's own config
// (see packages/kernel/src/config.ts's projectDb* fields); literals appear exactly once here.
const URL = process.env.ORC_PROJECT_DB_URL ?? 'ws://127.0.0.1:8000/rpc'
const NS = process.env.ORC_PROJECT_DB_NAMESPACE ?? 'orc'
const USERNAME = process.env.ORC_PROJECT_DB_USER ?? 'root'
const PASSWORD = process.env.ORC_PROJECT_DB_PASSWORD ?? 'orc'

const TEST_DB_PREFIX = 't_'

export const testSurrealDbName = (): string => testDbName(TEST_DB_PREFIX, Date.now(), Math.random().toString(36).slice(2, 10))

export async function createTestSurreal(): Promise<{
  url: string; ns: string; db: string; username: string; password: string; drop: () => Promise<void>
}> {
  const db = testSurrealDbName()

  const sweep = new Surreal()
  await sweep.connect(URL)
  await sweep.signin({ username: USERNAME, password: PASSWORD })
  await sweep.use({ namespace: NS })
  const [sweepInfo] = await sweep.query<[{ databases: Record<string, unknown> }]>('INFO FOR NS;')
  for (const name of staleTestDbs(Object.keys(sweepInfo?.databases ?? {}), TEST_DB_PREFIX, Date.now()))
    await sweep.query(`REMOVE DATABASE IF EXISTS \`${name}\`;`).catch(() => {})
  await sweep.close()

  return {
    url: URL, ns: NS, db, username: USERNAME, password: PASSWORD,
    drop: async () => {
      const s = new Surreal()
      await s.connect(URL)
      await s.signin({ username: USERNAME, password: PASSWORD })
      // `use()` selects only the namespace (no database) — verified live against SurrealDB
      // v3.2.0 that `REMOVE DATABASE IF EXISTS type::database($db)` is not a valid function path
      // (a parse ValidationError — a bare .catch here swallows it and silently leaves ~80 throwaway
      // `t_*` dbs behind). The working shape inlines the db name directly;
      // safe because `db` is generated above from `[a-z0-9_]` only, never external input.
      await s.use({ namespace: NS })
      // createMemory derives `${db}_<projectSuffix>` from this base name — remove those too.
      // INFO FOR NS lists databases; names are internally generated, never external input.
      const [info] = await s.query<[{ databases: Record<string, unknown> }]>('INFO FOR NS;')
      const derived = Object.keys(info?.databases ?? {}).filter(name => name.startsWith(`${db}_`))
      for (const name of [db, ...derived])
        await s.query(`REMOVE DATABASE IF EXISTS \`${name}\`;`).catch(() => {})
      await s.close()
    },
  }
}

// A real memory stack — test Postgres log, throwaway SurrealDB read model, vault in a temp dir —
// for the integration tests that must exercise the event-first write path rather than a fake store.
// The caller owns teardown: `await live.close()` in an afterAll drops both databases.
export interface LiveMemory { log: EventLog; store: MemoryStore; projector: MemoryProjector; close: () => Promise<void> }

export async function createLiveMemory(): Promise<LiveMemory> {
  const pg = await createTestDb()
  const ts = await createTestSurreal()
  const log = (await openStorage(pg.url, { projectId: TEST_PROJECT_ID })).events
  const surreal = await SurrealMemory.open(ts)
  return {
    log,
    store: createMemoryStore({ log, surreal }),
    projector: createMemoryProjector({ log, surreal, vaultDir: mkdtempSync(path.join(tmpdir(), 'orc-memory-')) }),
    close: async () => { await log.close(); await ts.drop(); await pg.drop() },
  }
}

// A throwaway git repo with two committed source files — what the drift probe and the grounding
// source run real `git` against. Three test files used to build this by hand, each its own way.
export function tmpSourceRepo(prefix: string): { dir: string; run: (...args: string[]) => void; head: () => string } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  const run = (...args: string[]): void => { sh(dir, ...args) }
  run('init', '-q'); run('config', 'user.email', 't@t.t'); run('config', 'user.name', 't')
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1\n')
  run('add', '-A'); run('commit', '-qm', 'base')
  return { dir, run, head: () => sh(dir, 'rev-parse', 'HEAD') }
}

// ---- shared doubles and builders for this plugin's tests ----

export const summaryFixture = (over: Partial<NoteSummary> = {}): NoteSummary => ({
  id: 'n', scope: MemoryScope.project, title: 't', tier: NOTE_TIER.semantic, categories: [], tags: [],
  summary: '', hits: 0, lastAccessedAt: null, sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID, ...over,
})

// the plain note object a memory_written payload carries
export const noteFixture = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'n', scope: MemoryScope.project, kind: NOTE_KIND.fact, sourceRevision: null, title: 'T',
  categories: [], tags: [], links: [], paths: [], summary: '', body: '', ...over,
})

// a search HIT, which is a claim plus the owning note's identity and drift inputs
export const claimHitFixture = (over: Partial<ClaimHit> = {}): ClaimHit => ({
  claimId: claimId('a statement'), noteId: 'n', scope: MemoryScope.project, title: 'T',
  text: 'a statement', class: ClaimClass.fact, anchors: [],
  validFrom: '2026-07-18T00:00:00.000Z', sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID, ...over,
})

// Every MemoryStore method as a no-op with an empty answer; a test spreads this and overrides the
// two or three methods it observes. `write` echoes the draft as a parsed note so callers that read
// the return see the real shape.
export const noopMemoryStore = (): MemoryStore => ({
  write: async note => MemoryNote.parse({ ...semanticNoteFixture(), ...note }),
  remove: async () => {},
  setArchived: async () => {}, setArchivedAll: async () => {},
  get: async () => null,
  useStats: async () => null,
  recordOutcomes: async () => {},
  list: async () => [],
  search: async () => [],
  searchClaims: async () => [],
  claimsFor: async () => [],
  neighbors: async () => [],
  recordAccess: async () => {},
  topics: async () => [],
  topicClaims: async () => [],
  verify: async () => ({ revision: 'headrev', at: '2026-07-30T00:00:00.000Z', by: 'cli', claims: [] }),
})

// The projector's read-model surface with inert defaults; a fault-injecting test overrides one member.
export const projectorStoreStub = (over: Partial<ProjectorStore> = {}): ProjectorStore => ({
  getCursor: async () => 0,
  setStage: async () => {},
  applyEvent: async () => true,
  allNotes: async () => [],
  refreshTopics: async () => {},
  refreshLinks: async () => {},
  get: async () => null,
  clear: async () => {},
  ...over,
})
