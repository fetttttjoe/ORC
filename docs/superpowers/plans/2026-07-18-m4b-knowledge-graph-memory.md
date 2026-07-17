# M4b — Knowledge Graph / Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A persistent, cross-task knowledge graph agents write to during runs and read back later, so work is reused instead of redone (the M5 enabler).

**Architecture:** Event-sourced CQRS over the existing Postgres event log. `memory_written`/`memory_deleted` events (non-locking append, tombstone delete) are the truth; a SurrealDB multi-model store is the agent read model; markdown `vault/memory/**` is a human/browse projection. All writes go through one single-writer `MemoryStore` gateway. Both projections are rebuildable from the log.

**Tech Stack:** Bun (test runner + YAML), TypeScript, zod v4, drizzle-orm + Postgres (event log), SurrealDB v2 + `surrealdb` JS client (read model), Vercel AI SDK tool shape (`ResolvedTool`), DBOS (execution port).

## Global Constraints

- **Runtime/test:** Bun; tests run with `bun test`; typecheck with the root `typecheck` script (add each new package's `tsc --noEmit -p` to it).
- **Validation:** every contract is a zod schema; types are inferred. Defaults live in `.default()`, never `??` chains (house rule, `config.ts`).
- **Event log is the only source of truth.** SurrealDB and `vault/memory/**` are disposable projections rebuilt from the log. Never read truth from either.
- **Memory writes use `EventLog.append` (non-locking) — never `EventLog.transaction`.** The advisory lock is for check-then-append; memory is a blind upsert keyed by `id`.
- **Memory reads query SurrealDB — never `fold(log.all())`.** No read folds the log.
- **Writer containment:** the memory projector writes/deletes ONLY under `vault/memory/**` (extends M4a D5). Atomic per file (tmp→rename), skip-unchanged, drift-warn on hand-edited files.
- **SurrealDB pin:** server image `surrealdb/surrealdb:v2.1.4`; client `surrealdb@^1.3.0`. Namespace `orc`, database `memory`. All adapter ops use `db.query(surql, vars)` (stable across SDK point releases) rather than typed helpers. **Before writing the adapter, verify the pinned client's `connect()` signature** (it changed between client majors) and adjust only the connect call.
- **Timestamps come from the event row (`event.ts`), never a client clock** — the projector uses `event.ts`/`event.seq` so replay is deterministic. (`Date`/random are fine in normal code here; this rule is for determinism of the projection, not a sandbox limit.)
- **ID safety:** note `id` matches `^[a-z0-9][a-z0-9-]*$` (safe filename + SurrealDB record id).
- **Commits:** conventional-commit messages, one per task minimum; frequent commits within a task are fine.

---

### Task 1: Contracts — `MemoryNote`, memory events, nullable `taskId`

**Files:**
- Create: `packages/contracts/src/memory.ts`
- Create: `packages/contracts/src/memory.test.ts`
- Modify: `packages/contracts/src/events.ts` (add two kinds + payload schemas; relax `taskId`)
- Modify: `packages/contracts/src/index.ts` (export `./memory`)

**Interfaces:**
- Produces: `MEMORY_ID_RE`; `MemoryAuthor`, `MemoryNoteInput`, `MemoryNote`, `NoteSummary`, `MemoryFilter`, `MemoryStore` (types); event kinds `memory_written`, `memory_deleted` with payload schemas `{ note: MemoryNoteInput, author: MemoryAuthor }` and `{ id, scope, author: MemoryAuthor }`; `EventInput.taskId` now `string | null`.

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/memory.test.ts`

```ts
import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, MemoryNote, MEMORY_ID_RE } from './memory'

describe('MemoryNoteInput', () => {
  it('accepts a minimal note and applies array/string defaults', () => {
    const n = MemoryNoteInput.parse({ id: 'auth-token-refresh', title: 'Auth token refresh' })
    expect(n.scope).toBe('project')
    expect(n.categories).toEqual([])
    expect(n.tags).toEqual([])
    expect(n.links).toEqual([])
    expect(n.paths).toEqual([])
    expect(n.rules).toEqual([])
    expect(n.summary).toBe('')
    expect(n.body).toBe('')
  })

  it('rejects an id with illegal characters', () => {
    expect(MemoryNoteInput.safeParse({ id: 'Auth Token', title: 'x' }).success).toBe(false)
    expect(MEMORY_ID_RE.test('auth-token-refresh')).toBe(true)
    expect(MEMORY_ID_RE.test('Auth')).toBe(false)
  })

  it('MemoryNote extends input with derived provenance/lifecycle', () => {
    const full = MemoryNote.parse({
      id: 'x', title: 'X',
      createdAt: '2026-07-18T00:00:00Z', createdBy: 'cli',
      updatedAt: '2026-07-18T00:00:00Z', updatedBy: 'cli', revision: 1,
    })
    expect(full.revision).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/contracts/src/memory.test.ts`
Expected: FAIL — cannot resolve `./memory`.

- [ ] **Step 3: Create `packages/contracts/src/memory.ts`**

```ts
import { z } from 'zod'

export const MEMORY_ID_RE = /^[a-z0-9][a-z0-9-]*$/

const Id = z.string().regex(MEMORY_ID_RE).max(128)

export const MemoryAuthor = z.object({
  source: z.enum(['agent', 'cli']),
  taskId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  runToken: z.string().nullable().optional(),
  executor: z.string().optional(),
  model: z.string().optional(),
  role: z.string().optional(),
})
export type MemoryAuthor = z.infer<typeof MemoryAuthor>

// What a writer (agent/CLI) supplies. Arrays/strings default so a minimal note is one id+title.
export const MemoryNoteInput = z.object({
  id: Id,
  scope: z.string().regex(MEMORY_ID_RE).default('project'),
  title: z.string().min(1).max(200),
  categories: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  links: z.array(Id).default([]),        // ids of related notes → the graph
  paths: z.array(z.string()).default([]), // pointers down to code
  rules: z.array(z.string()).default([]), // normative statements agents honor
  summary: z.string().max(500).default(''),
  body: z.string().default(''),
})
export type MemoryNoteInput = z.infer<typeof MemoryNoteInput>

// The stored/rendered note: input + provenance/lifecycle the projector derives from events.
export const MemoryNote = MemoryNoteInput.extend({
  createdAt: z.string(),
  createdBy: z.string(),   // composed identity: "executor·model·role" or "cli"
  updatedAt: z.string(),
  updatedBy: z.string(),
  revision: z.number().int().positive(),
})
export type MemoryNote = z.infer<typeof MemoryNote>

export const NoteSummary = z.object({
  id: z.string(), scope: z.string(), title: z.string(),
  categories: z.array(z.string()), tags: z.array(z.string()), summary: z.string(),
})
export type NoteSummary = z.infer<typeof NoteSummary>

export interface MemoryFilter { scope?: string; category?: string; tag?: string }

// The single-writer gateway (the wrapper). write/remove append events; reads hit SurrealDB.
export interface MemoryStore {
  write(input: MemoryNoteInput, author: MemoryAuthor): Promise<MemoryNote>
  remove(id: string, scope?: string): Promise<void>
  get(id: string, scope?: string): Promise<MemoryNote | null>
  list(filter?: MemoryFilter): Promise<NoteSummary[]>
  search(query: string, filter?: MemoryFilter): Promise<NoteSummary[]>
}

// Composed provenance string for createdBy/updatedBy (frontmatter + read model).
export function composeAuthor(a: MemoryAuthor): string {
  if (a.source === 'cli') return 'cli'
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || 'agent'
}
```

- [ ] **Step 4: Add memory event kinds + relax `taskId`** in `packages/contracts/src/events.ts`

At the top add the import:
```ts
import { MemoryNoteInput, MemoryAuthor } from './memory'
```
Extend the `EventKind` enum with the two new kinds (append to the list):
```ts
export const EventKind = z.enum([
  'task_created', 'plan_proposed', 'plan_edited', 'plan_approved', 'task_status_changed',
  'run_started', 'step_started', 'skill_loaded', 'agent_call', 'tool_call', 'tool_result',
  'signal_received', 'step_completed', 'step_failed',
  'memory_written', 'memory_deleted',
])
```
Add their payload schemas to `PAYLOAD_SCHEMAS`:
```ts
  memory_written: z.object({ note: MemoryNoteInput, author: MemoryAuthor }),
  memory_deleted: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    scope: z.string(),
    author: MemoryAuthor,
  }),
```
Relax `taskId` in `EventInput` (memory events are project-scoped, not task-scoped — spec D3):
```ts
export const EventInput = z.object({
  taskId: z.string().min(1).nullable(),
  stepId: z.string().min(1).nullable(),
  runToken: z.string().min(1).nullable(),
  kind: EventKind,
  payload: z.record(z.string(), z.unknown()),
  usage: Usage.nullable().optional(),
})
```
`EventRecord` already `extends Omit<EventInput,'usage'>`, so its `taskId` becomes `string | null` automatically.

- [ ] **Step 5: Export from `packages/contracts/src/index.ts`**

Add near the other exports:
```ts
export * from './memory'
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/contracts/src/memory.test.ts packages/contracts/src/events.test.ts`
Expected: PASS. If `events.test.ts` asserts a fixed event-kind count, update that number to include the two new kinds.

- [ ] **Step 7: Typecheck + commit**

Run: `bun run typecheck`
Expected: no errors.
```bash
git add packages/contracts/src/memory.ts packages/contracts/src/memory.test.ts packages/contracts/src/events.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): MemoryNote + memory_written/deleted events; nullable event taskId"
```

---

### Task 2: Kernel — nullable-`taskId` migration, `fold` no-ops, vault-projector guard

**Files:**
- Modify: `packages/kernel/src/schema.ts:8` (`taskId` drop `.notNull()`)
- Create: `packages/kernel/drizzle/0001_*.sql` (generated)
- Modify: `packages/kernel/src/projections.ts` (no-op cases for the two kinds)
- Modify: `packages/vault-projector/src/index.ts` (ignore memory / null-taskId events)
- Modify: `packages/kernel/src/projections.test.ts` (fold no-op test)
- Create/Modify: `packages/vault-projector/src/index.test.ts` (guard test)

**Interfaces:**
- Consumes: `EVENT_KIND.memory_written`, `EVENT_KIND.memory_deleted` (Task 1).
- Produces: appended memory events (null `taskId`) are accepted by the log; `fold` ignores them; `renderAll` skips them.

- [ ] **Step 1: Relax the column** in `packages/kernel/src/schema.ts`

```ts
    taskId: text('task_id'),
```
(remove `.notNull()`).

- [ ] **Step 2: Generate the migration**

Run: `cd packages/kernel && bunx drizzle-kit generate && cd ../..`
Expected: a new `packages/kernel/drizzle/0001_*.sql` containing:
```sql
ALTER TABLE "events" ALTER COLUMN "task_id" DROP NOT NULL;
```
If drizzle-kit is unavailable, hand-create `packages/kernel/drizzle/0001_memory_taskid_nullable.sql` with exactly that line and add its entry to `drizzle/meta/_journal.json` (copy the shape of the existing entry, bump `idx`).

- [ ] **Step 3: Write the failing fold test** in `packages/kernel/src/projections.test.ts`

```ts
it('fold ignores memory events and does not create a task', () => {
  const base = fold([]) // empty
  const withMem = fold([{
    seq: 1, taskId: null, stepId: null, runToken: null,
    kind: 'memory_written',
    payload: { note: { id: 'x', title: 'X', scope: 'project', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' }, author: { source: 'cli' } },
    usage: null, ts: '2026-07-18T00:00:00Z',
  }] as any)
  expect(withMem.tasks.size).toBe(base.tasks.size)
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun test packages/kernel/src/projections.test.ts -t "ignores memory"`
Expected: FAIL — `fold` throws on the unhandled `never` (exhaustiveness) or mis-handles it.

- [ ] **Step 5: Add no-op cases** in `packages/kernel/src/projections.ts`

In the `switch (e.kind)`, extend the traceability-only group so the two kinds are explicit no-ops (knowledge lives in SurrealDB, not `State`):
```ts
      case EVENT_KIND.skill_loaded:
      case EVENT_KIND.tool_call:
      case EVENT_KIND.tool_result:
      case EVENT_KIND.signal_received:
      case EVENT_KIND.memory_written:
      case EVENT_KIND.memory_deleted:
        break // traceability / cross-cutting; no task-state derivation
```

- [ ] **Step 6: Guard the vault projector** in `packages/vault-projector/src/index.ts`

`renderAll` derives task ids from the log and must not choke on a null `taskId`. Filter to real task ids:
```ts
  const renderAll = async (): Promise<void> => {
    const byTask = new Set((await log.all()).map(e => e.taskId).filter((id): id is string => id !== null))
    for (const id of byTask) writeVaultFiles(vaultDir, renderTaskFiles(id, await log.byTask(id)))
    await renderRoot()
  }
```
And in `start()`'s subscribe handler, skip events with a null `taskId`:
```ts
      unsub = await log.subscribe({}, e => {
        if (e.taskId === null) return // memory / cross-cutting events aren't the trace projector's concern
        const prev = timers.get(e.taskId)
        ...
```

- [ ] **Step 7: Write the vault-projector guard test** in `packages/vault-projector/src/index.test.ts`

Append a memory event (null taskId) to a populated log, run `renderAll`, assert it does not throw and produces no stray task directory. (Follow the file's existing setup for `createTestDb` + a projector instance.)

- [ ] **Step 8: Run tests + typecheck + commit**

Run: `bun test packages/kernel/src/projections.test.ts packages/vault-projector/`
Run: `bun run typecheck`
Expected: PASS, no type errors.
```bash
git add packages/kernel/src/schema.ts packages/kernel/drizzle packages/kernel/src/projections.ts packages/kernel/src/projections.test.ts packages/vault-projector/src/index.ts packages/vault-projector/src/index.test.ts
git commit -m "feat(kernel): accept project-scoped (null taskId) memory events; fold+vault ignore them"
```

---

### Task 3: SurrealDB service + `projectDbUrl` config

**Files:**
- Modify: `docker-compose.yml`
- Modify: `packages/kernel/src/config.ts`
- Modify: `packages/kernel/src/config.test.ts`

**Interfaces:**
- Produces: `OrcConfig.projectDbUrl: string` (default `ws://127.0.0.1:8000/rpc`), env override `ORC_PROJECT_DB_URL`; a `surrealdb` service reachable on `:8000`.

- [ ] **Step 1: Add the SurrealDB service** to `docker-compose.yml`

```yaml
  surrealdb:
    image: surrealdb/surrealdb:v2.1.4
    command: start --user root --pass orc --bind 0.0.0.0:8000 memory
    ports:
      - "8000:8000"
    healthcheck:
      test: ["CMD", "/surreal", "isready", "--endpoint", "http://localhost:8000"]
      interval: 2s
      timeout: 3s
      retries: 30
```
(`memory` is the storage backend arg → in-memory; state is rebuildable from the log, so durable storage isn't required. Use `rocksdb:/data/surreal.db` + a volume later if you want persistence across restarts.)

- [ ] **Step 2: Write the failing config test** in `packages/kernel/src/config.test.ts`

```ts
it('defaults projectDbUrl and honors the env override', () => {
  expect(loadConfig('/tmp/x').projectDbUrl).toBe('ws://127.0.0.1:8000/rpc')
  withEnv({ ORC_PROJECT_DB_URL: 'ws://db:8000/rpc' }, () => {
    expect(loadConfig('/tmp/x').projectDbUrl).toBe('ws://db:8000/rpc')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `bun test packages/kernel/src/config.test.ts -t projectDbUrl`
Expected: FAIL — `projectDbUrl` undefined.

- [ ] **Step 4: Add the field** in `packages/kernel/src/config.ts`

In `settingsSchema`, add:
```ts
    projectDbUrl: z.string().default('ws://127.0.0.1:8000/rpc'),
```
In `envOverrides`'s `map`, add:
```ts
    projectDbUrl: process.env.ORC_PROJECT_DB_URL,
```
(`OrcConfig` is inferred from the schema, so no type edit is needed.)

- [ ] **Step 5: Run test + commit**

Run: `bun test packages/kernel/src/config.test.ts`
Expected: PASS.
```bash
git add docker-compose.yml packages/kernel/src/config.ts packages/kernel/src/config.test.ts
git commit -m "feat(config): projectDbUrl + SurrealDB service for the memory read model"
```

---

### Task 4: SurrealDB adapter (`plugins/memory/src/surreal.ts`)

**Files:**
- Create: `plugins/memory/package.json`, `plugins/memory/tsconfig.json`
- Create: `plugins/memory/src/surreal.ts`
- Create: `plugins/memory/src/surreal.test.ts`
- Modify: root `package.json` `typecheck` script (append `&& tsc --noEmit -p plugins/memory`)
- Create: `plugins/memory/src/test-helpers.ts` (ephemeral SurrealDB namespace/db per test)

**Interfaces:**
- Consumes: `MemoryNoteInput`, `MemoryNote`, `NoteSummary`, `MemoryFilter`, `MemoryAuthor`, `composeAuthor` (Task 1).
- Produces: `SurrealMemory` with `open(url)`, `applyWritten(e)`, `applyDeleted(e)`, `get(id,scope)`, `list(filter)`, `search(query,filter)`, `bumpRead(id,scope)`, `getCursor()`, `setCursor(seq)`, `clear()`, `close()`. `e` is `{ seq, ts, note?, id?, scope?, author }` (the fields the projector passes).

- [ ] **Step 1: Scaffold the package**

`plugins/memory/package.json`:
```json
{
  "name": "@orc/memory",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@orc/contracts": "workspace:*",
    "@orc/kernel": "workspace:*",
    "surrealdb": "^1.3.0",
    "zod": "^4.4.3"
  }
}
```
`plugins/memory/tsconfig.json` (copy `packages/vault-projector/tsconfig.json` if present; else extend the repo base):
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```
Install: `bun install`. Append to the root `typecheck` script: `&& tsc --noEmit -p plugins/memory`.

- [ ] **Step 2: Test helper** — `plugins/memory/src/test-helpers.ts`

```ts
import { Surreal } from 'surrealdb'
const URL = process.env.ORC_PROJECT_DB_URL ?? 'ws://127.0.0.1:8000/rpc'

// ponytail: test-only — ephemeral namespace/db per test file so tests never collide
export async function createTestSurreal(): Promise<{ url: string; ns: string; db: string; drop: () => Promise<void> }> {
  const ns = 'orc'
  const db = `t_${Math.random().toString(36).slice(2, 10)}`
  return {
    url: URL, ns, db,
    drop: async () => {
      const s = new Surreal()
      await s.connect(URL, { namespace: ns, database: db, auth: { username: 'root', password: 'orc' } })
      await s.query(`REMOVE DATABASE IF EXISTS type::database($db)`, { db }).catch(() => {})
      await s.close()
    },
  }
}
```

- [ ] **Step 3: Write the failing adapter test** — `plugins/memory/src/surreal.test.ts`

```ts
import { afterAll, describe, expect, it } from 'bun:test'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'

const note = (over = {}) => ({ id: 'auth', scope: 'project', title: 'Auth', categories: ['security'], tags: ['auth'], links: [], paths: ['src/auth.ts'], rules: [], summary: 'tokens rotate', body: 'full text about auth tokens', ...over })
const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

describe('SurrealMemory', () => {
  it('applies a write, reads it back, and increments revision on update', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyWritten({ seq: 1, ts: '2026-07-18T00:00:00Z', note: note(), author: { source: 'cli' } })
    let got = await m.get('auth', 'project')
    expect(got?.revision).toBe(1)
    expect(got?.createdBy).toBe('cli')
    await m.applyWritten({ seq: 2, ts: '2026-07-18T01:00:00Z', note: note({ summary: 'rotate on use' }), author: { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' } })
    got = await m.get('auth', 'project')
    expect(got?.revision).toBe(2)
    expect(got?.createdBy).toBe('cli')            // unchanged
    expect(got?.updatedBy).toBe('api-loop·opus·review')
    expect(got?.summary).toBe('rotate on use')
    await m.close()
  })

  it('search matches on body/summary/title; delete removes; cursor round-trips', async () => {
    const t = await createTestSurreal(); drops.push(t.drop)
    const m = await SurrealMemory.open(t)
    await m.applyWritten({ seq: 1, ts: '2026-07-18T00:00:00Z', note: note(), author: { source: 'cli' } })
    expect((await m.search('tokens')).map(n => n.id)).toEqual(['auth'])
    await m.setCursor(5); expect(await m.getCursor()).toBe(5)
    await m.applyDeleted({ seq: 6, ts: '2026-07-18T02:00:00Z', id: 'auth', scope: 'project', author: { source: 'cli' } })
    expect(await m.get('auth', 'project')).toBeNull()
    await m.close()
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun run db:up && bun test plugins/memory/src/surreal.test.ts`
Expected: FAIL — `./surreal` not found.

- [ ] **Step 5: Implement `plugins/memory/src/surreal.ts`**

```ts
import { Surreal } from 'surrealdb'
import { composeAuthor, MemoryNote, type MemoryAuthor, type MemoryFilter, type MemoryNoteInput, type NoteSummary } from '@orc/contracts'

// NOTE: verify connect() against surrealdb@^1.3 before edits (see Global Constraints).
type WrittenEvent = { seq: number; ts: string; note: MemoryNoteInput; author: MemoryAuthor }
type DeletedEvent = { seq: number; ts: string; id: string; scope: string; author: MemoryAuthor }

const CURSOR = 'meta:cursor'

export class SurrealMemory {
  private constructor(private readonly db: Surreal) {}

  static async open(t: { url: string; ns: string; db: string }): Promise<SurrealMemory> {
    const db = new Surreal()
    await db.connect(t.url, { namespace: t.ns, database: t.db, auth: { username: 'root', password: 'orc' } })
    // schemaless notes; a numeric cursor row lives in the same db.
    await db.query('DEFINE TABLE IF NOT EXISTS note SCHEMALESS; DEFINE TABLE IF NOT EXISTS meta SCHEMALESS;')
    return new SurrealMemory(db)
  }

  // last-writer-wins content; createdAt/By fixed at first apply, updated/rev advance. Ordered
  // by the projector, so revision counts applies deterministically (replay-identical).
  async applyWritten(e: WrittenEvent): Promise<void> {
    const key = `${e.note.scope}:${e.note.id}`
    const by = composeAuthor(e.author)
    await this.db.query(
      `LET $ex = (SELECT * FROM type::thing('note', $key))[0];
       UPSERT type::thing('note', $key) CONTENT {
         id: $note.id, scope: $note.scope, title: $note.title,
         categories: $note.categories, tags: $note.tags, links: $note.links,
         paths: $note.paths, rules: $note.rules, summary: $note.summary, body: $note.body,
         createdAt: $ex.createdAt ?? $ts, createdBy: $ex.createdBy ?? $by,
         updatedAt: $ts, updatedBy: $by, revision: ($ex.revision ?? 0) + 1,
         lastReadAt: $ex.lastReadAt ?? NONE, readCount: $ex.readCount ?? 0,
         deleted: false,
       };`,
      { key, note: e.note, ts: e.ts, by },
    )
  }

  async applyDeleted(e: DeletedEvent): Promise<void> {
    await this.db.query(`DELETE type::thing('note', $key)`, { key: `${e.scope}:${e.id}` })
  }

  async get(id: string, scope = 'project'): Promise<MemoryNote | null> {
    const [rows] = await this.db.query<[any[]]>(`SELECT * FROM type::thing('note', $key)`, { key: `${scope}:${id}` })
    const r = rows?.[0]
    if (!r || r.deleted) return null
    return MemoryNote.parse(strip(r))
  }

  async bumpRead(id: string, scope = 'project'): Promise<void> {
    await this.db.query(
      `UPDATE type::thing('note', $key) SET lastReadAt = time::now(), readCount = (readCount ?? 0) + 1`,
      { key: `${scope}:${id}` },
    )
  }

  async list(filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    return this.select(where(filter))
  }

  async search(query: string, filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    const w = where(filter)
    const clause = [
      `(string::lowercase(title) CONTAINS string::lowercase($q)`,
      `OR string::lowercase(summary) CONTAINS string::lowercase($q)`,
      `OR string::lowercase(body) CONTAINS string::lowercase($q)`,
      `OR $q IN tags)`,
    ].join(' ')
    return this.select([...w, clause], { q: query })
  }

  private async select(clauses: string[], vars: Record<string, unknown> = {}): Promise<NoteSummary[]> {
    const cond = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const [rows] = await this.db.query<[any[]]>(
      `SELECT id, scope, title, categories, tags, summary FROM note WHERE (deleted = false) ${cond ? 'AND ' + cond.slice(6) : ''} ORDER BY updatedAt DESC`,
      vars,
    )
    return (rows ?? []).map(r => ({ id: r.id, scope: r.scope, title: r.title, categories: r.categories, tags: r.tags, summary: r.summary }))
  }

  async getCursor(): Promise<number> {
    const [rows] = await this.db.query<[any[]]>(`SELECT seq FROM ${CURSOR}`)
    return rows?.[0]?.seq ?? 0
  }
  async setCursor(seq: number): Promise<void> {
    await this.db.query(`UPSERT ${CURSOR} CONTENT { seq: $seq }`, { seq })
  }
  async clear(): Promise<void> { await this.db.query('DELETE note; DELETE meta;') }
  async close(): Promise<void> { await this.db.close() }
}

// SurrealDB record ids/metadata leak fields like `id` as a RecordId object; the note's own
// `id` string is stored explicitly above, so read it from the content, not the record key.
function strip(r: any) {
  return {
    id: r.id, scope: r.scope, title: r.title, categories: r.categories, tags: r.tags,
    links: r.links, paths: r.paths, rules: r.rules, summary: r.summary, body: r.body,
    createdAt: r.createdAt, createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
    revision: r.revision,
  }
}
function where(f: MemoryFilter): string[] {
  const c: string[] = []
  if (f.scope) c.push('scope = $scope')
  if (f.category) c.push('$category IN categories')
  if (f.tag) c.push('$tag IN tags')
  return c
}
```
Note: `select` passes filter values via `vars`; thread `f.scope/category/tag` into the `vars` object at the call sites in `list`/`search` (add them alongside `q`). Keep the SurrealQL minimal and verify the exact result-tuple shape returned by the pinned client (`query` returns an array of per-statement results).

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test plugins/memory/src/surreal.test.ts`
Expected: PASS. Iterate on SurrealQL result-shape details against the running container until green.

- [ ] **Step 7: Typecheck + commit**

Run: `bun run typecheck`
```bash
git add plugins/memory package.json bun.lock
git commit -m "feat(memory): SurrealDB read-model adapter (apply/get/list/search/cursor)"
```

---

### Task 5: Pure note renderer (`plugins/memory/src/note-md.ts`)

**Files:**
- Create: `plugins/memory/src/note-md.ts`
- Create: `plugins/memory/src/note-md.test.ts`

**Interfaces:**
- Consumes: `MemoryNote` (Task 1).
- Produces: `renderNoteFile(note: MemoryNote): string` (frontmatter + body), `noteRelPath(note): string` (`<id>.md` for `project`, else `<scope>/<id>.md`). Pure — no fs, no clock.

- [ ] **Step 1: Write the failing test** — `plugins/memory/src/note-md.test.ts`

```ts
import { describe, expect, it } from 'bun:test'
import { noteRelPath, renderNoteFile } from './note-md'

const note = {
  id: 'auth-token-refresh', scope: 'project', title: 'Auth token refresh flow',
  categories: ['architecture', 'security'], tags: ['auth'], links: ['session-model'],
  paths: ['packages/kernel/src/auth.ts'], rules: ['Refresh tokens are single-use.'],
  summary: 'Refresh tokens rotate on use.', body: '# Detail\nrotation logic',
  createdAt: '2026-07-18T09:12:04Z', createdBy: 'api-loop·sonnet-5·research',
  updatedAt: '2026-07-18T11:30:22Z', updatedBy: 'api-loop·opus·review', revision: 3,
}

describe('renderNoteFile', () => {
  it('emits type: memory frontmatter with all sourced fields and the body', () => {
    const md = renderNoteFile(note as any)
    expect(md).toStartWith('---\n')
    expect(md).toContain('type: memory')
    expect(md).toContain('id: auth-token-refresh')
    expect(md).toContain('updatedBy: api-loop·opus·review')
    expect(md).toContain('revision: 3')
    expect(md).toContain('# Detail\nrotation logic')
    expect(md).not.toContain('readCount') // Tier-2 never in the file
  })
  it('paths under scope subdir only for non-project scopes', () => {
    expect(noteRelPath(note as any)).toBe('auth-token-refresh.md')
    expect(noteRelPath({ ...note, scope: 'infra' } as any)).toBe('infra/auth-token-refresh.md')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test plugins/memory/src/note-md.test.ts`
Expected: FAIL — `./note-md` not found.

- [ ] **Step 3: Implement `plugins/memory/src/note-md.ts`**

```ts
import type { MemoryNote } from '@orc/contracts'

export function noteRelPath(note: Pick<MemoryNote, 'id' | 'scope'>): string {
  return note.scope === 'project' ? `${note.id}.md` : `${note.scope}/${note.id}.md`
}

// Native Bun YAML keeps this lossless and dependency-free (same choice as the plan round-trip).
export function renderNoteFile(note: MemoryNote): string {
  const fm = Bun.YAML.stringify({
    type: 'memory',
    id: note.id, scope: note.scope, title: note.title,
    categories: note.categories, tags: note.tags, links: note.links,
    paths: note.paths, rules: note.rules, summary: note.summary,
    createdAt: note.createdAt, createdBy: note.createdBy,
    updatedAt: note.updatedAt, updatedBy: note.updatedBy, revision: note.revision,
  })
  return `---\n${fm}---\n\n${note.body}\n`
}
```
(If `Bun.YAML.stringify` is unavailable in the pinned Bun, use the same YAML approach the vault projector's `plan-md.ts` uses — match that file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test plugins/memory/src/note-md.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add plugins/memory/src/note-md.ts plugins/memory/src/note-md.test.ts
git commit -m "feat(memory): pure OKF note renderer"
```

---

### Task 6: Memory projector (`plugins/memory/src/projector.ts` + `write-note.ts`)

**Files:**
- Create: `plugins/memory/src/write-note.ts` (atomic writer confined to `vault/memory/**`)
- Create: `plugins/memory/src/projector.ts`
- Create: `plugins/memory/src/projector.test.ts`
- Create: `plugins/memory/src/write-note.test.ts`

**Interfaces:**
- Consumes: `EventLog.subscribe`/`byTask`/`all` semantics; `SurrealMemory` (Task 4); `renderNoteFile`/`noteRelPath` (Task 5); `EVENT_KIND.memory_written`/`memory_deleted`.
- Produces: `createMemoryProjector({ log, surreal, vaultDir }) → { start(): Promise<void>, close(): Promise<void>, rebuild(): Promise<void> }`; `writeMemoryFile(vaultDir, relPath, content)` and `deleteMemoryFile(vaultDir, relPath)` confined under `vault/memory/`.

- [ ] **Step 1: Write the failing writer test** — `plugins/memory/src/write-note.test.ts`

```ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeMemoryFile, deleteMemoryFile } from './write-note'

describe('memory writer', () => {
  it('writes atomically under vault/memory and refuses escapes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    writeMemoryFile(dir, 'auth.md', 'hi')
    expect(readFileSync(path.join(dir, 'memory', 'auth.md'), 'utf8')).toBe('hi')
    deleteMemoryFile(dir, 'auth.md')
    expect(existsSync(path.join(dir, 'memory', 'auth.md'))).toBe(false)
    expect(() => writeMemoryFile(dir, '../escape.md', 'x')).toThrow(/escapes/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then implement `write-note.ts`**

Run: `bun test plugins/memory/src/write-note.test.ts` → FAIL.
```ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Single writer for vault/memory/** ONLY (spec D5). Atomic per file; skip-unchanged.
function resolveInMemory(vaultDir: string, rel: string): string {
  const root = path.resolve(vaultDir, 'memory')
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`memory write escapes root: ${rel}`)
  return abs
}
export function writeMemoryFile(vaultDir: string, rel: string, content: string): void {
  const abs = resolveInMemory(vaultDir, rel)
  if (existsSync(abs) && readFileSync(abs, 'utf8') === content) return
  mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp`
  writeFileSync(tmp, content)
  renameSync(tmp, abs)
}
export function deleteMemoryFile(vaultDir: string, rel: string): void {
  const abs = resolveInMemory(vaultDir, rel)
  rmSync(abs, { force: true })
}
```
Run: `bun test plugins/memory/src/write-note.test.ts` → PASS.

- [ ] **Step 3: Write the failing projector test** — `plugins/memory/src/projector.test.ts`

```ts
import { afterAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventLog } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'   // if not exported, inline the pg createTestDb from Task-4's pattern
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryProjector } from './projector'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })
const noteInput = { id: 'auth', scope: 'project', title: 'Auth', categories: [], tags: ['auth'], links: [], paths: [], rules: [], summary: 's', body: 'b' }

describe('memory projector', () => {
  it('applies written/deleted from the stream to SurrealDB + vault, and rebuilds from the log', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await EventLog.open(pg.url)
    const surreal = await SurrealMemory.open(ts)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'vault-'))
    const proj = createMemoryProjector({ log, surreal, vaultDir })
    await proj.start()

    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note: noteInput, author: { source: 'cli' } } } as any)
    await Bun.sleep(150)
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(true)
    expect((await surreal.get('auth', 'project'))?.title).toBe('Auth')

    await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_deleted', payload: { id: 'auth', scope: 'project', author: { source: 'cli' } } } as any)
    await Bun.sleep(150)
    expect(existsSync(path.join(vaultDir, 'memory', 'auth.md'))).toBe(false)
    expect(await surreal.get('auth', 'project')).toBeNull()

    await proj.rebuild()   // replays memory_* from the log into a fresh store
    expect(await surreal.get('auth', 'project')).toBeNull() // deleted stayed deleted after replay
    await proj.close(); await surreal.close(); await log.close()
  })
})
```

- [ ] **Step 4: Run it to verify it fails, then implement `projector.ts`**

Run: `bun test plugins/memory/src/projector.test.ts` → FAIL (`./projector` missing).
```ts
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import { MemoryNoteInput } from '@orc/contracts'
import { SurrealMemory } from './surreal'
import { noteRelPath, renderNoteFile } from './note-md'
import { deleteMemoryFile, writeMemoryFile } from './write-note'

export interface MemoryProjector { start(): Promise<void>; close(): Promise<void>; rebuild(): Promise<void> }

export function createMemoryProjector(opts: { log: EventLog; surreal: SurrealMemory; vaultDir: string }): MemoryProjector {
  const { log, surreal, vaultDir } = opts
  let unsub: (() => Promise<void>) | null = null
  let applying: Promise<void> = Promise.resolve()

  const applyOne = async (e: EventRecord): Promise<void> => {
    if (e.kind === EVENT_KIND.memory_written) {
      const p = e.payload as { note: unknown; author: any }
      const note = MemoryNoteInput.parse(p.note)
      await surreal.applyWritten({ seq: e.seq, ts: e.ts, note, author: p.author })
      const full = await surreal.get(note.id, note.scope)
      if (full) writeMemoryFile(vaultDir, noteRelPath(full), renderNoteFile(full))
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const p = e.payload as { id: string; scope: string; author: any }
      await surreal.applyDeleted({ seq: e.seq, ts: e.ts, id: p.id, scope: p.scope, author: p.author })
      deleteMemoryFile(vaultDir, noteRelPath({ id: p.id, scope: p.scope }))
    }
    await surreal.setCursor(e.seq)
  }

  // Serialize applies so revision/ordering is deterministic; reconcile by querying the log
  // WHERE seq > cursor rather than trusting the subscribe cursor (skip caveat, spec §4.3).
  const drainFrom = async (fromSeq: number): Promise<void> => {
    const events = (await log.all()).filter(e => e.seq > fromSeq && (e.kind === EVENT_KIND.memory_written || e.kind === EVENT_KIND.memory_deleted))
    for (const e of events) await applyOne(e)
  }
  const enqueueDrain = (): void => { applying = applying.then(() => drainFrom(cursorCache).then(c => {})).catch(err => console.warn(`memory projector: ${err instanceof Error ? err.message : String(err)}`)) }

  let cursorCache = 0
  return {
    start: async () => {
      cursorCache = await surreal.getCursor()
      await drainFrom(cursorCache); cursorCache = await surreal.getCursor()
      unsub = await log.subscribe({}, () => {
        applying = applying.then(async () => {
          await drainFrom(cursorCache); cursorCache = await surreal.getCursor()
        }).catch(err => console.warn(`memory projector: ${err instanceof Error ? err.message : String(err)}`))
      })
    },
    close: async () => { if (unsub) { await unsub(); unsub = null } await applying },
    rebuild: async () => { await surreal.clear(); cursorCache = 0; await drainFrom(0); cursorCache = await surreal.getCursor() },
  }
}
```
(Simplify the `enqueueDrain`/`cursorCache` bookkeeping if the subagent finds it clearer to re-read the cursor from SurrealDB each drain; the invariant is: applies are serialized and driven by "log events with seq > persisted cursor".)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test plugins/memory/src/projector.test.ts plugins/memory/src/write-note.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**
```bash
git add plugins/memory/src/projector.ts plugins/memory/src/projector.test.ts plugins/memory/src/write-note.ts plugins/memory/src/write-note.test.ts
git commit -m "feat(memory): stream projector → SurrealDB + vault/memory, with rebuild"
```

---

### Task 7: `MemoryStore` gateway (`plugins/memory/src/store.ts`)

**Files:**
- Create: `plugins/memory/src/store.ts`
- Create: `plugins/memory/src/store.test.ts`

**Interfaces:**
- Consumes: `EventLog.append`; `MemoryStore`, `MemoryNoteInput`, `MemoryAuthor`, `composeAuthor` (Task 1); `SurrealMemory` (Task 4).
- Produces: `createMemoryStore({ log, surreal }): MemoryStore`. `write` appends `memory_written` via **`log.append`** (asserted off the transaction/lock path); reads delegate to SurrealDB; `get` also `bumpRead`s.

- [ ] **Step 1: Write the failing test** — `plugins/memory/src/store.test.ts`

```ts
import { afterAll, describe, expect, it } from 'bun:test'
import { EventLog } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'
import { SurrealMemory } from './surreal'
import { createTestSurreal } from './test-helpers'
import { createMemoryStore } from './store'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

describe('MemoryStore gateway', () => {
  it('write appends a memory_written event with stamped provenance and null taskId', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await EventLog.open(pg.url)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await store.write({ id: 'auth', title: 'Auth' } as any, { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' })
    const events = await log.all()
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('memory_written')
    expect(events[0]!.taskId).toBeNull()
    expect((events[0]!.payload as any).author.executor).toBe('api-loop')
    await log.close()
  })

  it('rejects a malformed note without appending', async () => {
    const pg = await createTestDb(); drops.push(pg.drop)
    const ts = await createTestSurreal(); drops.push(ts.drop)
    const log = await EventLog.open(pg.url)
    const store = createMemoryStore({ log, surreal: await SurrealMemory.open(ts) })
    await expect(store.write({ id: 'Bad Id', title: 'x' } as any, { source: 'cli' })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then implement `store.ts`**

Run: `bun test plugins/memory/src/store.test.ts` → FAIL.
```ts
import { MemoryNoteInput, type MemoryAuthor, type MemoryFilter, type MemoryNote, type MemoryStore, type NoteSummary } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import type { SurrealMemory } from './surreal'

// The single writer (spec RM5). Writes are event-first via the NON-locking append (spec D2);
// the projector applies to SurrealDB. Reads hit SurrealDB directly.
export function createMemoryStore(opts: { log: EventLog; surreal: SurrealMemory }): MemoryStore {
  const { log, surreal } = opts
  return {
    async write(input, author) {
      const note = MemoryNoteInput.parse(input)          // reject malformed BEFORE appending
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written', payload: { note, author } })
      // event-first: the record materializes via the projector shortly; return a best-effort
      // read (may be null within the flush window — callers treat write as fire-and-forget).
      return (await surreal.get(note.id, note.scope)) ?? ({ ...note, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1 } as MemoryNote)
    },
    async remove(id, scope = 'project') {
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_deleted', payload: { id, scope, author: { source: 'cli' } as MemoryAuthor } })
    },
    async get(id, scope = 'project') {
      const n = await surreal.get(id, scope)
      if (n) await surreal.bumpRead(id, scope)
      return n
    },
    list: (filter?: MemoryFilter): Promise<NoteSummary[]> => surreal.list(filter),
    search: (query: string, filter?: MemoryFilter): Promise<NoteSummary[]> => surreal.search(query, filter),
  }
}
```
(If `remove` needs agent provenance too, add an optional `author` param mirroring `write`; the CLI passes `{source:'cli'}`, the tool passes the step author.)

- [ ] **Step 3: Run tests to verify they pass**

Run: `bun test plugins/memory/src/store.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**
```bash
git add plugins/memory/src/store.ts plugins/memory/src/store.test.ts
git commit -m "feat(memory): single-writer MemoryStore gateway (non-locking append)"
```

---

### Task 8: Agent tools + `dbos-port` step-tools seam + runtime wiring

**Files:**
- Create: `plugins/memory/src/tools.ts`
- Create: `plugins/memory/src/index.ts`
- Create: `plugins/memory/src/tools.test.ts`
- Modify: `packages/kernel/src/execution/dbos-port.ts` (add `stepTools` opt; concat per-step tools)
- Modify: `packages/cli/src/runtime.ts` (create memory, start projector, pass `stepTools`, close on shutdown)

**Interfaces:**
- Consumes: `ResolvedTool` (contracts); `MemoryStore` (Task 1); `SurrealMemory`, `createMemoryStore`, `createMemoryProjector` (Tasks 4/6/7).
- Produces: `memoryTools(store: MemoryStore, author: MemoryAuthor): ResolvedTool[]` (`memory_write`/`memory_search`/`memory_read`); `createMemory({ log, config }): Promise<{ store, projector, buildTools(author): ResolvedTool[], close(): Promise<void> }>`; `createDbosPort` gains `opts.stepTools?: (p: StepToolCtx) => ResolvedTool[]` where `StepToolCtx = { taskId, stepId, runToken, role, executor, model }`.

- [ ] **Step 1: Write the failing tools test** — `plugins/memory/src/tools.test.ts`

```ts
import { describe, expect, it } from 'bun:test'
import { memoryTools } from './tools'

const fakeStore = () => {
  const written: any[] = []
  return {
    store: {
      write: async (input: any, author: any) => { written.push({ input, author }); return { ...input, revision: 1 } },
      remove: async () => {}, get: async () => ({ id: 'auth', body: 'b' }),
      list: async () => [], search: async () => [{ id: 'auth', title: 'Auth' }],
    } as any,
    written,
  }
}

describe('memory tools', () => {
  it('declares three tools; memory_write routes to the store with the bound author', async () => {
    const { store, written } = fakeStore()
    const tools = memoryTools(store, { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' })
    expect(tools.map(t => t.name).sort()).toEqual(['memory_read', 'memory_search', 'memory_write'])
    const write = tools.find(t => t.name === 'memory_write')!
    const r = await write.execute({ id: 'auth', title: 'Auth' })
    expect(r.isError).toBe(false)
    expect(written[0].author.executor).toBe('api-loop')
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then implement `tools.ts`**

Run: `bun test plugins/memory/src/tools.test.ts` → FAIL.
```ts
import type { MemoryAuthor, MemoryStore, ResolvedTool } from '@orc/contracts'

const ok = (output: unknown) => ({ output, isError: false })
const err = (e: unknown) => ({ output: { error: e instanceof Error ? e.message : String(e) }, isError: true })

// Injected as ResolvedTool[] via the same channel MCP tools use. Author is bound per step.
export function memoryTools(store: MemoryStore, author: MemoryAuthor): ResolvedTool[] {
  return [
    {
      ref: 'memory/write', name: 'memory_write',
      description: 'Create or update a project knowledge note (upsert by id). Record durable findings/decisions/conventions so later steps reuse them.',
      inputSchema: {
        type: 'object', required: ['id', 'title'],
        properties: {
          id: { type: 'string', description: 'stable slug ^[a-z0-9][a-z0-9-]*$' },
          title: { type: 'string' }, summary: { type: 'string' }, body: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          links: { type: 'array', items: { type: 'string' }, description: 'ids of related notes' },
          paths: { type: 'array', items: { type: 'string' }, description: 'code paths this note refers to' },
          rules: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
        },
      },
      execute: async input => { try { const n = await store.write(input as any, author); return ok({ id: n.id, revision: n.revision }) } catch (e) { return err(e) } },
    },
    {
      ref: 'memory/search', name: 'memory_search',
      description: 'Search project knowledge by keyword. Returns note summaries (id, title, categories, tags, summary). Read the full note with memory_read.',
      inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, category: { type: 'string' }, tag: { type: 'string' } } },
      execute: async input => { try { const q = input as any; return ok({ notes: await store.search(q.query, { category: q.category, tag: q.tag }) }) } catch (e) { return err(e) } },
    },
    {
      ref: 'memory/read', name: 'memory_read',
      description: 'Read one project knowledge note in full by id.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, scope: { type: 'string' } } },
      execute: async input => { try { const q = input as any; const n = await store.get(q.id, q.scope); return n ? ok({ note: n }) : ok({ note: null }) } catch (e) { return err(e) } },
    },
  ]
}
```
Run: `bun test plugins/memory/src/tools.test.ts` → PASS.

- [ ] **Step 3: Implement `plugins/memory/src/index.ts`**

```ts
import type { MemoryAuthor, ResolvedTool } from '@orc/contracts'
import { EventLog, type OrcConfig } from '@orc/kernel'
import { SurrealMemory } from './surreal'
import { createMemoryStore } from './store'
import { createMemoryProjector, type MemoryProjector } from './projector'
import { memoryTools } from './tools'

export { SurrealMemory } from './surreal'
export { createMemoryStore } from './store'
export { createMemoryProjector } from './projector'
export { memoryTools } from './tools'
export { renderNoteFile, noteRelPath } from './note-md'

export async function createMemory(opts: { log: EventLog; config: OrcConfig }): Promise<{
  store: ReturnType<typeof createMemoryStore>
  projector: MemoryProjector
  buildTools: (author: MemoryAuthor) => ResolvedTool[]
  close: () => Promise<void>
}> {
  const url = new URL(opts.config.projectDbUrl)
  const surreal = await SurrealMemory.open({ url: opts.config.projectDbUrl, ns: 'orc', db: 'memory' })
  const store = createMemoryStore({ log: opts.log, surreal })
  const projector = createMemoryProjector({ log: opts.log, surreal, vaultDir: opts.config.vaultDir })
  return {
    store, projector,
    buildTools: author => memoryTools(store, author),
    close: async () => { await projector.close(); await surreal.close() },
  }
}
```
(`url` is parsed only to fail fast on a malformed setting; the adapter takes the raw string.)

- [ ] **Step 4: Add the `stepTools` seam** in `packages/kernel/src/execution/dbos-port.ts`

Add to the `createDbosPort` opts type:
```ts
  stepTools?: (p: { taskId: string; stepId: string; runToken: string; role: string; executor: string; model: string }) => ResolvedTool[]
```
Destructure it: `const { log, config, providers, executors, skills, tools, stepTools } = opts`.
After the MCP `extraTools` block (right before building `ctx`), append the per-step memory tools:
```ts
      if (stepTools)
        extraTools = [...extraTools, ...stepTools({
          taskId: args.taskId, stepId: args.stepId, runToken,
          role: init.step.role, executor: init.step.executorRef, model: resolveModel(providers, init.step.modelRef).modelId,
        })]
```
(`init.step.role` exists on `PlanStep`; `modelId` is already computed above as `const { modelId } = resolveModel(...)` — reuse that variable instead of calling `resolveModel` twice.)

- [ ] **Step 5: Wire the runtime** in `packages/cli/src/runtime.ts`

Add the import and thread memory through `buildRuntime`:
```ts
import { createMemory } from '@orc/memory'
```
Inside `buildRuntime`, after `const log = ...` and before `createDbosPort`:
```ts
  const memory = await createMemory({ log, config })
```
Pass `stepTools` into `createDbosPort`:
```ts
  const port = await createDbosPort({
    log, config,
    providers: host.providers, executors: host.executors,
    skills: host.skills, tools: hub,
    stepTools: p => memory.buildTools({ source: 'agent', taskId: p.taskId, stepId: p.stepId, runToken: p.runToken, executor: p.executor, model: p.model, role: p.role }),
  })
```
Start the projector next to the vault projector, and close both on shutdown:
```ts
  await memory.projector.start()
  // ...existing projector.start()...
  return {
    ...port,
    shutdown: async () => {
      await memory.projector.close()
      await memory.close()
      await projector.close()
      await hub.close()
      await host.shutdown()
      await port.shutdown()
    },
  }
```
Add `@orc/memory` to `packages/cli/package.json` dependencies (`"workspace:*"`), run `bun install`.

- [ ] **Step 6: Update `dbos-port` tests + typecheck**

Run: `bun test packages/kernel/src/execution/ && bun run typecheck`
Expected: existing port tests still PASS (the new opt is optional). Fix any type gaps.

- [ ] **Step 7: Commit**
```bash
git add plugins/memory/src/tools.ts plugins/memory/src/tools.test.ts plugins/memory/src/index.ts packages/kernel/src/execution/dbos-port.ts packages/cli/src/runtime.ts packages/cli/package.json bun.lock
git commit -m "feat(memory): agent tools + dbos-port step-tools seam + runtime wiring"
```

---

### Task 9: CLI — `orc memory` subcommands

**Files:**
- Modify: `packages/cli/src/main.ts` (register `memory` command group)
- Modify: `packages/cli/src/main.test.ts` (CLI smoke test)

**Interfaces:**
- Consumes: `createMemory` (Task 8); the pattern for command registration in `main.ts` (follow an existing group such as `mcp`/`ext`).
- Produces: `orc memory add|rm|ls|search|cat|rebuild`.

- [ ] **Step 1: Read the existing command structure**

Open `packages/cli/src/main.ts` and locate how a subcommand group is registered and how it obtains `config`/`log` (follow the existing `vault render` and `mcp` commands for the exact CLI framework calls — do not invent a new pattern).

- [ ] **Step 2: Write a failing CLI test** in `packages/cli/src/main.test.ts`

Follow the file's existing style. Assert that `orc memory add --id auth --title Auth` (with a body via `--body`) appends a `memory_written` event and that `orc memory ls` lists it, and `orc memory rebuild` runs without error. If the CLI tests use a live DB harness, gate this test the same way existing DB-touching CLI tests are gated.

- [ ] **Step 3: Implement the command group** in `packages/cli/src/main.ts`

```ts
// inside command registration, mirroring existing groups
const mem = program.command('memory').description('project knowledge graph')
const withMemory = async () => {
  const config = loadConfig()
  const log = await EventLog.open(config.databaseUrl)
  const memory = await createMemory({ log, config })
  return { memory, close: async () => { await memory.close(); await log.close() } }
}
mem.command('add').requiredOption('--id <id>').requiredOption('--title <title>')
  .option('--summary <s>').option('--body <b>').option('--tags <t...>').option('--categories <c...>')
  .action(async o => {
    const { memory, close } = await withMemory()
    await memory.store.write({ id: o.id, title: o.title, summary: o.summary ?? '', body: o.body ?? '', tags: o.tags ?? [], categories: o.categories ?? [] } as any, { source: 'cli' })
    await close(); console.log(`wrote memory '${o.id}'`)
  })
mem.command('rm').argument('<id>').option('--scope <s>').action(async (id, o) => {
  const { memory, close } = await withMemory(); await memory.store.remove(id, o.scope); await close(); console.log(`deleted '${id}'`)
})
mem.command('ls').option('--category <c>').option('--tag <t>').action(async o => {
  const { memory, close } = await withMemory(); const rows = await memory.store.list({ category: o.category, tag: o.tag }); await close()
  for (const n of rows) console.log(`${n.id}\t${n.title}\t[${n.categories.join(',')}]\t${n.summary}`)
})
mem.command('search').argument('<query>').action(async query => {
  const { memory, close } = await withMemory(); const rows = await memory.store.search(query); await close()
  for (const n of rows) console.log(`${n.id}\t${n.title}\t${n.summary}`)
})
mem.command('cat').argument('<id>').option('--scope <s>').action(async (id, o) => {
  const { memory, close } = await withMemory(); const n = await memory.store.get(id, o.scope); await close()
  console.log(n ? JSON.stringify(n, null, 2) : `no note '${id}'`)
})
mem.command('rebuild').action(async () => {
  const { memory, close } = await withMemory(); await memory.projector.rebuild(); await close(); console.log('memory read model rebuilt from the log')
})
```
(Adapt the exact `program`/`command` API to the CLI framework already in `main.ts`. `rebuild` here does not need a running subscription — it replays the whole log once.)

- [ ] **Step 4: Run test + typecheck + manual smoke**

Run: `bun run db:up && bun test packages/cli/src/main.test.ts && bun run typecheck`
Manual: `bun run packages/cli/src/bin.ts memory add --id demo --title Demo --body hi && bun run packages/cli/src/bin.ts memory ls`
Expected: the note is listed; a `vault/memory/demo.md` appears.

- [ ] **Step 5: Commit**
```bash
git add packages/cli/src/main.ts packages/cli/src/main.test.ts
git commit -m "feat(cli): orc memory add|rm|ls|search|cat|rebuild"
```

---

### Task 10: Integration — the reuse proof

**Files:**
- Create: `plugins/memory/src/reuse.integration.test.ts` (or place under `packages/kernel/src/execution/` next to `vault-run.test.ts` if that is where full-run integration tests live — match the repo).

**Interfaces:**
- Consumes: the full stack — `EventLog`, `createMemory`, `createDbosPort` with `stepTools`, a fake provider/executor that emits `tool_call`s for `memory_write` then `memory_read` (follow `packages/kernel/src/execution/vault-run.test.ts` and `plugins/executor-api-loop/src/loop.test.ts` for the fake-run harness).

- [ ] **Step 1: Write the integration test**

Drive a two-step plan through the real port with a fake executor:
1. Step A calls the injected `memory_write` tool with a note.
2. Step B (depends on A) calls `memory_search`/`memory_read` and asserts it receives A's note back.

Assert end state: the `memory_written` event is in the log with null `taskId` and agent provenance; SurrealDB has the note; `vault/memory/<id>.md` exists with correct frontmatter. Use `createTestDb` + `createTestSurreal`; allow a short `Bun.sleep` for the projector flush before the assertions.

```ts
// skeleton — fill executor/plan harness from vault-run.test.ts
it('step B reuses the note step A wrote (end-to-end)', async () => {
  // ... build log, memory, port with stepTools, approve a 2-step plan, startRun, wait ...
  // await Bun.sleep(200)
  // expect((await memory.store.get('finding-x'))?.title).toBe('Finding X')
  // expect(existsSync(path.join(config.vaultDir, 'memory', 'finding-x.md'))).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails, implement the harness wiring, run until green**

Run: `bun run db:up && bun test <path>`
Expected: PASS once the fake executor emits the two tool calls and the port injects the memory tools.

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: whole suite PASS, no type errors.

- [ ] **Step 4: Commit**
```bash
git add <path>
git commit -m "test(memory): end-to-end reuse proof — step B reads step A's note"
```

---

## Self-Review

**Spec coverage:**
- RM1 reuse → Task 10 (proof), Tasks 7/8 (tools). ✓
- RM2 tombstone/immutable history → Tasks 1 (`memory_deleted`), 6 (`applyDeleted` + rebuild keeps deletes). ✓
- RM3 scale (off global lock; no fold-per-read) → Task 7 (`log.append`, asserted), Task 4 (SurrealDB reads). ✓
- RM4 SoC/rebuildable → Task 6 (`rebuild`), Task 4 (`clear`), Task 3 (`projectDbUrl` own boundary). ✓
- RM5 single-writer wrapper → Task 7. ✓
- RM6 provenance sourced + read-obs unsourced → Task 4 (`createdBy/updatedBy/revision`; `lastReadAt/readCount` SurrealDB-only), Task 5 (Tier-2 excluded from frontmatter). ✓
- RM7 readable OKF format → Task 5. ✓
- Spec §4.3 cursor reconcile → Task 6 (`drainFrom(seq > cursor)`). ✓
- Spec D3 nullable taskId + guards → Tasks 1, 2. ✓
- Spec D6 pull tools, keyword now → Tasks 8, 4 (CONTAINS search). ✓
- Spec D7 projection-only vault → Task 6 (no parse-back; CLI is the human write path, Task 9). ✓
- Spec §7 SurrealDB service + config + CLI → Tasks 3, 9. ✓
- Deferred (semantic vectors, push, bidirectional editing) → not in any task, by design. ✓

**Placeholder scan:** Task 10's test is a skeleton by necessity (it depends on the repo's fake-run harness, which the implementer must match) — every other step ships complete code. The skeleton is bounded with explicit "fill from vault-run.test.ts" instructions, not a bare TODO.

**Type consistency:** `MemoryNoteInput`/`MemoryNote`/`MemoryAuthor`/`NoteSummary`/`MemoryFilter`/`MemoryStore` names are identical across Tasks 1, 4, 7, 8. `applyWritten`/`applyDeleted`/`get`/`list`/`search`/`bumpRead`/`getCursor`/`setCursor`/`clear`/`close` match between Task 4 (definition) and Task 6/7 (callers). `composeAuthor` defined in Task 1, used in Task 4. `stepTools` context shape (`{taskId,stepId,runToken,role,executor,model}`) matches between Task 8's `dbos-port` edit and the runtime wiring.
