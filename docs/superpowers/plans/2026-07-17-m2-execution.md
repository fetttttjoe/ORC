# M2 Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approved plans execute: a frozen DAG runs across real models (Anthropic/OpenAI/Ollama) on durable DBOS workflows over compose-managed Postgres, with full event-log traceability, typed signals, cost accounting, and kill‑9 resume — driven by `orc run`.

**Architecture:** The M1 event-sourced kernel migrates from `bun:sqlite` to Postgres (Drizzle driver swap; everything goes async; transactions thread a tx handle). DBOS Transact provides durability behind an `ExecutionPort`: one deterministic run-workflow per task walks the frozen plan in waves and enqueues step-workflows on a concurrency-capped queue; every event append happens inside the durable step that produced it. The `api-loop` executor owns a manual `generateText` loop (tools declared without `execute`), wrapping each model call and tool batch in a `checkpoint()` capability the port provides. Providers are plugin-style packages behind the `ModelProvider` contract.

**Tech Stack:** Bun ≥ 1.2, TypeScript strict, zod, Drizzle ORM (`drizzle-orm/node-postgres` + `pg`), drizzle-kit migrations, `@dbos-inc/dbos-sdk` ^4.23, `ai` ^7, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `ai-sdk-ollama` ^4, commander, docker compose (`postgres:16-alpine`).

**Spec:** `docs/superpowers/specs/2026-07-17-m2-execution-design.md` (amends `2026-07-16-orchestrator-design.md`)

## Global Constraints

- Bun ≥ 1.2 is package manager, runtime, AND test runner. No Node-specific tooling (no tsx, no vitest, no pnpm).
- TypeScript everywhere, strict. `moduleResolution: "bundler"`, extensionless relative imports, `noEmit`. ESM only (`"type": "module"`).
- `@orc/contracts` has exactly ONE runtime dependency: `zod`. Provider/AI-SDK types enter contracts only via generics (`ModelProvider<LM = unknown>`), never via imports.
- **Postgres required:** `docker compose up -d` must be running for every `orc` command and every integration test. Spec D1. Compose maps host port **5433**; default URL `postgresql://postgres:orc@localhost:5433/orc`; env override `ORC_DATABASE_URL`.
- Every state change is an event append through `EventLog`; in M2 execution code, **every append happens inside a durable step** (spec §6.2 append-inside-checkpoint rule) — never in a workflow function body.
- All SQL through Drizzle; `packages/kernel/src/schema.ts` is the single source of truth; drizzle-kit migrations committed. Driver: `drizzle-orm/node-postgres`.
- No scattered strings: production code references matched values only via const maps derived from zod enums — existing `TASK_STATUS`, `EVENT_KIND`, `ISOLATION_TIER`, `KERNEL_ERROR_CODE`, plus new `SIGNAL_OUTCOME`, `FAILURE_CLASS`, `RUN_OUTCOME`, `UNIFIED_EVENT_TYPE`, `STEP_RUN_STATUS`, and the executor's `TOOL_NAME`. Test fixtures exempt.
- Event kinds after M2: `task_created | plan_proposed | plan_edited | plan_approved | task_status_changed | run_started | step_started | agent_call | tool_call | tool_result | signal_received | step_completed | step_failed`.
- DBOS rules (spec §2, D7, §4): DBOS is never bundled (`bun run` only, never `bun build`); workflow functions are deterministic — no `Date.now()`, `Math.random()`, `randomUUID()`, or un-checkpointed DB reads in workflow bodies; steps are at-least-once; `DBOS__APPVERSION` pinned to the orc app version.
- `runToken` **is** the step workflowID (`step:<taskId>:<stepId>:a<attempt>`); fold dedups crash-boundary duplicates by `(runToken, kind, iteration?, toolCallId?)`.
- Secrets via env only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`); never in events, config files, or the DB.
- Tests colocated `packages/*/src/**/*.test.ts` and `plugins/*/src/*.test.ts`, `bun:test`, run with `bun test` from repo root. Integration tests create/drop ephemeral databases via `@orc/kernel/test-helpers`.
- Commit style: Conventional Commits, single-line subject, max 2 lines total, NO AI attribution or trailers of any kind.
- Version pins on install: `ai@^7`, `@ai-sdk/anthropic` / `@ai-sdk/openai` (current majors compatible with ai@7), `ai-sdk-ollama@^4`, `@dbos-inc/dbos-sdk@^4.23`, `pg@^8`. If an API named in this plan has drifted in the installed version, adapt to the installed API and note it in your report — the tests are the contract, not the exact call names.

## Milestone Roadmap (context)

- **M2 (this plan):** Postgres migration, ExecutionPort on DBOS, DAG interpreter, api-loop executor, providers, signals, CLI run/retry/cancel/status, resume test.
- **M3:** Plugin host (SKILL.md watcher, MCP client, T2 extensions). **M4:** Vault projection. **M5:** Recursion, strategies, claude-code adapter, worktree sandbox, zones, mid-run gates (`DBOS.send/recv`).

---

### Task 1: Compose Postgres + EventLog on node-postgres

**Files:**
- Create: `docker-compose.yml` (repo root)
- Modify: `packages/kernel/drizzle.config.ts`, `packages/kernel/src/schema.ts`, `packages/kernel/src/eventlog.ts`, `packages/kernel/package.json`
- Delete: `packages/kernel/drizzle/` (sqlite migrations — regenerated for pg)
- Create: `packages/kernel/src/test-helpers.ts`
- Create (generated): `packages/kernel/drizzle/0000_*.sql` + `meta/`
- Test: `packages/kernel/src/eventlog.test.ts` (rewrite)

**Interfaces:**
- Consumes: `EventInput`, `PAYLOAD_SCHEMAS`, `EventRecord` from `@orc/contracts` (unchanged in this task).
- Produces:
  - `interface EventLogOps { append(input: EventInput): Promise<EventRecord>; byTask(taskId: string): Promise<EventRecord[]>; all(): Promise<EventRecord[]> }`
  - `class EventLog implements EventLogOps { static open(url: string): Promise<EventLog>; transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T>; close(): Promise<void> }`
  - `createTestDb(): Promise<{ url: string; drop(): Promise<void> }>` from `@orc/kernel/test-helpers` — used by every integration test in this plan.
  - `events` table on pg: identity `seq`, `jsonb` payload, nullable `jsonb` usage column (typed in Task 4), `timestamptz` ts.

- [ ] **Step 1: Write compose file and start the stack**

`docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: orc
      POSTGRES_DB: orc
    ports:
      - "5433:5432"
    volumes:
      - orc-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 2s
      timeout: 3s
      retries: 30
volumes:
  orc-pgdata:
```

Add to root `package.json` scripts: `"db:up": "docker compose up -d --wait"`.

Run: `docker compose up -d --wait && docker compose ps`
Expected: postgres service healthy on port 5433.

- [ ] **Step 2: Swap deps**

```bash
cd packages/kernel && bun add pg && bun add -d @types/pg && cd ../..
bun install
```
`drizzle-orm` and root-level `drizzle-kit` stay. `bun:sqlite` needs no removal (built-in), but all imports of it disappear in this task.

- [ ] **Step 3: Write the failing test (rewrite eventlog.test.ts)**

`packages/kernel/src/eventlog.test.ts` — replace entire file:
```ts
import { afterAll, describe, expect, it } from 'bun:test'
import type { EventInput } from '@orc/contracts'
import { EventLog } from './eventlog'
import { createTestDb } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
})

async function freshLog(): Promise<EventLog> {
  const db = await createTestDb()
  dbs.push(db)
  return EventLog.open(db.url)
}

const statusEvent = (taskId = 't1'): EventInput => ({
  taskId, stepId: null, runToken: null,
  kind: 'task_status_changed',
  payload: { taskId, from: 'draft', to: 'awaiting_approval' },
})

describe('EventLog (postgres)', () => {
  it('appends with monotonic seq and ISO timestamp', async () => {
    const log = await freshLog()
    const a = await log.append(statusEvent())
    const b = await log.append(statusEvent())
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await log.close()
  })

  it('rejects payloads that do not match the kind schema', async () => {
    const log = await freshLog()
    await expect(log.append({ ...statusEvent(), payload: { wrong: true } })).rejects.toThrow()
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })

  it('filters by task and orders by seq', async () => {
    const log = await freshLog()
    await log.append(statusEvent('t1'))
    await log.append(statusEvent('t2'))
    await log.append(statusEvent('t1'))
    expect((await log.byTask('t1')).map(e => e.seq)).toEqual([1, 3])
    await log.close()
  })

  it('transaction rolls back atomically on error', async () => {
    const log = await freshLog()
    await expect(
      log.transaction(async tx => {
        await tx.append(statusEvent())
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await log.all()).toHaveLength(0)
    await log.close()
  })

  it('transaction reads see writes made inside the same transaction', async () => {
    const log = await freshLog()
    const count = await log.transaction(async tx => {
      await tx.append(statusEvent())
      return (await tx.all()).length
    })
    expect(count).toBe(1)
    await log.close()
  })

  it('persists across reopen (migrations are idempotent)', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = await EventLog.open(db.url)
    await log.append(statusEvent())
    await log.close()
    const reopened = await EventLog.open(db.url)
    expect(await reopened.all()).toHaveLength(1)
    await reopened.close()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test packages/kernel/src/eventlog.test.ts`
Expected: FAIL — cannot resolve `./test-helpers`; `EventLog.open` not a function.

- [ ] **Step 5: Implement schema, config, test helper, EventLog**

`packages/kernel/drizzle.config.ts` — replace:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
})
```

`packages/kernel/src/schema.ts` — replace:
```ts
import { bigint, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import type { EventKind } from '@orc/contracts'

export const events = pgTable(
  'events',
  {
    seq: bigint('seq', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: text('task_id').notNull(),
    stepId: text('step_id'),
    runToken: text('run_token'),
    kind: text('kind').$type<EventKind>().notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    ts: timestamp('ts', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  t => [index('idx_events_task').on(t.taskId)],
)
```

Delete the old sqlite migrations and regenerate:
```bash
rm -rf packages/kernel/drizzle
cd packages/kernel && bunx drizzle-kit generate && cd ../..
```
Expected: `packages/kernel/drizzle/0000_*.sql` + `meta/` created for pg. Commit these with the task.

`packages/kernel/src/test-helpers.ts`:
```ts
import { Client } from 'pg'

const ADMIN_URL = process.env.ORC_DATABASE_URL ?? 'postgresql://postgres:orc@localhost:5433/orc'

// ponytail: test-only helper; ephemeral DB per test file, dropped after
export async function createTestDb(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new Client({ connectionString: ADMIN_URL })
  await admin.connect()
  const name = `orc_test_${Math.random().toString(36).slice(2, 10)}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${name}`
  return {
    url: url.toString(),
    drop: async () => {
      // also drop the DBOS system DB a port test may have auto-created
      await admin.query(`DROP DATABASE IF EXISTS ${name}_dbos_sys WITH (FORCE)`)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    },
  }
}
```

`packages/kernel/src/eventlog.ts` — replace:
```ts
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { asc, eq } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { EventInput, PAYLOAD_SCHEMAS, type EventRecord } from '@orc/contracts'
import { events } from './schema'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url))

type Row = typeof events.$inferSelect
type Queryable = Pick<NodePgDatabase, 'insert' | 'select'>

const toRecord = (r: Row): EventRecord => ({
  seq: r.seq,
  taskId: r.taskId,
  stepId: r.stepId,
  runToken: r.runToken,
  kind: r.kind,
  payload: r.payload,
  ts: r.ts.toISOString(),
})

export interface EventLogOps {
  append(input: EventInput): Promise<EventRecord>
  byTask(taskId: string): Promise<EventRecord[]>
  all(): Promise<EventRecord[]>
}

const makeOps = (db: Queryable): EventLogOps => ({
  async append(input) {
    const parsed = EventInput.parse(input)
    PAYLOAD_SCHEMAS[parsed.kind].parse(parsed.payload)
    const [row] = await db
      .insert(events)
      .values({
        taskId: parsed.taskId,
        stepId: parsed.stepId,
        runToken: parsed.runToken,
        kind: parsed.kind,
        payload: parsed.payload,
      })
      .returning({ seq: events.seq, ts: events.ts })
    return { ...parsed, seq: row!.seq, ts: row!.ts.toISOString() }
  },
  async byTask(taskId) {
    const rows = await db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.seq))
    return rows.map(toRecord)
  },
  async all() {
    const rows = await db.select().from(events).orderBy(asc(events.seq))
    return rows.map(toRecord)
  },
})

export class EventLog implements EventLogOps {
  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: NodePgDatabase,
    private readonly ops: EventLogOps,
  ) {}

  static async open(url: string): Promise<EventLog> {
    const pool = new pg.Pool({ connectionString: url })
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    return new EventLog(pool, db, makeOps(db))
  }

  append(input: EventInput): Promise<EventRecord> {
    return this.ops.append(input)
  }
  byTask(taskId: string): Promise<EventRecord[]> {
    return this.ops.byTask(taskId)
  }
  all(): Promise<EventRecord[]> {
    return this.ops.all()
  }

  // reads/appends inside fn MUST go through tx — pool queries would escape the transaction (spec §4)
  transaction<T>(fn: (tx: EventLogOps) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => fn(makeOps(tx as unknown as Queryable)))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
```

Add to `packages/kernel/package.json` exports:
```json
"exports": {
  ".": "./src/index.ts",
  "./test-helpers": "./src/test-helpers.ts"
}
```

- [ ] **Step 6: Run tests to verify green (kernel/eventlog only — kernel.ts/cli still broken)**

Run: `bun test packages/kernel/src/eventlog.test.ts`
Expected: 6 tests PASS. (`bun run typecheck` and the other suites are expected RED until Tasks 2–3 — the async ripple is mid-flight; do NOT commit a broken root `bun test`; Tasks 1–3 land as three commits in one working session, verify the full suite at Task 3.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: event log on compose Postgres via drizzle node-postgres"
```

---

### Task 2: Kernel async + transaction threading

**Files:**
- Modify: `packages/kernel/src/kernel.ts`, `packages/kernel/src/kernel.test.ts`, `packages/kernel/src/replay.test.ts`
- (No contract changes.)

**Interfaces:**
- Consumes: `EventLog`, `EventLogOps` (Task 1), `fold` (unchanged M1).
- Produces (all methods now async; helpers thread `EventLogOps`):
  - `class Kernel { constructor(log: EventLog); createTask(input): Promise<TaskNode>; proposePlan(taskId, draft): Promise<Plan>; editPlan(taskId, draft): Promise<Plan>; approvePlan(taskId, version?): Promise<Plan>; state(): Promise<State>; getTask(id): Promise<TaskNode | undefined>; listTasks(): Promise<TaskNode[]>; getPlan(taskId, version?): Promise<Plan | undefined>; eventsFor(taskId): Promise<EventRecord[]> }`

- [ ] **Step 1: Update the tests (kernel.test.ts + replay.test.ts) to async + ephemeral DBs**

`packages/kernel/src/kernel.test.ts` — replace the setup and make every test async. Full new setup block (the 7 test bodies keep their M1 assertions, each gaining `await` on every kernel call):
```ts
import { afterAll, describe, expect, it } from 'bun:test'
import { TASK_STATUS, type PlanDraft } from '@orc/contracts'
import { EventLog } from './eventlog'
import { KERNEL_ERROR_CODE, KernelError } from './errors'
import { Kernel } from './kernel'
import { createTestDb } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
})

async function freshKernel(): Promise<Kernel> {
  const db = await createTestDb()
  dbs.push(db)
  return new Kernel(await EventLog.open(db.url))
}

const draft = (): PlanDraft => ({
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 't', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'm', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
  }],
})

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'no_error'
  } catch (e) {
    return e instanceof KernelError ? e.code : `unexpected:${String(e)}`
  }
}
```
Example of one converted test (apply the same mechanical conversion to all seven M1 tests):
```ts
it('rejects approving a stale version', async () => {
  const k = await freshKernel()
  const t = await k.createTask({ title: 'x' })
  await k.proposePlan(t.id, draft())
  await k.editPlan(t.id, draft())
  expect(await codeOf(k.approvePlan(t.id, 1))).toBe(KERNEL_ERROR_CODE.version_conflict)
})
```

`packages/kernel/src/replay.test.ts` — same conversion: `createTestDb()` per test instead of tmpdir paths, `await EventLog.open(url)`, `await` on all kernel calls and `state()`, `await log.close()` where M1 called `log.close()`. Reopen uses the same `db.url`. The three test names and their assertions are unchanged — the replay guarantee must survive the driver swap verbatim.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/kernel/src/kernel.test.ts`
Expected: FAIL — kernel methods return non-promises / type errors (sync kernel against async EventLog).

- [ ] **Step 3: Rewrite kernel.ts (async, tx-threaded)**

`packages/kernel/src/kernel.ts` — replace:
```ts
import { randomUUID } from 'node:crypto'
import {
  EVENT_KIND, PlanDraft, TASK_STATUS, validatePlan,
  type EventKind, type EventRecord, type Plan, type TaskNode, type TaskStatus,
} from '@orc/contracts'
import { EventLog, type EventLogOps } from './eventlog'
import { fold, type State } from './projections'
import { KERNEL_ERROR_CODE, KernelError } from './errors'

export class Kernel {
  constructor(private readonly log: EventLog) {}

  async createTask(input: { title: string; spec?: string; type?: string; parentId?: string; budgetUSD?: number | null }): Promise<TaskNode> {
    return this.log.transaction(async tx => {
      const parent = input.parentId ? await this.requireTask(tx, input.parentId) : null
      const task: TaskNode = {
        id: randomUUID(),
        parentId: parent?.id ?? null,
        type: input.type ?? 'generic',
        title: input.title,
        spec: input.spec ?? '',
        status: TASK_STATUS.draft,
        zone: [],
        budgetUSD: input.budgetUSD ?? parent?.budgetUSD ?? null,
        depth: parent ? parent.depth + 1 : 0,
        createdAt: new Date().toISOString(),
      }
      await this.append(tx, task.id, EVENT_KIND.task_created, { task })
      return task
    })
  }

  async proposePlan(taskId: string, draft: PlanDraft): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.draft)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot propose a plan while task is '${task.status}'`)
      return this.appendPlanVersion(tx, taskId, draft, EVENT_KIND.plan_proposed, task.status)
    })
  }

  async editPlan(taskId: string, draft: PlanDraft): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.awaiting_approval)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot edit a plan while task is '${task.status}'`)
      return this.appendPlanVersion(tx, taskId, draft, EVENT_KIND.plan_edited, task.status)
    })
  }

  async approvePlan(taskId: string, version?: number): Promise<Plan> {
    return this.log.transaction(async tx => {
      const task = await this.requireTask(tx, taskId)
      if (task.status !== TASK_STATUS.awaiting_approval)
        throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `cannot approve while task is '${task.status}'`)
      const latest = (await this.stateOf(tx)).plans.get(taskId)?.versions.at(-1)
      if (!latest) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, 'no plan to approve')
      const wanted = version ?? latest.version
      if (wanted !== latest.version)
        throw new KernelError(KERNEL_ERROR_CODE.version_conflict, `latest plan is v${latest.version}, not v${wanted}`)
      await this.append(tx, taskId, EVENT_KIND.plan_approved, {
        taskId, version: wanted, approvedAt: new Date().toISOString(),
      })
      await this.append(tx, taskId, EVENT_KIND.task_status_changed, { taskId, from: task.status, to: TASK_STATUS.approved })
      return latest
    })
  }

  // ponytail: state() refolds the whole log on every call — add snapshots when it measurably slows
  async state(): Promise<State> {
    return this.stateOf(this.log)
  }

  async getTask(id: string): Promise<TaskNode | undefined> {
    return (await this.state()).tasks.get(id)
  }

  async listTasks(): Promise<TaskNode[]> {
    return [...(await this.state()).tasks.values()]
  }

  async getPlan(taskId: string, version?: number): Promise<Plan | undefined> {
    const tp = (await this.state()).plans.get(taskId)
    if (!tp) return undefined
    return version === undefined ? tp.versions.at(-1) : tp.versions.find(p => p.version === version)
  }

  eventsFor(taskId: string): Promise<EventRecord[]> {
    return this.log.byTask(taskId)
  }

  private async stateOf(ops: EventLogOps): Promise<State> {
    return fold(await ops.all())
  }

  private async appendPlanVersion(
    tx: EventLogOps,
    taskId: string,
    draft: PlanDraft,
    kind: Extract<EventKind, 'plan_proposed' | 'plan_edited'>,
    from: TaskStatus,
  ): Promise<Plan> {
    const versions = (await this.stateOf(tx)).plans.get(taskId)?.versions ?? []
    const plan: Plan = { ...PlanDraft.parse(draft), taskId, version: versions.length + 1 }
    const check = validatePlan(plan)
    if (!check.ok) throw new KernelError(KERNEL_ERROR_CODE.plan_validation_failed, check.errors.join('; '))
    await this.append(tx, taskId, kind, { plan })
    if (from !== TASK_STATUS.awaiting_approval)
      await this.append(tx, taskId, EVENT_KIND.task_status_changed, { taskId, from, to: TASK_STATUS.awaiting_approval })
    return plan
  }

  private async append(ops: EventLogOps, taskId: string, kind: EventKind, payload: Record<string, unknown>): Promise<void> {
    await ops.append({ taskId, stepId: null, runToken: null, kind, payload })
  }

  private async requireTask(ops: EventLogOps, id: string): Promise<TaskNode> {
    const t = (await this.stateOf(ops)).tasks.get(id)
    if (!t) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${id}'`)
    return t
  }
}
```

- [ ] **Step 4: Run kernel + replay + projections tests**

Run: `bun test packages/kernel`
Expected: eventlog (6), kernel (7), replay (3), projections (3) — all PASS. CLI tests still RED (Task 3).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: async kernel with tx-threaded reads (postgres atomicity)"
```

---

### Task 3: CLI async + friendly Postgres-down error

**Files:**
- Modify: `packages/cli/src/main.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/main.test.ts`

**Interfaces:**
- Consumes: async `Kernel`, `EventLog.open`, `createTestDb`.
- Produces: `openKernel(url?: string): Promise<Kernel>` (URL, not directory — `.orc/state.db` is gone), all command actions async, `isConnectionRefused(err: unknown): boolean` exported for bin.ts.

- [ ] **Step 1: Update the test**

`packages/cli/src/main.test.ts` — replace setup; the three M1 test bodies keep their assertions with `await` added:
```ts
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { EVENT_KIND } from '@orc/contracts'
import { createTestDb } from '@orc/kernel/test-helpers'
import { buildProgram, openKernel } from './main'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
})

async function makeCli() {
  const db = await createTestDb()
  dbs.push(db)
  const kernel = await openKernel(db.url)
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '))
  })
  const run = async (...args: string[]) => {
    await buildProgram(kernel).parseAsync(args, { from: 'user' })
    return lines
  }
  return { run, lines }
}

afterEach(() => {
  mock.restore()
})
```
All three M1 tests (`new → propose → approve → log round-trip`, `plan prints the plan as JSON`, `tasks lists id, status and title`) become `const { run, lines } = await makeCli()` — bodies otherwise unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli`
Expected: FAIL — `openKernel` signature mismatch / sync kernel calls.

- [ ] **Step 3: Implement**

`packages/cli/src/main.ts` — changes:

Replace the imports of `mkdirSync`/`path` usage and `openKernel`:
```ts
import { readFileSync } from 'node:fs'
import { Command } from 'commander'
import { ISOLATION_TIER, PlanDraft } from '@orc/contracts'
import { EventLog, Kernel } from '@orc/kernel'

export const DEFAULT_DATABASE_URL = 'postgresql://postgres:orc@localhost:5433/orc'

export async function openKernel(url = process.env.ORC_DATABASE_URL ?? DEFAULT_DATABASE_URL): Promise<Kernel> {
  return new Kernel(await EventLog.open(url))
}

export function isConnectionRefused(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.some(isConnectionRefused)
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ECONNREFUSED'
}
```
`singleStepDraft` and `resolveDraft` are unchanged. Every `.action(...)` becomes `async` and awaits kernel calls, e.g.:
```ts
.action(async (title: string, opts: { spec: string; parent?: string }) => {
  const t = await kernel.createTask({ title, spec: opts.spec, parentId: opts.parent })
  console.log(t.id)
})
```
Apply the same mechanical change to `propose`, `edit`, `plan`, `approve`, `tasks`, `log` actions (each `kernel.*` call gains `await`).

`packages/cli/src/bin.ts` — replace:
```ts
import { buildProgram, isConnectionRefused, openKernel, DEFAULT_DATABASE_URL } from './main'

try {
  const kernel = await openKernel()
  await buildProgram(kernel).parseAsync(process.argv)
  process.exit(0)
} catch (err) {
  if (isConnectionRefused(err)) {
    const url = process.env.ORC_DATABASE_URL ?? DEFAULT_DATABASE_URL
    console.error(`Postgres is not reachable at ${url} — start it with: docker compose up -d`)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
}
```
(`process.exit(0)` on success: the pg pool would otherwise keep the process alive.)

- [ ] **Step 4: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: full suite PASS (~33 tests across contracts + kernel + cli), typecheck clean. This closes the M1 async migration.

- [ ] **Step 5: Manual smoke test**

```bash
bun packages/cli/src/bin.ts new "pg smoke" --spec "prove the migration"
bun packages/cli/src/bin.ts propose <id> && bun packages/cli/src/bin.ts approve <id>
bun packages/cli/src/bin.ts log <id>
docker compose stop && bun packages/cli/src/bin.ts tasks; docker compose start
```
Expected: normal flow works against compose Postgres; the stopped-stack command prints the friendly `docker compose up -d` hint and exits 1.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: async CLI on Postgres with friendly stack-down error"
```

---

### Task 4: Execution contracts

**Files:**
- Create: `packages/contracts/src/execution.ts`
- Modify: `packages/contracts/src/events.ts`, `packages/contracts/src/index.ts`
- Modify: `packages/kernel/src/eventlog.ts` (persist/read the typed `usage` column)
- Test: `packages/contracts/src/execution.test.ts`

**Interfaces:**
- Consumes: `PlanStep` from `./plan`, `EventKind` from `./events`.
- Produces (the surface every later task imports):
  - `Usage` (zod + type), `addUsage(a: Usage, b: Usage): Usage`, `costUSDFor(costs: Record<string, ModelCost>, modelId: string, inputTokens: number, outputTokens: number): number | null` (checks exact modelId, then a `'*'` wildcard entry; null when neither exists)
  - `SignalOutcome`/`SIGNAL_OUTCOME`, `Signal` (zod: `{stepId, runToken, outcome, summary}`)
  - `FailureClass`/`FAILURE_CLASS` (`provider_error | agent_error | budget_exceeded | human_abort`)
  - `RunOutcome`/`RUN_OUTCOME` (`done | blocked | cancelled`), `StepRunStatus`/`STEP_RUN_STATUS` (`running | completed | failed`)
  - `UnifiedEventType`/`UNIFIED_EVENT_TYPE`, `UnifiedEvent` (zod discriminated union on `type`)
  - `ModelCost`, `ModelProviderManifest` (zod), `interface ModelProvider<LM = unknown> { manifest: ModelProviderManifest; languageModel(modelId: string): LM }`, `resolveModel<LM>(providers: Map<string, ModelProvider<LM>>, modelRef: string): { provider: ModelProvider<LM>; modelId: string; model: LM }` (splits on the FIRST `/`; throws Error with message containing `unknown provider` on a miss)
  - `type EventDraft = { kind: EventKind; payload: Record<string, unknown>; usage?: Usage | null }`, `type Checkpoint = <T>(name: string, fn: () => Promise<T>, toEvents?: (result: T) => EventDraft[]) => Promise<T>`
  - `interface ExecutorContext<LM = unknown> { step: PlanStep; taskSpec: string; depOutputs: Record<string, string>; model: LM; runToken: string; workspaceDir: string; checkpoint: Checkpoint; budgetRemainingUSD: () => Promise<number | null> }`
  - `ExecutorCapabilities` (zod: `{tools: boolean, streaming: boolean}`), `interface AgentExecutor<LM = unknown> { id: string; getCapabilities(): ExecutorCapabilities; startTurn(ctx: ExecutorContext<LM>): AsyncIterable<UnifiedEvent> }`
  - `interface RunHandle { workflowId: string; wait(): Promise<RunOutcome> }`, `interface ExecutionPort { startRun(taskId: string, opts?: { cwd?: string }): Promise<RunHandle>; retry(taskId: string, opts?: { cwd?: string }): Promise<RunHandle>; cancelRun(taskId: string): Promise<void>; runStatus(taskId: string): Promise<{ workflowId: string | null; dbosStatus: string | null }> }`
  - **events.ts:** `EventKind` extended with the 8 execution kinds + their `PAYLOAD_SCHEMAS`; `EventInput` gains `usage: Usage.nullable().optional()`; `EventRecord.usage: Usage | null`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/execution.test.ts`:
```ts
import { describe, expect, it } from 'bun:test'
import { EventKind, PAYLOAD_SCHEMAS } from './events'
import {
  addUsage, costUSDFor, resolveModel, Signal, UnifiedEvent,
  FAILURE_CLASS, SIGNAL_OUTCOME, type ModelProvider, type Usage,
} from './execution'

const usage = (i: number, o: number, cost: number | null = null, estimated = false): Usage =>
  ({ inputTokens: i, outputTokens: o, costUSD: cost, estimated })

describe('execution contracts', () => {
  it('has a payload schema for every event kind (incl. the 8 new ones)', () => {
    expect(EventKind.options).toContain('run_started')
    expect(EventKind.options).toContain('step_failed')
    for (const kind of EventKind.options) expect(PAYLOAD_SCHEMAS[kind]).toBeDefined()
  })

  it('step_failed payload requires a failure class', () => {
    expect(() => PAYLOAD_SCHEMAS.step_failed.parse({ stepId: 's', runToken: 'r', message: 'x' })).toThrow()
    expect(PAYLOAD_SCHEMAS.step_failed.parse({
      stepId: 's', runToken: 'r', class: FAILURE_CLASS.agent_error, message: 'x',
    })).toBeTruthy()
  })

  it('UnifiedEvent discriminates on type', () => {
    const ev = UnifiedEvent.parse({
      type: 'signal',
      signal: { stepId: 's1', runToken: 'rt', outcome: SIGNAL_OUTCOME.success, summary: 'done' },
    })
    expect(ev.type).toBe('signal')
    expect(() => UnifiedEvent.parse({ type: 'nope' })).toThrow()
  })

  it('addUsage sums defensively and taints estimates', () => {
    const sum = addUsage(usage(10, 5, 0.01), usage(1, 1, null, true))
    expect(sum.inputTokens).toBe(11)
    expect(sum.costUSD).toBe(0.01)
    expect(sum.estimated).toBe(true)
  })

  it('costUSDFor uses exact model, wildcard, then null', () => {
    const costs = { 'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 } }
    expect(costUSDFor(costs, 'claude-sonnet-5', 1_000_000, 1_000_000)).toBe(18)
    expect(costUSDFor(costs, 'unknown-model', 1000, 1000)).toBeNull()
    expect(costUSDFor({ '*': { inPerMTok: 0, outPerMTok: 0 } }, 'llama3', 5000, 5000)).toBe(0)
  })

  it('resolveModel splits on the first slash and errors on unknown providers', () => {
    const fake: ModelProvider<string> = {
      manifest: { id: 'ollama', providerKind: 'ollama', baseUrl: null, contextWindow: null, costs: {} },
      languageModel: id => `LM:${id}`,
    }
    const providers = new Map([['ollama', fake]])
    const r = resolveModel(providers, 'ollama/library/llama3')
    expect(r.modelId).toBe('library/llama3')
    expect(r.model).toBe('LM:library/llama3')
    expect(() => resolveModel(providers, 'nope/m')).toThrow(/unknown provider/)
  })

  it('Signal rejects an empty summary', () => {
    expect(() => Signal.parse({ stepId: 's', runToken: 'r', outcome: 'success', summary: '' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/contracts`
Expected: FAIL — cannot resolve `./execution`; `run_started` not in EventKind.

- [ ] **Step 3: Implement execution.ts**

`packages/contracts/src/execution.ts`:
```ts
import { z } from 'zod'
import type { PlanStep } from './plan'
import type { EventKind } from './events'

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUSD: z.number().nonnegative().nullable(),
  estimated: z.boolean(),
})
export type Usage = z.infer<typeof Usage>

export function addUsage(a: Usage, b: Usage): Usage {
  const costs = [a.costUSD, b.costUSD].filter((c): c is number => c !== null)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUSD: costs.length > 0 ? costs.reduce((x, y) => x + y, 0) : null,
    estimated: a.estimated || b.estimated,
  }
}

export const ModelCost = z.object({
  inPerMTok: z.number().nonnegative(),
  outPerMTok: z.number().nonnegative(),
})
export type ModelCost = z.infer<typeof ModelCost>

export function costUSDFor(
  costs: Record<string, ModelCost>,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const c = costs[modelId] ?? costs['*']
  if (!c) return null
  return (inputTokens * c.inPerMTok + outputTokens * c.outPerMTok) / 1_000_000
}

export const SignalOutcome = z.enum(['success', 'failure'])
export type SignalOutcome = z.infer<typeof SignalOutcome>
export const SIGNAL_OUTCOME = SignalOutcome.enum

export const Signal = z.object({
  stepId: z.string().min(1),
  runToken: z.string().min(1),
  outcome: SignalOutcome,
  summary: z.string().min(1),
})
export type Signal = z.infer<typeof Signal>

export const FailureClass = z.enum(['provider_error', 'agent_error', 'budget_exceeded', 'human_abort'])
export type FailureClass = z.infer<typeof FailureClass>
export const FAILURE_CLASS = FailureClass.enum

export const RunOutcome = z.enum(['done', 'blocked', 'cancelled'])
export type RunOutcome = z.infer<typeof RunOutcome>
export const RUN_OUTCOME = RunOutcome.enum

export const StepRunStatus = z.enum(['running', 'completed', 'failed'])
export type StepRunStatus = z.infer<typeof StepRunStatus>
export const STEP_RUN_STATUS = StepRunStatus.enum

export const UnifiedEventType = z.enum(['text', 'tool_call', 'tool_result', 'usage', 'signal', 'error', 'done'])
export type UnifiedEventType = z.infer<typeof UnifiedEventType>
export const UNIFIED_EVENT_TYPE = UnifiedEventType.enum

export const UnifiedEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), raw: z.unknown().optional() }),
  z.object({ type: z.literal('tool_call'), toolCallId: z.string(), toolName: z.string(), input: z.unknown(), raw: z.unknown().optional() }),
  z.object({ type: z.literal('tool_result'), toolCallId: z.string(), toolName: z.string(), output: z.unknown(), isError: z.boolean(), raw: z.unknown().optional() }),
  z.object({ type: z.literal('usage'), usage: Usage, raw: z.unknown().optional() }),
  z.object({ type: z.literal('signal'), signal: Signal, raw: z.unknown().optional() }),
  z.object({ type: z.literal('error'), class: FailureClass, message: z.string(), raw: z.unknown().optional() }),
  z.object({ type: z.literal('done'), raw: z.unknown().optional() }),
])
export type UnifiedEvent = z.infer<typeof UnifiedEvent>

export const ModelProviderManifest = z.object({
  id: z.string().min(1),
  providerKind: z.string().min(1),
  baseUrl: z.string().nullable(),
  contextWindow: z.number().int().positive().nullable(),
  costs: z.record(z.string(), ModelCost),
})
export type ModelProviderManifest = z.infer<typeof ModelProviderManifest>

export interface ModelProvider<LM = unknown> {
  manifest: ModelProviderManifest
  languageModel(modelId: string): LM
}

export function resolveModel<LM>(
  providers: Map<string, ModelProvider<LM>>,
  modelRef: string,
): { provider: ModelProvider<LM>; modelId: string; model: LM } {
  const slash = modelRef.indexOf('/')
  const providerId = slash === -1 ? modelRef : modelRef.slice(0, slash)
  const modelId = slash === -1 ? '' : modelRef.slice(slash + 1)
  const provider = providers.get(providerId)
  if (!provider || modelId === '')
    throw new Error(`unknown provider or malformed modelRef '${modelRef}' (expected 'provider/model')`)
  return { provider, modelId, model: provider.languageModel(modelId) }
}

export type EventDraft = { kind: EventKind; payload: Record<string, unknown>; usage?: Usage | null }
export type Checkpoint = <T>(name: string, fn: () => Promise<T>, toEvents?: (result: T) => EventDraft[]) => Promise<T>

export interface ExecutorContext<LM = unknown> {
  step: PlanStep
  taskSpec: string
  depOutputs: Record<string, string>
  model: LM
  runToken: string
  workspaceDir: string
  checkpoint: Checkpoint
  budgetRemainingUSD: () => Promise<number | null>
}

export const ExecutorCapabilities = z.object({ tools: z.boolean(), streaming: z.boolean() })
export type ExecutorCapabilities = z.infer<typeof ExecutorCapabilities>

export interface AgentExecutor<LM = unknown> {
  id: string
  getCapabilities(): ExecutorCapabilities
  startTurn(ctx: ExecutorContext<LM>): AsyncIterable<UnifiedEvent>
}

export interface RunHandle {
  workflowId: string
  wait(): Promise<RunOutcome>
}

export interface ExecutionPort {
  startRun(taskId: string, opts?: { cwd?: string }): Promise<RunHandle>
  retry(taskId: string, opts?: { cwd?: string }): Promise<RunHandle>
  cancelRun(taskId: string): Promise<void>
  runStatus(taskId: string): Promise<{ workflowId: string | null; dbosStatus: string | null }>
}
```

`packages/contracts/src/events.ts` — replace the `EventKind` enum, extend `PAYLOAD_SCHEMAS`, extend the envelope:
```ts
import { z } from 'zod'
import { TaskNode, TaskStatus } from './task'
import { Plan } from './plan'
import { FailureClass, Signal, Usage } from './execution'

export const EventKind = z.enum([
  'task_created', 'plan_proposed', 'plan_edited', 'plan_approved', 'task_status_changed',
  'run_started', 'step_started', 'agent_call', 'tool_call', 'tool_result',
  'signal_received', 'step_completed', 'step_failed',
])
export type EventKind = z.infer<typeof EventKind>

export const EVENT_KIND = EventKind.enum

export const PAYLOAD_SCHEMAS: Record<EventKind, z.ZodType> = {
  task_created: z.object({ task: TaskNode }),
  plan_proposed: z.object({ plan: Plan }),
  plan_edited: z.object({ plan: Plan }),
  plan_approved: z.object({
    taskId: z.string().min(1),
    version: z.number().int().positive(),
    approvedAt: z.string(),
  }),
  task_status_changed: z.object({ taskId: z.string().min(1), from: TaskStatus, to: TaskStatus }),
  run_started: z.object({
    taskId: z.string().min(1),
    planVersion: z.number().int().positive(),
    retryIndex: z.number().int().nonnegative(),
    workflowId: z.string().min(1),
    cwd: z.string().nullable(),
  }),
  step_started: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    attempt: z.number().int().positive(),
  }),
  agent_call: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    iteration: z.number().int().positive(),
    request: z.unknown(),
    response: z.unknown(),
  }),
  tool_call: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    iteration: z.number().int().positive(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
  }),
  tool_result: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    iteration: z.number().int().positive(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    output: z.unknown(),
    isError: z.boolean(),
  }),
  signal_received: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    signal: Signal,
  }),
  step_completed: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    summary: z.string(),
  }),
  step_failed: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    class: FailureClass,
    message: z.string(),
  }),
}

export const EventInput = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1).nullable(),
  runToken: z.string().min(1).nullable(),
  kind: EventKind,
  payload: z.record(z.string(), z.unknown()),
  usage: Usage.nullable().optional(),
})
export type EventInput = z.infer<typeof EventInput>

export interface EventRecord extends Omit<EventInput, 'usage'> {
  seq: number
  ts: string
  usage: Usage | null
}
```

Append to `packages/contracts/src/index.ts`:
```ts
export * from './execution'
```

`packages/kernel/src/eventlog.ts` — three edits to `makeOps` so the usage column round-trips:
1. in `append`, add `usage: parsed.usage ?? null,` to the `.values({...})` object;
2. in `append`'s return, replace `{ ...parsed, seq: …, ts: … }` with `{ ...parsed, usage: parsed.usage ?? null, seq: row!.seq, ts: row!.ts.toISOString() }` (EventRecord.usage is `Usage | null`, never undefined);
3. in `toRecord`, add `usage: (r.usage as EventRecord['usage']) ?? null,`.
(The `events.usage` column already exists from Task 1 — no new migration.)

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test && bun run typecheck`
Expected: full suite PASS (~40 tests), typecheck clean. If typecheck flags M1 tests constructing `EventRecord` literals (projections/fold fixtures), add `usage: null` to those fixture objects.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: execution contracts — UnifiedEvent, Signal, providers, ExecutionPort, event kinds"
```

---

### Task 5: fold() execution projections + crash-boundary dedup

**Files:**
- Modify: `packages/kernel/src/projections.ts`
- Test: `packages/kernel/src/projections.test.ts` (extend)

**Interfaces:**
- Consumes: new contracts (Task 4).
- Produces:
  - `interface StepState { stepId: string; runToken: string; attempt: number; status: StepRunStatus; iterations: number; output: string | null; failure: { class: FailureClass; message: string } | null }`
  - `interface RunRecord { planVersion: number; retryIndex: number; workflowId: string; cwd: string | null }`
  - `State` extended: `steps: Map<string, Map<string, StepState>>` (taskId → stepId → latest-attempt state), `runs: Map<string, RunRecord[]>`, `usage: Map<string, Usage>` (per-task totals)
  - Pure helpers used by the port and CLI: `completedStepIds(state: State, taskId: string): Set<string>`, `nextAttempts(state: State, taskId: string, plan: Plan): Record<string, number>` (per step: latest attempt if it is `running` — resume — else latest attempt + 1; 1 when never started), `taskUsage(state: State, taskId: string): Usage`

- [ ] **Step 1: Extend the test**

Append to `packages/kernel/src/projections.test.ts` (keep the M1 tests; add `usage: null` to the `evt` fixture helper's returned object):
```ts
import { completedStepIds, nextAttempts } from './projections'

const rt = (step: string, attempt = 1) => `step:t1:${step}:a${attempt}`

const exEvt = (
  seq: number,
  kind: EventRecord['kind'],
  payload: Record<string, unknown>,
  usage: EventRecord['usage'] = null,
): EventRecord =>
  ({ seq, ts: '2026-07-17T00:00:00.000Z', taskId: 't1', stepId: 's1', runToken: rt('s1'), kind, payload, usage })

describe('fold — execution kinds', () => {
  it('projects step lifecycle and per-task usage', () => {
    const state = fold([
      exEvt(1, 'run_started', { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null }),
      exEvt(2, 'step_started', { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      exEvt(3, 'agent_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
        { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false }),
      exEvt(4, 'signal_received', { stepId: 's1', runToken: rt('s1'), signal: { stepId: 's1', runToken: rt('s1'), outcome: 'success', summary: 'ok' } }),
      exEvt(5, 'step_completed', { stepId: 's1', runToken: rt('s1'), summary: 'ok' }),
    ])
    const step = state.steps.get('t1')?.get('s1')
    expect(step?.status).toBe('completed')
    expect(step?.output).toBe('ok')
    expect(step?.iterations).toBe(1)
    expect(state.runs.get('t1')).toHaveLength(1)
    expect(state.usage.get('t1')?.costUSD).toBeCloseTo(0.01)
    expect(completedStepIds(state, 't1')).toEqual(new Set(['s1']))
  })

  it('dedups crash-boundary duplicates by (runToken, kind, iteration, toolCallId)', () => {
    const dup = exEvt(3, 'agent_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
      { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false })
    const state = fold([
      exEvt(2, 'step_started', { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      dup,
      { ...dup, seq: 4 }, // crash-boundary replay of the same iteration
      exEvt(5, 'tool_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} }),
      exEvt(6, 'tool_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, toolCallId: 'c2', toolName: 'fs_read', input: {} }),
    ])
    expect(state.usage.get('t1')?.inputTokens).toBe(100) // counted once
    expect(state.steps.get('t1')?.get('s1')?.iterations).toBe(1)
    // two DISTINCT tool calls in one iteration both survive (toolCallId disambiguates)
  })

  it('failed attempt then fresh attempt: latest wins, nextAttempts increments', () => {
    const plan = { steps: [{ id: 's1' }, { id: 's2' }] } as never // only ids consulted
    const state = fold([
      exEvt(1, 'step_started', { stepId: 's1', runToken: rt('s1', 1), attempt: 1 }),
      exEvt(2, 'step_failed', { stepId: 's1', runToken: rt('s1', 1), class: 'agent_error', message: 'nope' }),
      exEvt(3, 'step_started', { stepId: 's1', runToken: rt('s1', 2), attempt: 2 }),
      exEvt(4, 'step_completed', { stepId: 's1', runToken: rt('s1', 2), summary: 'fixed' }),
    ])
    expect(state.steps.get('t1')?.get('s1')?.status).toBe('completed')
    expect(state.steps.get('t1')?.get('s1')?.attempt).toBe(2)
    expect(nextAttempts(state, 't1', plan)).toEqual({ s1: 3, s2: 1 })
  })
})
```
(Add the needed imports at the top of the file: `fold, completedStepIds, nextAttempts` and `type EventRecord`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/kernel/src/projections.test.ts`
Expected: FAIL — `steps`/`runs`/`usage` not on `State`; helpers missing.

- [ ] **Step 3: Implement**

`packages/kernel/src/projections.ts` — replace:
```ts
import { EVENT_KIND, STEP_RUN_STATUS, addUsage } from '@orc/contracts'
import type {
  EventRecord, FailureClass, Plan, Signal, StepRunStatus, TaskNode, TaskStatus, Usage,
} from '@orc/contracts'

export interface TaskPlans {
  versions: Plan[]
  approvedVersion: number | null
}

export interface StepState {
  stepId: string
  runToken: string
  attempt: number
  status: StepRunStatus
  iterations: number
  output: string | null
  failure: { class: FailureClass; message: string } | null
}

export interface RunRecord {
  planVersion: number
  retryIndex: number
  workflowId: string
  cwd: string | null
}

export interface State {
  tasks: Map<string, TaskNode>
  plans: Map<string, TaskPlans>
  steps: Map<string, Map<string, StepState>>
  runs: Map<string, RunRecord[]>
  usage: Map<string, Usage>
}

const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUSD: null, estimated: false }

const dedupKey = (e: EventRecord): string | null => {
  // task_status_changed is excluded: run-init (→running) and run-finish (→done) share a runToken
  // and would collide; a replayed status append is idempotent in fold anyway.
  if (!e.runToken || e.kind === EVENT_KIND.task_status_changed) return null
  const p = e.payload as { iteration?: number; toolCallId?: string }
  return `${e.runToken}:${e.kind}:${p.iteration ?? ''}:${p.toolCallId ?? ''}`
}

export function fold(events: EventRecord[]): State {
  const state: State = { tasks: new Map(), plans: new Map(), steps: new Map(), runs: new Map(), usage: new Map() }
  const seen = new Set<string>()

  const stepOf = (taskId: string, stepId: string): StepState | undefined => state.steps.get(taskId)?.get(stepId)
  const setStep = (taskId: string, s: StepState): void => {
    const m = state.steps.get(taskId) ?? new Map<string, StepState>()
    m.set(s.stepId, s)
    state.steps.set(taskId, m)
  }

  for (const e of events) {
    const key = dedupKey(e)
    if (key !== null) {
      if (seen.has(key)) continue // crash-boundary duplicate (spec §6.2)
      seen.add(key)
    }
    switch (e.kind) {
      case EVENT_KIND.task_created: {
        const { task } = e.payload as { task: TaskNode }
        state.tasks.set(task.id, task)
        break
      }
      case EVENT_KIND.plan_proposed:
      case EVENT_KIND.plan_edited: {
        const { plan } = e.payload as { plan: Plan }
        const tp = state.plans.get(plan.taskId) ?? { versions: [], approvedVersion: null }
        tp.versions.push(plan)
        state.plans.set(plan.taskId, tp)
        break
      }
      case EVENT_KIND.plan_approved: {
        const p = e.payload as { taskId: string; version: number }
        const tp = state.plans.get(p.taskId)
        if (tp) tp.approvedVersion = p.version
        break
      }
      case EVENT_KIND.task_status_changed: {
        const p = e.payload as { taskId: string; to: TaskStatus }
        const t = state.tasks.get(p.taskId)
        if (t) state.tasks.set(p.taskId, { ...t, status: p.to })
        break
      }
      case EVENT_KIND.run_started: {
        const p = e.payload as { planVersion: number; retryIndex: number; workflowId: string; cwd: string | null }
        const runs = state.runs.get(e.taskId) ?? []
        runs.push({ planVersion: p.planVersion, retryIndex: p.retryIndex, workflowId: p.workflowId, cwd: p.cwd })
        state.runs.set(e.taskId, runs)
        break
      }
      case EVENT_KIND.step_started: {
        const p = e.payload as { stepId: string; attempt: number }
        setStep(e.taskId, {
          stepId: p.stepId, runToken: e.runToken!, attempt: p.attempt,
          status: STEP_RUN_STATUS.running, iterations: 0, output: null, failure: null,
        })
        break
      }
      case EVENT_KIND.agent_call: {
        const p = e.payload as { stepId: string; iteration: number }
        const s = stepOf(e.taskId, p.stepId)
        if (s && s.runToken === e.runToken) s.iterations = Math.max(s.iterations, p.iteration)
        if (e.usage) state.usage.set(e.taskId, addUsage(state.usage.get(e.taskId) ?? ZERO_USAGE, e.usage))
        break
      }
      case EVENT_KIND.tool_call:
      case EVENT_KIND.tool_result:
      case EVENT_KIND.signal_received:
        break // traceability only; no state derivation
      case EVENT_KIND.step_completed: {
        const p = e.payload as { stepId: string; summary: string }
        const s = stepOf(e.taskId, p.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = STEP_RUN_STATUS.completed
          s.output = p.summary
        }
        break
      }
      case EVENT_KIND.step_failed: {
        const p = e.payload as { stepId: string; class: FailureClass; message: string }
        const s = stepOf(e.taskId, p.stepId)
        if (s && s.runToken === e.runToken) {
          s.status = STEP_RUN_STATUS.failed
          s.failure = { class: p.class, message: p.message }
        }
        break
      }
      default: {
        const unhandled: never = e.kind
        void unhandled
        break
      }
    }
  }
  return state
}

export function completedStepIds(state: State, taskId: string): Set<string> {
  const out = new Set<string>()
  for (const [id, s] of state.steps.get(taskId) ?? []) if (s.status === STEP_RUN_STATUS.completed) out.add(id)
  return out
}

export function nextAttempts(state: State, taskId: string, plan: Pick<Plan, 'steps'>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const step of plan.steps) {
    const s = state.steps.get(taskId)?.get(step.id)
    // running = orphaned/live attempt: reuse its number so the idempotent workflowID re-attaches
    out[step.id] = s ? (s.status === STEP_RUN_STATUS.running ? s.attempt : s.attempt + 1) : 1
  }
  return out
}

export function taskUsage(state: State, taskId: string): Usage {
  return state.usage.get(taskId) ?? ZERO_USAGE
}
```
(Drop the `Signal` import from the type-import list if the compiler flags it unused.)

- [ ] **Step 4: Run tests to verify green**

Run: `bun test packages/kernel && bun run typecheck`
Expected: all PASS (M1 fold tests + 3 new), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: fold projections for execution events with crash-boundary dedup"
```

---

### Task 6: Config + provider plugins (anthropic, openai, ollama)

**Files:**
- Create: `packages/kernel/src/config.ts`
- Create: `plugins/provider-anthropic/package.json`, `plugins/provider-anthropic/tsconfig.json`, `plugins/provider-anthropic/src/index.ts`
- Create: `plugins/provider-openai/package.json`, `plugins/provider-openai/tsconfig.json`, `plugins/provider-openai/src/index.ts`
- Create: `plugins/provider-ollama/package.json`, `plugins/provider-ollama/tsconfig.json`, `plugins/provider-ollama/src/index.ts`
- Modify: root `package.json` (workspaces + typecheck), `packages/kernel/src/index.ts` (export config)
- Test: `packages/kernel/src/config.test.ts`, `plugins/provider-anthropic/src/index.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `ModelProviderManifest`, `ModelCost` from `@orc/contracts`.
- Produces:
  - `interface OrcConfig { databaseUrl: string; systemDatabaseUrl: string; concurrency: number; workspaceRoot: string; ollamaBaseUrl: string; appVersion: string; costOverrides: Record<string, Record<string, ModelCost>> }` (costOverrides keyed provider → model)
  - `loadConfig(dir?: string): OrcConfig` — defaults ← optional `.orc/config.json` ← env (`ORC_DATABASE_URL`, `ORC_CONCURRENCY`, `OLLAMA_BASE_URL`); `systemDatabaseUrl` always derived from `databaseUrl` (db name + `_dbos_sys`); `APP_VERSION = 'orc-0.1.0'` constant (bump per release — pins `DBOS__APPVERSION`, spec §4)
  - `createAnthropicProvider(costOverrides?): ModelProvider<LanguageModel>` from `@orc/provider-anthropic` (same shape from `@orc/provider-openai`, `@orc/provider-ollama` — ollama's factory takes `{ baseUrl?, costOverrides? }`)

- [ ] **Step 1: Workspaces + scaffolds**

Root `package.json`: `"workspaces": ["packages/*", "plugins/*"]`; extend the `typecheck` script with `&& tsc --noEmit -p plugins/provider-anthropic && tsc --noEmit -p plugins/provider-openai && tsc --noEmit -p plugins/provider-ollama`.

Each plugin `package.json` (same pattern; swap the name and the ai-sdk dependency):
```json
{
  "name": "@orc/provider-anthropic",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@orc/contracts": "workspace:*"
  }
}
```
Each plugin `tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src"] }`.

Install:
```bash
cd plugins/provider-anthropic && bun add ai @ai-sdk/anthropic && cd ../..
cd plugins/provider-openai && bun add ai @ai-sdk/openai && cd ../..
cd plugins/provider-ollama && bun add ai ai-sdk-ollama && cd ../..
bun install
```

- [ ] **Step 2: Write the failing tests**

`packages/kernel/src/config.test.ts`:
```ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('derives systemDatabaseUrl from databaseUrl', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.systemDatabaseUrl).toBe(c.databaseUrl.replace(/\/([^/]+)$/, '/$1_dbos_sys'))
  })
  it('reads .orc/config.json overrides', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orc-'))
    mkdirSync(path.join(dir, '.orc'))
    writeFileSync(path.join(dir, '.orc', 'config.json'), JSON.stringify({ concurrency: 7, workspaceRoot: 'ws' }))
    const c = loadConfig(dir)
    expect(c.concurrency).toBe(7)
    expect(c.workspaceRoot).toBe('ws')
  })
  it('has sane defaults', () => {
    const c = loadConfig(mkdtempSync(path.join(tmpdir(), 'orc-')))
    expect(c.concurrency).toBe(3)
    expect(c.databaseUrl).toContain('5433')
    expect(c.appVersion).toMatch(/^orc-/)
  })
})
```

`plugins/provider-anthropic/src/index.test.ts`:
```ts
import { describe, expect, it } from 'bun:test'
import { costUSDFor, resolveModel } from '@orc/contracts'
import { createAnthropicProvider } from './index'

describe('anthropic provider', () => {
  it('exposes a manifest with real per-MTok costs', () => {
    const p = createAnthropicProvider()
    expect(p.manifest.id).toBe('anthropic')
    expect(costUSDFor(p.manifest.costs, 'claude-sonnet-5', 1_000_000, 0)).toBe(3)
    expect(costUSDFor(p.manifest.costs, 'claude-opus-4-8', 0, 1_000_000)).toBe(25)
    expect(costUSDFor(p.manifest.costs, 'not-a-model', 1000, 1000)).toBeNull()
  })
  it('resolves through the registry helper and returns a LanguageModel handle', () => {
    const providers = new Map([['anthropic', createAnthropicProvider()]])
    const r = resolveModel(providers, 'anthropic/claude-sonnet-5')
    expect(r.modelId).toBe('claude-sonnet-5')
    expect(r.model).toBeDefined() // no network call — just the handle
  })
  it('config cost overrides win', () => {
    const p = createAnthropicProvider({ 'claude-sonnet-5': { inPerMTok: 1, outPerMTok: 2 } })
    expect(costUSDFor(p.manifest.costs, 'claude-sonnet-5', 1_000_000, 0)).toBe(1)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test packages/kernel/src/config.test.ts plugins/provider-anthropic`
Expected: FAIL — modules missing.

- [ ] **Step 4: Implement**

`packages/kernel/src/config.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { ModelCost } from '@orc/contracts'

// bump per release — pins DBOS__APPVERSION so recovery survives rebuilds (spec §4)
export const APP_VERSION = 'orc-0.1.0'
export const DEFAULT_DATABASE_URL = 'postgresql://postgres:orc@localhost:5433/orc'

const FileConfig = z.object({
  databaseUrl: z.string().optional(),
  concurrency: z.number().int().positive().optional(),
  workspaceRoot: z.string().optional(),
  ollamaBaseUrl: z.string().optional(),
  costOverrides: z.record(z.string(), z.record(z.string(), ModelCost)).optional(),
})

export interface OrcConfig {
  databaseUrl: string
  systemDatabaseUrl: string
  concurrency: number
  workspaceRoot: string
  ollamaBaseUrl: string
  appVersion: string
  costOverrides: Record<string, Record<string, z.infer<typeof ModelCost>>>
}

function deriveSystemUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `${url.pathname}_dbos_sys`
  return url.toString()
}

export function loadConfig(dir: string = process.cwd()): OrcConfig {
  const file = path.join(dir, '.orc', 'config.json')
  const fromFile = existsSync(file) ? FileConfig.parse(JSON.parse(readFileSync(file, 'utf8'))) : {}
  const databaseUrl = process.env.ORC_DATABASE_URL ?? fromFile.databaseUrl ?? DEFAULT_DATABASE_URL
  return {
    databaseUrl,
    systemDatabaseUrl: deriveSystemUrl(databaseUrl),
    concurrency: Number(process.env.ORC_CONCURRENCY ?? fromFile.concurrency ?? 3),
    workspaceRoot: fromFile.workspaceRoot ?? path.join(dir, '.orc', 'workspaces'),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? fromFile.ollamaBaseUrl ?? 'http://localhost:11434',
    appVersion: APP_VERSION,
    costOverrides: fromFile.costOverrides ?? {},
  }
}
```
Append `export * from './config'` to `packages/kernel/src/index.ts`. (`zod` is already a transitive workspace dep via contracts; add `"zod": "^4"` — or the workspace's installed major — to kernel's dependencies explicitly.)

`plugins/provider-anthropic/src/index.ts`:
```ts
import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

// per-MTok pricing, verified 2026-07-17 (platform.claude.com/docs/en/pricing) — override via .orc/config.json
const COSTS: Record<string, ModelCost> = {
  'claude-fable-5': { inPerMTok: 10, outPerMTok: 50 },
  'claude-opus-4-8': { inPerMTok: 5, outPerMTok: 25 },
  'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 },
  'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5 },
}

export function createAnthropicProvider(
  costOverrides: Record<string, ModelCost> = {},
): ModelProvider<LanguageModel> {
  const anthropic = createAnthropic({}) // ANTHROPIC_API_KEY from env
  return {
    manifest: {
      id: 'anthropic',
      providerKind: 'anthropic',
      baseUrl: null,
      contextWindow: null,
      costs: { ...COSTS, ...costOverrides },
    },
    languageModel: modelId => anthropic(modelId),
  }
}
```

`plugins/provider-openai/src/index.ts`:
```ts
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

// no verified price table shipped — costUSD stays null/estimated until set in .orc/config.json costOverrides.openai
export function createOpenAIProvider(
  costOverrides: Record<string, ModelCost> = {},
): ModelProvider<LanguageModel> {
  const openai = createOpenAI({}) // OPENAI_API_KEY from env
  return {
    manifest: { id: 'openai', providerKind: 'openai', baseUrl: null, contextWindow: null, costs: { ...costOverrides } },
    languageModel: modelId => openai(modelId),
  }
}
```

`plugins/provider-ollama/src/index.ts`:
```ts
import { createOllama } from 'ai-sdk-ollama'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

export function createOllamaProvider(
  opts: { baseUrl?: string; costOverrides?: Record<string, ModelCost> } = {},
): ModelProvider<LanguageModel> {
  const baseUrl = opts.baseUrl ?? 'http://localhost:11434'
  const ollama = createOllama({ baseURL: baseUrl })
  return {
    manifest: {
      id: 'ollama',
      providerKind: 'ollama',
      baseUrl,
      contextWindow: null,
      costs: { '*': { inPerMTok: 0, outPerMTok: 0 }, ...opts.costOverrides }, // local models are free by default
    },
    languageModel: modelId => ollama(modelId),
  }
}
```
(If `ai-sdk-ollama`'s factory export is named differently in the installed 4.x — e.g. a default `ollama` instance plus `createOllama` — check `node_modules/ai-sdk-ollama/dist/index.d.ts` and adapt; the test is the contract.)

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test packages/kernel/src/config.test.ts plugins && bun run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: orc config + plugin-style providers (anthropic, openai, ollama)"
```

---

### Task 7: Built-in tools (signal + scoped fs) — executor package scaffold

**Files:**
- Create: `plugins/executor-api-loop/package.json`, `plugins/executor-api-loop/tsconfig.json`, `plugins/executor-api-loop/src/tools.ts`
- Modify: root `package.json` typecheck (add the package)
- Test: `plugins/executor-api-loop/src/tools.test.ts`

**Interfaces:**
- Consumes: `SignalOutcome` from `@orc/contracts`; `tool` from `ai`; zod.
- Produces:
  - `TOOL_NAME = { signal: 'signal', fs_read: 'fs_read', fs_write: 'fs_write', fs_list: 'fs_list' } as const`
  - `SignalInput = z.object({ outcome: SignalOutcome, summary: z.string().min(1) })`
  - `toolSet()` — AI SDK `tool()` definitions WITHOUT `execute` (the SDK must return tool calls, never run them; spec §6.2), keyed by `TOOL_NAME`
  - `executeTool(name: string, input: unknown, workspaceDir: string): Promise<{ output: unknown; isError: boolean }>` — never throws; violations come back as `isError: true` tool results (spec §6.3 trust boundary)
  - `resolveInWorkspace(workspaceDir: string, p: string): string` — exported for direct unit testing

- [ ] **Step 1: Scaffold**

`plugins/executor-api-loop/package.json`:
```json
{
  "name": "@orc/executor-api-loop",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@orc/contracts": "workspace:*"
  }
}
```
`tsconfig.json` as in Task 6. Then:
```bash
cd plugins/executor-api-loop && bun add ai zod && cd ../.. && bun install
```
Extend root typecheck with `&& tsc --noEmit -p plugins/executor-api-loop`.

- [ ] **Step 2: Write the failing test**

`plugins/executor-api-loop/src/tools.test.ts`:
```ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TOOL_NAME, executeTool, resolveInWorkspace, toolSet } from './tools'

const ws = () => mkdtempSync(path.join(tmpdir(), 'orc-ws-'))

describe('workspace scoping (trust boundary)', () => {
  it('rejects .. traversal and absolute escapes', () => {
    const dir = ws()
    expect(() => resolveInWorkspace(dir, '../outside.txt')).toThrow()
    expect(() => resolveInWorkspace(dir, '/etc/passwd')).toThrow()
    expect(resolveInWorkspace(dir, 'sub/file.txt')).toBe(path.join(dir, 'sub', 'file.txt'))
  })
  it('rejects symlink escapes', async () => {
    const dir = ws()
    symlinkSync(tmpdir(), path.join(dir, 'sneaky'))
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'sneaky/anything' }, dir)
    expect(r.isError).toBe(true)
  })
})

describe('fs tools', () => {
  it('write → read → list roundtrip, mkdir -p for parents', async () => {
    const dir = ws()
    const w = await executeTool(TOOL_NAME.fs_write, { path: 'a/b/hello.txt', content: 'hi' }, dir)
    expect(w.isError).toBe(false)
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'a/b/hello.txt' }, dir)
    expect(r.output).toEqual({ content: 'hi' })
    const l = await executeTool(TOOL_NAME.fs_list, { path: 'a/b' }, dir)
    expect(l.output).toEqual({ entries: ['hello.txt'] })
  })
  it('read of a missing file is an error result, not a throw', async () => {
    const r = await executeTool(TOOL_NAME.fs_read, { path: 'ghost.txt' }, ws())
    expect(r.isError).toBe(true)
  })
  it('malformed input is an error result', async () => {
    const r = await executeTool(TOOL_NAME.fs_write, { nope: true }, ws())
    expect(r.isError).toBe(true)
  })
  it('unknown tool name is an error result', async () => {
    const r = await executeTool('rm_rf', {}, ws())
    expect(r.isError).toBe(true)
  })
})

describe('toolSet', () => {
  it('declares all four tools and none has execute', () => {
    const tools = toolSet()
    for (const name of Object.values(TOOL_NAME)) {
      expect(tools[name]).toBeDefined()
      expect((tools[name] as { execute?: unknown }).execute).toBeUndefined()
    }
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test plugins/executor-api-loop`
Expected: FAIL — cannot resolve `./tools`.

- [ ] **Step 4: Implement**

`plugins/executor-api-loop/src/tools.ts`:
```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { SignalOutcome } from '@orc/contracts'

export const TOOL_NAME = {
  signal: 'signal',
  fs_read: 'fs_read',
  fs_write: 'fs_write',
  fs_list: 'fs_list',
} as const
export type ToolName = (typeof TOOL_NAME)[keyof typeof TOOL_NAME]

export const SignalInput = z.object({ outcome: SignalOutcome, summary: z.string().min(1) })
const ReadInput = z.object({ path: z.string().min(1) })
const WriteInput = z.object({ path: z.string().min(1), content: z.string() })
const ListInput = z.object({ path: z.string().default('.') })

// Trust boundary (spec §6.3): resolved path — symlinks included — must stay inside the workspace.
export function resolveInWorkspace(workspaceDir: string, p: string): string {
  const root = realpathSync(workspaceDir)
  const resolved = path.resolve(root, p)
  // realpath the deepest existing ancestor so symlinks cannot smuggle the path outside
  let probe = resolved
  while (!existsSync(probe)) probe = path.dirname(probe)
  const real = realpathSync(probe)
  if (real !== root && !real.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p}`)
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new Error(`path escapes workspace: ${p}`)
  return resolved
}

// Declared WITHOUT execute — the SDK returns tool calls; execution is ours, inside a durable step (spec §6.2).
export function toolSet() {
  return {
    [TOOL_NAME.signal]: tool({
      description:
        'End this step and report the outcome. Your summary is the ONLY output downstream steps see — put your results/conclusions in it. Call this exactly once, when the work is done or cannot proceed.',
      inputSchema: SignalInput,
    }),
    [TOOL_NAME.fs_read]: tool({
      description: 'Read a UTF-8 text file inside the step workspace.',
      inputSchema: ReadInput,
    }),
    [TOOL_NAME.fs_write]: tool({
      description: 'Write a UTF-8 text file inside the step workspace (parent directories are created).',
      inputSchema: WriteInput,
    }),
    [TOOL_NAME.fs_list]: tool({
      description: 'List directory entries inside the step workspace.',
      inputSchema: ListInput,
    }),
  }
}

export async function executeTool(
  name: string,
  input: unknown,
  workspaceDir: string,
): Promise<{ output: unknown; isError: boolean }> {
  try {
    switch (name) {
      case TOOL_NAME.fs_read: {
        const { path: p } = ReadInput.parse(input)
        return { output: { content: readFileSync(resolveInWorkspace(workspaceDir, p), 'utf8') }, isError: false }
      }
      case TOOL_NAME.fs_write: {
        const { path: p, content } = WriteInput.parse(input)
        const abs = resolveInWorkspace(workspaceDir, p)
        mkdirSync(path.dirname(abs), { recursive: true })
        writeFileSync(abs, content)
        return { output: { written: p }, isError: false }
      }
      case TOOL_NAME.fs_list: {
        const { path: p } = ListInput.parse(input)
        return { output: { entries: readdirSync(resolveInWorkspace(workspaceDir, p)).sort() }, isError: false }
      }
      default:
        return { output: { error: `unknown tool '${name}'` }, isError: true }
    }
  } catch (err) {
    return { output: { error: err instanceof Error ? err.message : String(err) }, isError: true }
  }
}
```
Create `plugins/executor-api-loop/src/index.ts`:
```ts
export * from './tools'
```

- [ ] **Step 5: Run tests to verify green**

Run: `bun test plugins/executor-api-loop && bun run typecheck`
Expected: 8 tests PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: signal + workspace-scoped fs tools with traversal guard"
```

---

### Task 8: api-loop executor (manual generateText loop)

**Files:**
- Create: `plugins/executor-api-loop/src/loop.ts`
- Modify: `plugins/executor-api-loop/src/index.ts` (add export)
- Test: `plugins/executor-api-loop/src/loop.test.ts`

**Interfaces:**
- Consumes: `AgentExecutor`, `ExecutorContext`, `UnifiedEvent`, `EventDraft`, `Signal`, `Usage`, `FAILURE_CLASS`, `SIGNAL_OUTCOME`, `EVENT_KIND`, `addUsage` from `@orc/contracts`; `toolSet`, `executeTool`, `SignalInput`, `TOOL_NAME` (Task 7); `generateText`, `type LanguageModel`, `type ModelMessage` from `ai`.
- Produces:
  - `apiLoopExecutor(): AgentExecutor<LanguageModel>` with `id: 'api-loop'`, capabilities `{ tools: true, streaming: false }`
  - `class TransientProviderError extends Error` — the **throw = transient/retry, return = terminal** rule: only transient provider failures are thrown out of a checkpoint (DBOS step retry handles them); everything else becomes a value/UnifiedEvent
  - Checkpoint names are deterministic and unique per iteration: `budget:<i>`, `model:<i>`, `signal:<i>`, `tools:<i>`

- [ ] **Step 1: Write the failing test**

Uses the AI SDK's mock model so the loop runs deterministically with zero network. **Exact mock class name:** import from `'ai/test'` — v7 ships a mock language model there (historically `MockLanguageModelV2`, v7 pairs with spec V4). Check `node_modules/ai/test/dist/index.d.ts` for the current name and doGenerate result shape, and adapt the test's mock construction; everything else in this test is fixed.

`plugins/executor-api-loop/src/loop.test.ts`:
```ts
import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Checkpoint, EventDraft, ExecutorContext, UnifiedEvent } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import type { LanguageModel } from 'ai'
import { apiLoopExecutor } from './loop'

// test-double checkpoint: runs fn, captures drafted events (what DBOS would append durably)
function makeCheckpoint(captured: EventDraft[]): Checkpoint {
  return async (_name, fn, toEvents) => {
    const r = await fn()
    if (toEvents) captured.push(...toEvents(r))
    return r
  }
}

function ctx(model: LanguageModel, captured: EventDraft[], over: Partial<ExecutorContext<LanguageModel>> = {}): ExecutorContext<LanguageModel> {
  return {
    step: {
      id: 's1', role: 'worker', title: 't', instructions: 'do the thing',
      executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [],
      isolation: 'local', zone: [], maxIterations: 3, dependsOn: [],
    },
    taskSpec: 'the task',
    depOutputs: {},
    model,
    runToken: 'step:t1:s1:a1',
    workspaceDir: mkdtempSync(path.join(tmpdir(), 'orc-ws-')),
    checkpoint: makeCheckpoint(captured),
    budgetRemainingUSD: async () => null,
    ...over,
  }
}

async function drain(it: AsyncIterable<UnifiedEvent>): Promise<UnifiedEvent[]> {
  const out: UnifiedEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

// Build mock models per scenario. See the step preamble: construct with the installed
// 'ai/test' mock class; each doGenerate call pops the next scripted response.
// scriptModel(responses: Array<{ text?: string; toolCalls?: Array<{toolCallId,toolName,input}> }>): LanguageModel
import { scriptModel } from './test-model'

describe('api-loop executor', () => {
  it('signal on first turn → signal + done events, agent_call + signal_received drafted', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'success', summary: 'all good' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.map(e => e.type)).toEqual(['usage', 'signal', 'done'])
    const kinds = captured.map(d => d.kind)
    expect(kinds).toContain(EVENT_KIND.agent_call)
    expect(kinds).toContain(EVENT_KIND.signal_received)
  })

  it('tool call → executes → feeds result back → signal on turn 2', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'fs_write', input: { path: 'out.txt', content: 'hi' } }] },
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'wrote file' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.filter(e => e.type === 'tool_result')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('done')
    const toolDrafts = captured.filter(d => d.kind === EVENT_KIND.tool_call || d.kind === EVENT_KIND.tool_result)
    expect(toolDrafts).toHaveLength(2)
  })

  it('agent-declared failure → signal(outcome failure), no done-as-success ambiguity', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'failure', summary: 'cannot proceed' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    const sig = events.find(e => e.type === 'signal')
    expect(sig?.type === 'signal' && sig.signal.outcome).toBe('failure')
  })

  it('never signals → maxIterations exhausted → error(agent_error)', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([{ text: 'hm' }, { text: 'hm' }, { text: 'hm' }])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.type === 'error' && last.class).toBe('agent_error')
  })

  it('budget exhausted → error(budget_exceeded) before any model call', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([])
    const events = await drain(
      apiLoopExecutor().startTurn(ctx(model, captured, { budgetRemainingUSD: async () => 0 })),
    )
    expect(events.at(-1)?.type === 'error' && (events.at(-1) as { class: string }).class).toBe('budget_exceeded')
    expect(captured.filter(d => d.kind === EVENT_KIND.agent_call)).toHaveLength(0)
  })

  it('malformed signal args count as an iteration and the loop continues', async () => {
    const captured: EventDraft[] = []
    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'c1', toolName: 'signal', input: { outcome: 'maybe' } }] }, // invalid
      { toolCalls: [{ toolCallId: 'c2', toolName: 'signal', input: { outcome: 'success', summary: 'ok now' } }] },
    ])
    const events = await drain(apiLoopExecutor().startTurn(ctx(model, captured)))
    expect(events.at(-1)?.type).toBe('done')
  })
})
```
Also create `plugins/executor-api-loop/src/test-model.ts` in this step — the scripted mock built on the installed `ai/test` mock class:
```ts
// Wraps the AI SDK's mock language model ('ai/test') into a pop-the-next-response script.
// VERIFY the exact class name + doGenerate result shape in node_modules/ai/test/dist/index.d.ts
// (v7 pairs with LanguageModelV4). The shape below follows the documented v2 mock; adapt fields
// (content vs text, toolCalls array form, usage keys) to the installed typings.
import { MockLanguageModelV4 } from 'ai/test'

export interface ScriptedTurn {
  text?: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>
}

export function scriptModel(turns: ScriptedTurn[]) {
  let i = 0
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const turn = turns[i++] ?? { text: '' }
      return {
        finishReason: turn.toolCalls?.length ? 'tool-calls' : 'stop',
        usage: { inputTokens: 10, outputTokens: 5 },
        content: [
          ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
          ...(turn.toolCalls ?? []).map(c => ({
            type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName,
            input: JSON.stringify(c.input),
          })),
        ],
        warnings: [],
      }
    },
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test plugins/executor-api-loop/src/loop.test.ts`
Expected: FAIL — cannot resolve `./loop`.

- [ ] **Step 3: Implement the loop**

`plugins/executor-api-loop/src/loop.ts`:
```ts
import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import {
  EVENT_KIND, FAILURE_CLASS, UNIFIED_EVENT_TYPE,
  type AgentExecutor, type EventDraft, type ExecutorContext, type Signal,
  type UnifiedEvent, type Usage,
} from '@orc/contracts'
import { SignalInput, TOOL_NAME, executeTool, toolSet } from './tools'

export class TransientProviderError extends Error {}

interface TurnResult {
  text: string
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
  usage: Usage
  responseMessages: ModelMessage[]
}

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

function isTransient(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number }).statusCode
    ?? (err as { status?: number }).status
  if (typeof status === 'number') return TRANSIENT_STATUS.has(status)
  const code = (err as { code?: string }).code
  return code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND'
}

function normalizeUsage(u: { inputTokens?: number; outputTokens?: number } | undefined): Usage {
  const input = u?.inputTokens
  const output = u?.outputTokens
  return {
    inputTokens: Number.isFinite(input) ? (input as number) : 0,
    outputTokens: Number.isFinite(output) ? (output as number) : 0,
    costUSD: null, // priced by the port, which knows the provider cost table
    estimated: !Number.isFinite(input) || !Number.isFinite(output),
  }
}

async function callModel(model: LanguageModel, messages: ModelMessage[]): Promise<TurnResult> {
  let result
  try {
    result = await generateText({ model, messages, tools: toolSet() })
  } catch (err) {
    if (isTransient(err)) throw new TransientProviderError(String(err))
    throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { terminal: true })
  }
  return {
    text: result.text,
    toolCalls: result.toolCalls.map(c => ({ toolCallId: c.toolCallId, toolName: c.toolName, input: c.input })),
    usage: normalizeUsage(result.usage),
    responseMessages: result.response.messages,
  }
}

function buildPrompt(ctx: ExecutorContext<LanguageModel>): string {
  const deps = Object.entries(ctx.depOutputs)
    .map(([id, out]) => `### Output of step '${id}'\n${out}`)
    .join('\n\n')
  return [
    `# Task\n${ctx.taskSpec}`,
    `# Your step: ${ctx.step.title} (role: ${ctx.step.role})\n${ctx.step.instructions}`,
    deps ? `# Upstream outputs\n${deps}` : '',
    `You have file tools scoped to your workspace. When finished (or stuck), call the 'signal' tool — its summary is the only thing downstream steps will see.`,
  ].filter(Boolean).join('\n\n')
}

export function apiLoopExecutor(): AgentExecutor<LanguageModel> {
  return {
    id: 'api-loop',
    getCapabilities: () => ({ tools: true, streaming: false }),

    async *startTurn(ctx: ExecutorContext<LanguageModel>): AsyncIterable<UnifiedEvent> {
      const messages: ModelMessage[] = [{ role: 'user', content: buildPrompt(ctx) }]
      const base = { stepId: ctx.step.id, runToken: ctx.runToken }

      for (let iteration = 1; iteration <= ctx.step.maxIterations; iteration++) {
        const remaining = await ctx.checkpoint(`budget:${iteration}`, ctx.budgetRemainingUSD)
        if (remaining !== null && remaining <= 0) {
          yield { type: UNIFIED_EVENT_TYPE.error, class: FAILURE_CLASS.budget_exceeded, message: `budget exhausted before iteration ${iteration}` }
          return
        }

        let turn: TurnResult
        try {
          turn = await ctx.checkpoint(
            `model:${iteration}`,
            () => callModel(ctx.model, messages),
            (r): EventDraft[] => [{
              kind: EVENT_KIND.agent_call,
              payload: { ...base, iteration, request: { messages }, response: { text: r.text, toolCalls: r.toolCalls } },
              usage: r.usage,
            }],
          )
        } catch (err) {
          // TransientProviderError retries inside the checkpoint (DBOS); reaching here means retries
          // are exhausted or the error is terminal → terminal provider failure.
          yield { type: UNIFIED_EVENT_TYPE.error, class: FAILURE_CLASS.provider_error, message: err instanceof Error ? err.message : String(err) }
          return
        }

        yield { type: UNIFIED_EVENT_TYPE.usage, usage: turn.usage }
        if (turn.text) yield { type: UNIFIED_EVENT_TYPE.text, text: turn.text }
        messages.push(...turn.responseMessages)

        const signalCall = turn.toolCalls.find(c => c.toolName === TOOL_NAME.signal)
        if (signalCall) {
          const parsed = SignalInput.safeParse(signalCall.input)
          if (!parsed.success) {
            messages.push({ role: 'user', content: `Your signal call was invalid (${parsed.error.message}). Call signal again with {outcome: 'success'|'failure', summary: string}.` })
            continue // counts as an iteration (agent_error accounting, spec §9)
          }
          const signal: Signal = { ...base, outcome: parsed.data.outcome, summary: parsed.data.summary }
          await ctx.checkpoint(
            `signal:${iteration}`,
            async () => signal,
            (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { ...base, signal } }],
          )
          yield { type: UNIFIED_EVENT_TYPE.signal, signal }
          yield { type: UNIFIED_EVENT_TYPE.done }
          return
        }

        if (turn.toolCalls.length === 0) {
          messages.push({ role: 'user', content: `Continue. Use your tools, and call 'signal' when the step is complete.` })
          continue
        }

        const results = await ctx.checkpoint(
          `tools:${iteration}`,
          async () => {
            const out = []
            for (const call of turn.toolCalls) out.push(await executeTool(call.toolName, call.input, ctx.workspaceDir))
            return out
          },
          (rs): EventDraft[] => turn.toolCalls.flatMap((call, i) => [
            { kind: EVENT_KIND.tool_call, payload: { ...base, iteration, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input } },
            { kind: EVENT_KIND.tool_result, payload: { ...base, iteration, toolCallId: call.toolCallId, toolName: call.toolName, output: rs[i]!.output, isError: rs[i]!.isError } },
          ]),
        )

        for (let i = 0; i < turn.toolCalls.length; i++) {
          const call = turn.toolCalls[i]!
          yield { type: UNIFIED_EVENT_TYPE.tool_call, toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }
          yield { type: UNIFIED_EVENT_TYPE.tool_result, toolCallId: call.toolCallId, toolName: call.toolName, output: results[i]!.output, isError: results[i]!.isError }
        }

        messages.push({
          role: 'tool',
          content: turn.toolCalls.map((call, i) => ({
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: 'json', value: results[i]!.output },
          })),
        } as ModelMessage)
      }

      yield { type: UNIFIED_EVENT_TYPE.error, class: FAILURE_CLASS.agent_error, message: `maxIterations (${ctx.step.maxIterations}) exhausted without signal` }
    },
  }
}
```
Notes for the implementer:
- The `ToolModelMessage` shape (`role: 'tool'`, `tool-result` parts with `output: {type: 'json', value}`) follows the v7 typings — verify against `node_modules/ai/dist/index.d.ts` and adapt the cast if the installed shape differs.
- `result.toolCalls[].input` arrives parsed (typed) in v7 when tools are declared via `tool()`; if the installed version exposes `args` instead of `input`, adapt in `callModel` only.
- `request: { messages }` snapshots the full request per R9 (full inputs); it is serialized into the `agent_call` payload by the checkpoint — acceptable growth for M2.

Append to `plugins/executor-api-loop/src/index.ts`:
```ts
export * from './loop'
```

- [ ] **Step 4: Run tests to verify green**

Run: `bun test plugins/executor-api-loop && bun run typecheck`
Expected: all PASS (14 in the package), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: api-loop executor — checkpointed generateText loop with signals"
```

---

### Task 9: DAG interpreter + DBOS ExecutionPort

**Files:**
- Create: `packages/kernel/src/execution/interpreter.ts`, `packages/kernel/src/execution/dbos-port.ts`
- Modify: `packages/kernel/src/index.ts` (export both), `packages/kernel/package.json` (dep)
- Test: `packages/kernel/src/execution/interpreter.test.ts` (pure, no infra), `packages/kernel/src/execution/dbos-port.test.ts` (integration, compose Postgres)

**Interfaces:**
- Consumes: everything above; `@dbos-inc/dbos-sdk` v4 functional API (spike-validated: `DBOS.setConfig`, `DBOS.launch`, `DBOS.shutdown`, `DBOS.registerWorkflow`, `DBOS.runStep`, `DBOS.startWorkflow`, `DBOS.registerQueue`, `DBOS.workflowID`, `DBOS.cancelWorkflow`, `DBOS.retrieveWorkflow`).
- Produces:
  - Pure: `readySteps(plan: Plan, done: Set<string>, failed: Set<string>, started: Set<string>): PlanStep[]` (deps ⊆ done, not already started/done/failed); `runOutcomeOf(plan: Plan, done: Set<string>, failed: Set<string>): RunOutcome` (`done` if all steps done, else `blocked`)
  - `createDbosPort(opts: { log: EventLog; config: OrcConfig; providers: Map<string, ModelProvider<unknown>>; executors: Map<string, AgentExecutor<unknown>> }): Promise<DbosPort>` where `DbosPort extends ExecutionPort` and adds `launch(): Promise<void>` and `shutdown(): Promise<void>`. Workflow/queue registration happens inside `createDbosPort` BEFORE `launch()` (DBOS requires registration pre-launch).
  - Workflow IDs: `run:<taskId>:v<N>` (first run), `run:<taskId>:v<N>:r<K>` (retries), `step:<taskId>:<stepId>:a<attempt>`; queue name `agents`.

- [ ] **Step 0 (optional, non-load-bearing): install DBOS agent skills**

```bash
npx skills add dbos-inc/agent-skills || true
```
If it fails or the command is unavailable, skip — docs.dbos.dev and the spike notes in the spec cover what's needed.

- [ ] **Step 1: Write the failing pure-interpreter test**

`packages/kernel/src/execution/interpreter.test.ts`:
```ts
import { describe, expect, it } from 'bun:test'
import type { Plan, PlanStep } from '@orc/contracts'
import { readySteps, runOutcomeOf } from './interpreter'

const step = (id: string, dependsOn: string[] = []): PlanStep => ({
  id, role: 'worker', title: id, instructions: 'do',
  executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [],
  isolation: 'local', zone: [], maxIterations: 5, dependsOn,
})
const plan = (steps: PlanStep[]): Plan =>
  ({ taskId: 't1', version: 1, strategyRef: 'template:single', costEstimateUSD: null, steps })

const ids = (steps: PlanStep[]) => steps.map(s => s.id)

describe('readySteps (diamond: a → b,c → d)', () => {
  const diamond = plan([step('a'), step('b', ['a']), step('c', ['a']), step('d', ['b', 'c'])])

  it('only roots are ready initially', () => {
    expect(ids(readySteps(diamond, new Set(), new Set(), new Set()))).toEqual(['a'])
  })
  it('parallel middle wave', () => {
    expect(ids(readySteps(diamond, new Set(['a']), new Set(), new Set(['a'])))).toEqual(['b', 'c'])
  })
  it('join waits for both parents', () => {
    expect(ids(readySteps(diamond, new Set(['a', 'b']), new Set(), new Set(['a', 'b', 'c'])))).toEqual([])
  })
  it('failure blocks downstream, independent branch continues', () => {
    // b failed → d never ready; c still runs
    expect(ids(readySteps(diamond, new Set(['a']), new Set(['b']), new Set(['a', 'b'])))).toEqual(['c'])
  })
  it('already-started steps are not re-issued', () => {
    expect(ids(readySteps(diamond, new Set(['a']), new Set(), new Set(['a', 'b', 'c'])))).toEqual([])
  })
})

describe('runOutcomeOf', () => {
  const p = plan([step('a'), step('b', ['a'])])
  it('done when every step completed', () => {
    expect(runOutcomeOf(p, new Set(['a', 'b']), new Set())).toBe('done')
  })
  it('blocked when anything failed or unreachable', () => {
    expect(runOutcomeOf(p, new Set(['a']), new Set(['b']))).toBe('blocked')
    expect(runOutcomeOf(p, new Set(), new Set(['a']))).toBe('blocked') // b unreachable
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement the interpreter**

Run: `bun test packages/kernel/src/execution` → FAIL (module missing).

`packages/kernel/src/execution/interpreter.ts`:
```ts
import { RUN_OUTCOME, type Plan, type PlanStep, type RunOutcome } from '@orc/contracts'

export function readySteps(
  plan: Plan,
  done: Set<string>,
  failed: Set<string>,
  started: Set<string>,
): PlanStep[] {
  return plan.steps.filter(
    s =>
      !done.has(s.id) &&
      !failed.has(s.id) &&
      !started.has(s.id) &&
      s.dependsOn.every(d => done.has(d)),
  )
}

export function runOutcomeOf(plan: Plan, done: Set<string>, failed: Set<string>): RunOutcome {
  return plan.steps.every(s => done.has(s.id)) ? RUN_OUTCOME.done : RUN_OUTCOME.blocked
}
```

Run: `bun test packages/kernel/src/execution/interpreter.test.ts` → 7 PASS. Commit checkpoint:
```bash
git add -A && git commit -m "feat: pure DAG wave interpreter"
```

- [ ] **Step 3: Install DBOS and write the failing port integration test**

```bash
cd packages/kernel && bun add @dbos-inc/dbos-sdk && cd ../.. && bun install
```

`packages/kernel/src/execution/dbos-port.test.ts` — uses a **fake executor** (no providers/network); a fake `ModelProvider` map satisfies resolution:
```ts
import { afterAll, describe, expect, it } from 'bun:test'
import {
  EVENT_KIND, SIGNAL_OUTCOME, TASK_STATUS,
  type AgentExecutor, type EventDraft, type ExecutorContext, type ModelProvider, type PlanDraft, type UnifiedEvent,
} from '@orc/contracts'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { loadConfig } from '../config'
import { createTestDb } from '../test-helpers'
import { createDbosPort, type DbosPort } from './dbos-port'

const fakeProvider: ModelProvider<unknown> = {
  manifest: { id: 'fake', providerKind: 'fake', baseUrl: null, contextWindow: null, costs: {} },
  languageModel: () => ({}),
}

// Scripted executor: per stepId, either succeed (echoing dep outputs) or fail once via signal.
function fakeExecutor(behavior: Record<string, 'ok' | 'fail'>): AgentExecutor<unknown> {
  return {
    id: 'api-loop',
    getCapabilities: () => ({ tools: false, streaming: false }),
    async *startTurn(ctx: ExecutorContext<unknown>): AsyncIterable<UnifiedEvent> {
      const outcome = behavior[ctx.step.id] === 'fail' ? SIGNAL_OUTCOME.failure : SIGNAL_OUTCOME.success
      const summary = `${ctx.step.id}:${outcome} deps=[${Object.keys(ctx.depOutputs).sort().join(',')}]`
      const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome, summary }
      await ctx.checkpoint(
        'model:1',
        async () => summary,
        (): EventDraft[] => [{ kind: EVENT_KIND.agent_call, payload: { stepId: ctx.step.id, runToken: ctx.runToken, iteration: 1, request: {}, response: { summary } }, usage: { inputTokens: 1, outputTokens: 1, costUSD: 0.001, estimated: false } }],
      )
      await ctx.checkpoint(
        'signal:1',
        async () => signal,
        (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }],
      )
      yield { type: 'signal', signal }
      yield { type: 'done' }
    },
  }
}

const twoStepDraft = (): PlanDraft => ({
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [
    { id: 'a', role: 'worker', title: 'a', instructions: 'first', executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], isolation: 'local', zone: [], maxIterations: 3, dependsOn: [] },
    { id: 'b', role: 'worker', title: 'b', instructions: 'second', executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [], isolation: 'local', zone: [], maxIterations: 3, dependsOn: ['a'] },
  ],
})

describe('DBOS execution port (integration)', () => {
  let cleanup: Array<() => Promise<void>> = []
  afterAll(async () => {
    for (const fn of cleanup.reverse()) await fn()
  })

  async function setup(behavior: Record<string, 'ok' | 'fail'>) {
    const db = await createTestDb()
    const log = await EventLog.open(db.url)
    const kernel = new Kernel(log)
    const config = { ...loadConfig(), databaseUrl: db.url, systemDatabaseUrl: `${db.url}_dbos_sys` }
    const port = await createDbosPort({
      log, config,
      providers: new Map([['fake', fakeProvider]]),
      executors: new Map([['api-loop', fakeExecutor(behavior)]]),
    })
    await port.launch()
    cleanup.push(async () => { await port.shutdown(); await log.close(); await db.drop() })
    return { kernel, log, port }
  }

  async function approvedTask(kernel: Kernel) {
    const t = await kernel.createTask({ title: 'exec test', spec: 'run the dag' })
    await kernel.proposePlan(t.id, twoStepDraft())
    await kernel.approvePlan(t.id)
    return t
  }

  it('runs a 2-step DAG to done, threading dep outputs, in order', async () => {
    const { kernel, port } = await setup({})
    const t = await approvedTask(kernel)
    const handle = await port.startRun(t.id)
    expect(await handle.wait()).toBe('done')

    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.status).toBe('completed')
    expect(state.steps.get(t.id)?.get('b')?.status).toBe('completed')
    // b saw a's output (the signal summary)
    expect(state.steps.get(t.id)?.get('b')?.output).toContain('deps=[a]')
    // event ordering: run_started before any step_started; a completes before b starts
    const kinds = (await kernel.eventsFor(t.id)).map(e => e.kind)
    expect(kinds.indexOf(EVENT_KIND.run_started)).toBeLessThan(kinds.indexOf(EVENT_KIND.step_started))
  })

  it('startRun is idempotent — second call attaches, no duplicate run_started', async () => {
    const { kernel, port } = await setup({})
    const t = await approvedTask(kernel)
    const [h1, h2] = [await port.startRun(t.id), await port.startRun(t.id)]
    expect(h1.workflowId).toBe(h2.workflowId)
    await h1.wait()
    const runs = (await kernel.state()).runs.get(t.id) ?? []
    expect(runs).toHaveLength(1)
  })

  it('failed step blocks task; retry re-runs only the failed step to done', async () => {
    const behavior: Record<string, 'ok' | 'fail'> = { a: 'ok', b: 'fail' }
    const { kernel, port } = await setup(behavior)
    const t = await approvedTask(kernel)
    expect(await (await port.startRun(t.id)).wait()).toBe('blocked')
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.blocked)

    behavior.b = 'ok' // human "fixed the world"
    const retry = await port.retry(t.id)
    expect(retry.workflowId).toContain(':r1')
    expect(await retry.wait()).toBe('done')

    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('a')?.attempt).toBe(1) // completed step NOT re-run
    expect(state.steps.get(t.id)?.get('b')?.attempt).toBe(2)
    expect((await kernel.getTask(t.id))?.status).toBe(TASK_STATUS.done)
  })

  it('refuses to run an unapproved task', async () => {
    const { kernel, port } = await setup({})
    const t = await kernel.createTask({ title: 'nope' })
    await expect(port.startRun(t.id)).rejects.toThrow(/approve/)
  })
})
```

Run: `bun test packages/kernel/src/execution/dbos-port.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement the port**

`packages/kernel/src/execution/dbos-port.ts`:
```ts
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  EVENT_KIND, FAILURE_CLASS, RUN_OUTCOME, SIGNAL_OUTCOME, STEP_RUN_STATUS, TASK_STATUS,
  resolveModel, costUSDFor,
  type AgentExecutor, type Checkpoint, type EventDraft, type ExecutionPort, type ExecutorContext,
  type ModelProvider, type Plan, type RunHandle, type RunOutcome, type Signal, type UnifiedEvent, type Usage,
} from '@orc/contracts'
import { EventLog } from '../eventlog'
import { fold, completedStepIds, nextAttempts, taskUsage, type State } from '../projections'
import { KERNEL_ERROR_CODE, KernelError } from '../errors'
import { readySteps, runOutcomeOf } from './interpreter'
import type { OrcConfig } from '../config'

export interface DbosPort extends ExecutionPort {
  launch(): Promise<void>
  shutdown(): Promise<void>
}

const QUEUE = 'agents'

interface RunArgs { taskId: string; planVersion: number; retryIndex: number; cwd: string | null }
interface StepArgs { taskId: string; stepId: string; planVersion: number; cwd: string | null }
interface StepResult { stepId: string; ok: boolean }

export async function createDbosPort(opts: {
  log: EventLog
  config: OrcConfig
  providers: Map<string, ModelProvider<unknown>>
  executors: Map<string, AgentExecutor<unknown>>
}): Promise<DbosPort> {
  const { log, config, providers, executors } = opts

  const foldState = async (): Promise<State> => fold(await log.all())

  // durable step wrapper that also appends the drafted events INSIDE the step (spec §6.2)
  const makeCheckpoint = (taskId: string, stepId: string | null, runToken: string): Checkpoint =>
    (name, fn, toEvents) =>
      DBOS.runStep(
        async () => {
          const r = await fn()
          if (toEvents)
            for (const d of toEvents(r))
              await log.append({ taskId, stepId, runToken, kind: d.kind, payload: d.payload, usage: d.usage ?? null })
          return r
        },
        { name, retriesAllowed: true, maxAttempts: 4, intervalSeconds: 1, backoffRate: 2 },
      )

  const stepWorkflow = DBOS.registerWorkflow(
    async (args: StepArgs): Promise<StepResult> => {
      const runToken = DBOS.workflowID!
      const attempt = Number(runToken.split(':a').at(-1))
      const checkpoint = makeCheckpoint(args.taskId, args.stepId, runToken)

      // checkpointed init: read plan/task/dep-outputs (event-log reads are non-deterministic → must be a step)
      const init = await checkpoint('init', async () => {
        const state = await foldState()
        const plan = state.plans.get(args.taskId)!.versions.find(p => p.version === args.planVersion)!
        const step = plan.steps.find(s => s.id === args.stepId)!
        const task = state.tasks.get(args.taskId)!
        const depOutputs: Record<string, string> = {}
        for (const dep of step.dependsOn) depOutputs[dep] = state.steps.get(args.taskId)?.get(dep)?.output ?? ''
        return { step, taskSpec: task.spec, budgetUSD: task.budgetUSD, depOutputs }
      }, () => [{ kind: EVENT_KIND.step_started, payload: { stepId: args.stepId, runToken, attempt } }])

      const executor = executors.get(init.step.executorRef)
      if (!executor) return finishFailed(checkpoint, args, runToken, `no executor '${init.step.executorRef}'`)
      const { modelId, model, provider } = resolveModel(providers, init.step.modelRef)

      const workspaceDir = args.cwd ?? path.join(config.workspaceRoot, args.taskId, args.stepId)
      await checkpoint('workspace', async () => { mkdirSync(workspaceDir, { recursive: true }); return workspaceDir })

      const ctx: ExecutorContext<unknown> = {
        step: init.step,
        taskSpec: init.taskSpec,
        depOutputs: init.depOutputs,
        model,
        runToken,
        workspaceDir,
        // prices usage drafts on the way through: fill costUSD from the provider table
        checkpoint: (name, fn, toEvents) =>
          checkpoint(name, fn, toEvents ? r => toEvents(r).map(d => priceDraft(d, provider, modelId)) : undefined),
        budgetRemainingUSD: async () => {
          if (init.budgetUSD === null) return null
          const spent = taskUsage(await foldState(), args.taskId).costUSD ?? 0
          return init.budgetUSD - spent
        },
      }

      let signal: Signal | null = null
      let error: { class: string; message: string } | null = null
      for await (const ev of executor.startTurn(ctx)) {
        if (ev.type === 'signal') signal = ev.signal
        if (ev.type === 'error') error = { class: ev.class, message: ev.message }
      }

      if (signal?.outcome === SIGNAL_OUTCOME.success) {
        await checkpoint('finish', async () => signal, () => [
          { kind: EVENT_KIND.step_completed, payload: { stepId: args.stepId, runToken, summary: signal!.summary } },
        ])
        return { stepId: args.stepId, ok: true }
      }
      const failClass = signal ? FAILURE_CLASS.agent_error : (error?.class ?? FAILURE_CLASS.agent_error)
      const message = signal ? signal.summary : (error?.message ?? 'executor ended without signal')
      await checkpoint('finish', async () => message, () => [
        { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: failClass, message } },
      ])
      return { stepId: args.stepId, ok: false }
    },
    { name: 'orcStep' },
  )

  const runWorkflow = DBOS.registerWorkflow(
    async (args: RunArgs): Promise<RunOutcome> => {
      const workflowId = DBOS.workflowID!
      const checkpoint = makeCheckpoint(args.taskId, null, workflowId) // run-level events carry no stepId

      const init = await checkpoint('init', async () => {
        const state = await foldState()
        const plan = state.plans.get(args.taskId)!.versions.find(p => p.version === args.planVersion)!
        const from = state.tasks.get(args.taskId)!.status
        return { plan, done: [...completedStepIds(state, args.taskId)], attempts: nextAttempts(state, args.taskId, plan), from }
      }, r => [
        { kind: EVENT_KIND.run_started, payload: { taskId: args.taskId, planVersion: args.planVersion, retryIndex: args.retryIndex, workflowId, cwd: args.cwd } },
        { kind: EVENT_KIND.task_status_changed, payload: { taskId: args.taskId, from: r.from, to: TASK_STATUS.running } },
      ])

      const plan: Plan = init.plan
      const done = new Set(init.done)
      const failed = new Set<string>()
      const started = new Set(init.done)

      for (;;) {
        const ready = readySteps(plan, done, failed, started)
        if (ready.length === 0) break
        for (const s of ready) started.add(s.id)
        const handles = await Promise.all(
          ready.map(s =>
            DBOS.startWorkflow(stepWorkflow, {
              workflowID: `step:${args.taskId}:${s.id}:a${init.attempts[s.id]}`,
              queueName: QUEUE,
            })({ taskId: args.taskId, stepId: s.id, planVersion: args.planVersion, cwd: args.cwd }),
          ),
        )
        const results = await Promise.all(handles.map(h => h.getResult()))
        for (const r of results) (r.ok ? done : failed).add(r.stepId)
      }

      const outcome = runOutcomeOf(plan, done, failed)
      await checkpoint('finish', async () => outcome, o => [
        { kind: EVENT_KIND.task_status_changed, payload: { taskId: args.taskId, from: TASK_STATUS.running, to: o === RUN_OUTCOME.done ? TASK_STATUS.done : TASK_STATUS.blocked } },
      ])
      return outcome
    },
    { name: 'orcRun' },
  )

  DBOS.registerQueue(QUEUE, { concurrency: config.concurrency, workerConcurrency: config.concurrency })

  async function startRunAt(taskId: string, retryIndex: number, cwd?: string): Promise<RunHandle> {
    const state = await foldState()
    const task = state.tasks.get(taskId)
    if (!task) throw new KernelError(KERNEL_ERROR_CODE.task_not_found, `no task '${taskId}'`)
    const approved = state.plans.get(taskId)?.approvedVersion
    if (!approved || (task.status !== TASK_STATUS.approved && task.status !== TASK_STATUS.running && task.status !== TASK_STATUS.blocked))
      throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `task is '${task.status}' — approve a plan first (orc approve ${taskId})`)
    const workflowID = retryIndex === 0 ? `run:${taskId}:v${approved}` : `run:${taskId}:v${approved}:r${retryIndex}`
    const handle = await DBOS.startWorkflow(runWorkflow, { workflowID })({
      taskId, planVersion: approved, retryIndex, cwd: cwd ?? null,
    })
    return { workflowId: workflowID, wait: () => handle.getResult() }
  }

  return {
    launch: async () => {
      process.env.DBOS__APPVERSION ??= config.appVersion
      DBOS.setConfig({ name: 'orc', systemDatabaseUrl: config.systemDatabaseUrl })
      await DBOS.launch()
    },
    shutdown: () => DBOS.shutdown(),
    startRun: (taskId, o) => startRunAt(taskId, 0, o?.cwd),
    retry: async (taskId, o) => {
      const runs = (await foldState()).runs.get(taskId) ?? []
      return startRunAt(taskId, runs.length === 0 ? 0 : Math.max(...runs.map(r => r.retryIndex)) + 1, o?.cwd)
    },
    cancelRun: async taskId => {
      const state = await foldState()
      const latest = state.runs.get(taskId)?.at(-1)
      if (!latest) throw new KernelError(KERNEL_ERROR_CODE.invalid_transition, `no run to cancel for '${taskId}'`)
      // DBOS cancel does NOT cascade (spec §6.1): cancel children first, then the run
      for (const [stepId, s] of state.steps.get(taskId) ?? [])
        if (s.status === STEP_RUN_STATUS.running)
          await DBOS.cancelWorkflow(`step:${taskId}:${stepId}:a${s.attempt}`).catch(() => {})
      await DBOS.cancelWorkflow(latest.workflowId).catch(() => {})
      const task = state.tasks.get(taskId)!
      await log.append({
        taskId, stepId: null, runToken: null,
        kind: EVENT_KIND.task_status_changed,
        payload: { taskId, from: task.status, to: TASK_STATUS.cancelled },
      })
    },
    runStatus: async taskId => {
      const latest = (await foldState()).runs.get(taskId)?.at(-1)
      if (!latest) return { workflowId: null, dbosStatus: null }
      const status = await DBOS.retrieveWorkflow(latest.workflowId).getStatus()
      return { workflowId: latest.workflowId, dbosStatus: status?.status ?? null }
    },
  }
}

function priceDraft(d: EventDraft, provider: ModelProvider<unknown>, modelId: string): EventDraft {
  if (!d.usage || d.usage.costUSD !== null) return d
  const costUSD = costUSDFor(provider.manifest.costs, modelId, d.usage.inputTokens, d.usage.outputTokens)
  return { ...d, usage: { ...d.usage, costUSD, estimated: d.usage.estimated || costUSD === null } }
}

async function finishFailed(
  checkpoint: Checkpoint, args: StepArgs, runToken: string, message: string,
): Promise<StepResult> {
  await checkpoint('finish', async () => message, () => [
    { kind: EVENT_KIND.step_failed, payload: { stepId: args.stepId, runToken, class: FAILURE_CLASS.agent_error, message } },
  ])
  return { stepId: args.stepId, ok: false }
}
```
Append to `packages/kernel/src/index.ts`:
```ts
export * from './execution/interpreter'
export * from './execution/dbos-port'
```

Implementer notes (API drift is expected here — the tests are the contract):
- `DBOS.registerQueue` / queue option names, `DBOS.startWorkflow(fn, {workflowID, queueName})(args)`, `retriesAllowed/maxAttempts` step options, and `retrieveWorkflow(...).getStatus()` are the v4 names per docs.dbos.dev + the spike; check `node_modules/@dbos-inc/dbos-sdk/dist/src/dbos.d.ts` if any call rejects, and adapt.
- One DBOS runtime per process: the integration test launches once per `setup()`; if a second `DBOS.setConfig` + `launch()` in one process errors, restructure the test file to ONE `setup()` per describe block (create additional tasks in the same DB rather than new ports). Workflows registered once at module scope would collide across ports — that is why registration lives inside `createDbosPort`; if the installed DBOS rejects duplicate workflow names on a second port in the same process, register with a per-port name suffix only in tests, or (simpler) keep all tests on a single port instance.
- `startRunAt`'s status guard allows `running` (attach after crash/recovery) and `blocked` (retry path) — `approved` is the normal case.

- [ ] **Step 5: Run the integration suite**

Run: `docker compose up -d --wait && bun test packages/kernel/src/execution && bun run typecheck`
Expected: interpreter (7) + port (4) PASS, typecheck clean. These tests hit real Postgres + DBOS; expect ~10–30 s.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: DBOS execution port — durable run/step workflows on the agents queue"
```

---

### Task 10: CLI — run, retry, cancel, status

**Files:**
- Create: `packages/cli/src/runtime.ts`
- Modify: `packages/cli/src/main.ts`, `packages/cli/src/bin.ts`, `packages/cli/package.json`
- Test: `packages/cli/src/exec-commands.test.ts`

**Interfaces:**
- Consumes: `createDbosPort`, `loadConfig`, providers, `apiLoopExecutor`, fold helpers.
- Produces:
  - `buildRuntime(): Promise<{ kernel: Kernel; port: DbosPort }>` in `runtime.ts` — the composition root: builds the provider map (`anthropic`, `openai`, `ollama`), the executor map (`api-loop`), opens the log, creates + launches the port.
  - `buildProgram(kernel: Kernel, portFactory?: () => Promise<ExecutionPort>)` — new optional second parameter; `run`/`retry`/`cancel`/`status` commands. M1 commands never touch DBOS (portFactory is invoked lazily, only by exec commands).

- [ ] **Step 1: Wire deps**

`packages/cli/package.json` dependencies add:
```json
"@orc/executor-api-loop": "workspace:*",
"@orc/provider-anthropic": "workspace:*",
"@orc/provider-openai": "workspace:*",
"@orc/provider-ollama": "workspace:*"
```
Then `bun install`.

- [ ] **Step 2: Write the failing test (stub port — DBOS is already covered by Task 9)**

`packages/cli/src/exec-commands.test.ts`:
```ts
import { afterAll, afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ExecutionPort, RunHandle } from '@orc/contracts'
import { createTestDb } from '@orc/kernel/test-helpers'
import { buildProgram, openKernel } from './main'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { for (const d of dbs) await d.drop() })
afterEach(() => mock.restore())

function stubPort(outcome: 'done' | 'blocked' = 'done') {
  const calls: string[] = []
  const handle: RunHandle = { workflowId: 'run:x:v1', wait: async () => outcome }
  const port: ExecutionPort = {
    startRun: async id => { calls.push(`start:${id}`); return handle },
    retry: async id => { calls.push(`retry:${id}`); return handle },
    cancelRun: async id => { calls.push(`cancel:${id}`) },
    runStatus: async () => ({ workflowId: 'run:x:v1', dbosStatus: 'SUCCESS' }),
  }
  return { port, calls }
}

async function makeCli(outcome: 'done' | 'blocked' = 'done') {
  const db = await createTestDb()
  dbs.push(db)
  const kernel = await openKernel(db.url)
  const { port, calls } = stubPort(outcome)
  const lines: string[] = []
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
  const run = async (...args: string[]) =>
    buildProgram(kernel, async () => port).parseAsync(args, { from: 'user' })
  return { run, lines, calls, kernel }
}

async function approvedTask(run: (...a: string[]) => Promise<unknown>, lines: string[]) {
  await run('new', 'exec me')
  const id = lines[0]!
  await run('propose', id)
  await run('approve', id)
  return id
}

describe('exec commands', () => {
  it('run starts via the port and reports the outcome', async () => {
    const { run, lines, calls } = await makeCli('done')
    const id = await approvedTask(run, lines)
    await run('run', id)
    expect(calls).toContain(`start:${id}`)
    expect(lines.join('\n')).toContain('done')
  })

  it('run --cwd forwards the override', async () => {
    const { run, lines, calls } = await makeCli()
    const id = await approvedTask(run, lines)
    await run('run', id, '--cwd', '/tmp/shared-ws')
    expect(calls).toContain(`start:${id}`) // cwd assertion via stub spy below
  })

  it('retry and cancel call through', async () => {
    const { run, lines, calls } = await makeCli('blocked')
    const id = await approvedTask(run, lines)
    await run('retry', id)
    await run('cancel', id)
    expect(calls).toContain(`retry:${id}`)
    expect(calls).toContain(`cancel:${id}`)
  })

  it('status renders per-step state and cost totals from the fold', async () => {
    const { run, lines } = await makeCli()
    const id = await approvedTask(run, lines)
    lines.length = 0
    await run('status', id)
    expect(lines.join('\n')).toContain('approved') // task status
    expect(lines.join('\n')).toContain('s1')       // template step listed
  })
})
```
(For the `--cwd` assertion, extend `stubPort` to record `opts?.cwd` into `calls` — e.g. push `start:${id}:${opts?.cwd ?? ''}` — and assert `start:${id}:/tmp/shared-ws`. Keep the simple form for the other tests.)

- [ ] **Step 3: Run to verify failure, then implement**

Run: `bun test packages/cli/src/exec-commands.test.ts` → FAIL (`buildProgram` has no second param; commands missing).

`packages/cli/src/runtime.ts`:
```ts
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { createAnthropicProvider } from '@orc/provider-anthropic'
import { createOpenAIProvider } from '@orc/provider-openai'
import { createOllamaProvider } from '@orc/provider-ollama'
import type { AgentExecutor, ModelProvider } from '@orc/contracts'
import { createDbosPort, loadConfig, EventLog, Kernel, type DbosPort } from '@orc/kernel'

export async function buildRuntime(): Promise<{ kernel: Kernel; port: DbosPort }> {
  const config = loadConfig()
  const log = await EventLog.open(config.databaseUrl)
  const providers = new Map<string, ModelProvider<unknown>>([
    ['anthropic', createAnthropicProvider(config.costOverrides['anthropic'] ?? {}) as ModelProvider<unknown>],
    ['openai', createOpenAIProvider(config.costOverrides['openai'] ?? {}) as ModelProvider<unknown>],
    ['ollama', createOllamaProvider({ baseUrl: config.ollamaBaseUrl, costOverrides: config.costOverrides['ollama'] ?? {} }) as ModelProvider<unknown>],
  ])
  const executors = new Map<string, AgentExecutor<unknown>>([['api-loop', apiLoopExecutor() as AgentExecutor<unknown>]])
  const port = await createDbosPort({ log, config, providers, executors })
  await port.launch()
  return { kernel: new Kernel(log), port }
}
```

`packages/cli/src/main.ts` — extend `buildProgram`:
```ts
import type { ExecutionPort } from '@orc/contracts'
import { taskUsage } from '@orc/kernel'

export function buildProgram(kernel: Kernel, portFactory?: () => Promise<ExecutionPort>): Command {
```
…and append the four commands before `return program` (each guards `portFactory`):
```ts
  const needPort = async (): Promise<ExecutionPort> => {
    if (!portFactory) throw new Error('execution commands are unavailable in this context')
    return portFactory()
  }

  program
    .command('run <taskId>')
    .description('execute the approved plan (durable; re-run attaches/resumes)')
    .option('--cwd <dir>', 'shared workspace for all steps (default: per-step .orc/workspaces/)')
    .action(async (taskId: string, opts: { cwd?: string }) => {
      const port = await needPort()
      const handle = await port.startRun(taskId, { cwd: opts.cwd })
      console.log(`run ${handle.workflowId} started — tailing events (ctrl-c detaches, run keeps going)`)
      const outcome = await tailUntilDone(kernel, taskId, handle)
      console.log(`run finished: ${outcome}`)
      process.exitCode = outcome === 'done' ? 0 : 1
    })

  program
    .command('retry <taskId>')
    .description('re-run failed steps of a blocked task as new attempts')
    .option('--cwd <dir>')
    .action(async (taskId: string, opts: { cwd?: string }) => {
      const port = await needPort()
      const handle = await port.retry(taskId, { cwd: opts.cwd })
      console.log(`retry ${handle.workflowId} started`)
      const outcome = await tailUntilDone(kernel, taskId, handle)
      console.log(`run finished: ${outcome}`)
      process.exitCode = outcome === 'done' ? 0 : 1
    })

  program
    .command('cancel <taskId>')
    .description('cancel the active run (terminal in M2)')
    .action(async (taskId: string) => {
      await (await needPort()).cancelRun(taskId)
      console.log('cancelled')
    })

  program
    .command('status <taskId>')
    .description('per-step state and cost totals')
    .action(async (taskId: string) => {
      const state = await kernel.state()
      const task = state.tasks.get(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      console.log(`${task.id}  ${task.status}  ${task.title}`)
      const plan = state.plans.get(taskId)?.versions.at(-1)
      for (const step of plan?.steps ?? []) {
        const s = state.steps.get(taskId)?.get(step.id)
        const status = s?.status ?? 'pending'
        const detail = s?.failure ? `  [${s.failure.class}] ${s.failure.message}` : (s?.output ? `  → ${s.output}` : '')
        console.log(`  ${step.id.padEnd(12)} ${status.padEnd(10)} attempt ${s?.attempt ?? 0}${detail}`)
      }
      const u = taskUsage(state, taskId)
      console.log(`  tokens in/out: ${u.inputTokens}/${u.outputTokens}  cost: ${u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`}`)
    })
```
`tailUntilDone` in main.ts:
```ts
import type { RunHandle } from '@orc/contracts'

// ponytail: 500ms poll on the events table for live tailing — LISTEN/NOTIFY when it matters
async function tailUntilDone(kernel: Kernel, taskId: string, handle: RunHandle): Promise<string> {
  let lastSeq = Math.max(0, ...(await kernel.eventsFor(taskId)).map(e => e.seq))
  let done = false
  const outcomeP = handle.wait().finally(() => { done = true })
  while (!done) {
    await new Promise(r => setTimeout(r, 500))
    const fresh = (await kernel.eventsFor(taskId)).filter(e => e.seq > lastSeq)
    for (const e of fresh) {
      lastSeq = e.seq
      console.log(`${String(e.seq).padStart(4)}  ${e.kind}${e.stepId ? `  ${e.stepId}` : ''}`)
    }
  }
  return outcomeP
}
```
`packages/cli/src/bin.ts` — exec commands need the full runtime; keep M1 commands light:
```ts
import { buildProgram, isConnectionRefused, openKernel, DEFAULT_DATABASE_URL } from './main'
import { buildRuntime } from './runtime'

// status reads only the fold — no DBOS launch needed
const NEEDS_PORT = new Set(['run', 'retry', 'cancel'])
const cmd = process.argv[2]

try {
  if (cmd !== undefined && NEEDS_PORT.has(cmd)) {
    const { kernel, port } = await buildRuntime()
    await buildProgram(kernel, async () => port).parseAsync(process.argv)
    await port.shutdown()
  } else {
    const kernel = await openKernel()
    await buildProgram(kernel).parseAsync(process.argv)
  }
  process.exit(process.exitCode ?? 0)
} catch (err) {
  if (isConnectionRefused(err)) {
    const url = process.env.ORC_DATABASE_URL ?? DEFAULT_DATABASE_URL
    console.error(`Postgres is not reachable at ${url} — start it with: docker compose up -d`)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exit(1)
}
```
(`status` reads only the fold — no DBOS launch needed. Note `taskUsage` must be exported from `@orc/kernel`'s index; it is, via `export * from './projections'` — add that export line if the index lacks it.)

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test packages/cli && bun run typecheck`
Expected: all CLI tests PASS (M1 3 + new 4), typecheck clean.

- [ ] **Step 5: Manual smoke (requires Ollama or an API key; otherwise skip to Task 11 which has the env-gated version)**

```bash
bun packages/cli/src/bin.ts new "write a haiku about databases" --spec "write it to haiku.txt, then signal with the haiku as summary"
bun packages/cli/src/bin.ts propose <id> --model ollama/llama3   # or anthropic/claude-sonnet-5
bun packages/cli/src/bin.ts approve <id>
bun packages/cli/src/bin.ts run <id>
bun packages/cli/src/bin.ts status <id>
```
Expected: live event tail, `run finished: done`, status shows the step completed with the signal summary and token/cost totals; `haiku.txt` under `.orc/workspaces/<id>/s1/`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: orc run/retry/cancel/status with live event tail"
```

---

### Task 11: Kill‑9 resume proof + live smoke + docs

**Files:**
- Create: `packages/kernel/src/execution/resume-fixture.ts`, `packages/kernel/src/execution/resume.test.ts`
- Create: `plugins/executor-api-loop/src/live-smoke.test.ts`
- Modify: `README.md`
- (No production code changes expected — if the resume test fails, the PORT has a durability bug: STOP and fix the port, do not adjust the test.)

**Interfaces:** consumes everything; produces the spec §10/§11 guarantees as tests.

- [ ] **Step 1: Write the fixture (a subprocess that runs one task end-to-end)**

`packages/kernel/src/execution/resume-fixture.ts`:
```ts
// Subprocess entry for the kill -9 resume test. Args: <dbUrl> <taskId> <markerPath>
// A fake executor stalls 60s inside its first model checkpoint UNLESS the marker file
// already exists (i.e. we are the respawned process) — first run: create marker, stall,
// get killed; second run: DBOS recovery + idempotent startRun complete the run fast.
import { existsSync, writeFileSync } from 'node:fs'
import {
  EVENT_KIND, SIGNAL_OUTCOME,
  type AgentExecutor, type EventDraft, type ExecutorContext, type ModelProvider, type UnifiedEvent,
} from '@orc/contracts'
import { EventLog } from '../eventlog'
import { loadConfig } from '../config'
import { createDbosPort } from './dbos-port'

const [dbUrl, taskId, marker] = process.argv.slice(2) as [string, string, string]

const stallOnce: AgentExecutor<unknown> = {
  id: 'api-loop',
  getCapabilities: () => ({ tools: false, streaming: false }),
  async *startTurn(ctx: ExecutorContext<unknown>): AsyncIterable<UnifiedEvent> {
    await ctx.checkpoint(
      'model:1',
      async () => {
        if (!existsSync(marker)) {
          writeFileSync(marker, '')
          await new Promise(r => setTimeout(r, 60_000)) // killed here on first run
        }
        return 'turn'
      },
      (): EventDraft[] => [{
        kind: EVENT_KIND.agent_call,
        payload: { stepId: ctx.step.id, runToken: ctx.runToken, iteration: 1, request: {}, response: {} },
        usage: { inputTokens: 1, outputTokens: 1, costUSD: 0, estimated: false },
      }],
    )
    const signal = { stepId: ctx.step.id, runToken: ctx.runToken, outcome: SIGNAL_OUTCOME.success, summary: `${ctx.step.id} ok` }
    await ctx.checkpoint('signal:1', async () => signal,
      (): EventDraft[] => [{ kind: EVENT_KIND.signal_received, payload: { stepId: ctx.step.id, runToken: ctx.runToken, signal } }])
    yield { type: 'signal', signal }
    yield { type: 'done' }
  },
}

const fakeProvider: ModelProvider<unknown> = {
  manifest: { id: 'fake', providerKind: 'fake', baseUrl: null, contextWindow: null, costs: {} },
  languageModel: () => ({}),
}

const log = await EventLog.open(dbUrl)
const config = { ...loadConfig(), databaseUrl: dbUrl, systemDatabaseUrl: `${dbUrl}_dbos_sys` }
const port = await createDbosPort({
  log, config,
  providers: new Map([['fake', fakeProvider]]),
  executors: new Map([['api-loop', stallOnce]]),
})
await port.launch() // recovery of PENDING workflows happens here on the respawn
const handle = await port.startRun(taskId) // idempotent: attaches on respawn
const outcome = await handle.wait()
await port.shutdown()
await log.close()
console.log(outcome)
process.exit(outcome === 'done' ? 0 : 1)
```

- [ ] **Step 2: Write the resume test**

`packages/kernel/src/execution/resume.test.ts`:
```ts
import { afterAll, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EVENT_KIND } from '@orc/contracts'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { fold } from '../projections'
import { createTestDb } from '../test-helpers'

const FIXTURE = fileURLToPath(new URL('./resume-fixture.ts', import.meta.url))

const singleStepDraft = {
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 'slow', instructions: 'stall then finish',
    executorRef: 'api-loop', modelRef: 'fake/m', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 3, dependsOn: [],
  }],
} as const

describe('kill -9 resume (spec §10/§11 — the crown jewel)', () => {
  let drop: (() => Promise<void>) | null = null
  afterAll(async () => { await drop?.() })

  it('a killed run resumes on restart; no double-billed iteration; replay identity holds', async () => {
    const db = await createTestDb()
    drop = db.drop
    const log = await EventLog.open(db.url)
    const kernel = new Kernel(log)
    const t = await kernel.createTask({ title: 'resume me', spec: 'survive kill -9' })
    await kernel.proposePlan(t.id, structuredClone(singleStepDraft) as never)
    await kernel.approvePlan(t.id)
    const marker = path.join(mkdtempSync(path.join(tmpdir(), 'orc-resume-')), 'first-run-started')

    // First run: spawn, wait for the marker (executor is now stalled mid-step), kill -9
    const first = Bun.spawn(['bun', FIXTURE, db.url, t.id, marker], { stdout: 'pipe', stderr: 'pipe' })
    const deadline = Date.now() + 30_000
    while (!existsSync(marker)) {
      if (Date.now() > deadline) throw new Error('fixture never reached the stall point')
      await new Promise(r => setTimeout(r, 100))
    }
    first.kill(9)
    await first.exited

    // Second run: recovery + idempotent attach must complete the task
    const second = Bun.spawn(['bun', FIXTURE, db.url, t.id, marker], { stdout: 'pipe', stderr: 'pipe' })
    const code = await second.exited
    expect(code).toBe(0)

    // task done; the crash-boundary duplicate (if any) folds away: exactly ONE effective iteration
    expect((await kernel.getTask(t.id))?.status).toBe('done')
    const state = await kernel.state()
    expect(state.steps.get(t.id)?.get('s1')?.status).toBe('completed')
    expect(state.steps.get(t.id)?.get('s1')?.iterations).toBe(1)
    expect(state.usage.get(t.id)?.inputTokens).toBe(1) // usage counted once despite any replayed append

    // replay identity (extends M1's guarantee to execution events)
    const events = await log.all()
    expect(fold(events)).toEqual(fold(events))
    const reopened = await EventLog.open(db.url)
    expect(fold(await reopened.all())).toEqual(state)
    await reopened.close()
    await log.close()
  }, 120_000)
})
```

- [ ] **Step 3: Run the resume test**

Run: `docker compose up -d --wait && bun test packages/kernel/src/execution/resume.test.ts`
Expected: PASS (takes ~10–40 s: two subprocess launches + DBOS recovery). If it fails, the port has a durability bug — fix the port (typical culprits: an append outside a checkpoint, a non-checkpointed read in a workflow body, `DBOS__APPVERSION` not pinned so the respawn refuses recovery). Do NOT loosen the test.

- [ ] **Step 4: Env-gated live smoke**

`plugins/executor-api-loop/src/live-smoke.test.ts`:
```ts
import { describe, expect, it } from 'bun:test'
// Live end-to-end against real providers. Run explicitly:
//   ORC_LIVE_SMOKE=1 ANTHROPIC_API_KEY=... bun test plugins/executor-api-loop/src/live-smoke.test.ts
//   ORC_LIVE_SMOKE=1 OLLAMA_MODEL=llama3 bun test plugins/executor-api-loop/src/live-smoke.test.ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Checkpoint, EventDraft, ExecutorContext } from '@orc/contracts'
import type { LanguageModel } from 'ai'
import { apiLoopExecutor } from './loop'

const LIVE = process.env.ORC_LIVE_SMOKE === '1'

const passthrough: Checkpoint = async (_n, fn, toEvents) => {
  const r = await fn()
  void toEvents?.(r)
  return r
}

function liveCtx(model: LanguageModel): ExecutorContext<LanguageModel> {
  return {
    step: {
      id: 's1', role: 'worker', title: 'smoke', instructions:
        "Write the single word 'ping' to a file named pong.txt, then signal success with summary 'pong'.",
      executorRef: 'api-loop', modelRef: 'live/m', skillRefs: [],
      isolation: 'local', zone: [], maxIterations: 6, dependsOn: [],
    },
    taskSpec: 'live smoke test', depOutputs: {}, model,
    runToken: 'step:smoke:s1:a1',
    workspaceDir: mkdtempSync(path.join(tmpdir(), 'orc-smoke-')),
    checkpoint: passthrough,
    budgetRemainingUSD: async () => null,
  }
}

describe.skipIf(!LIVE)('live smoke', () => {
  it.skipIf(!process.env.ANTHROPIC_API_KEY)('anthropic completes a real step', async () => {
    const { createAnthropicProvider } = await import('@orc/provider-anthropic')
    const model = createAnthropicProvider().languageModel('claude-sonnet-5')
    const events = []
    for await (const ev of apiLoopExecutor().startTurn(liveCtx(model))) events.push(ev)
    expect(events.at(-1)?.type).toBe('done')
  }, 120_000)

  it.skipIf(!process.env.OLLAMA_MODEL)('ollama completes a real step', async () => {
    const { createOllamaProvider } = await import('@orc/provider-ollama')
    const model = createOllamaProvider().languageModel(process.env.OLLAMA_MODEL!)
    const events = []
    for await (const ev of apiLoopExecutor().startTurn(liveCtx(model))) events.push(ev)
    expect(events.at(-1)?.type).toBe('done')
  }, 300_000)
})
```
Add `"@orc/provider-anthropic": "workspace:*", "@orc/provider-ollama": "workspace:*"` to `plugins/executor-api-loop/package.json` **devDependencies** (test-only), `bun install`.

Run: `bun test plugins/executor-api-loop` → smoke suite reports skipped without the env vars; if you have Ollama or a key handy, run it live once and confirm.

- [ ] **Step 5: Update README**

Replace the Status/Stack/Quickstart sections of `README.md`:
```markdown
## Status

M2 (execution) — approved plans run on durable DBOS workflows across
Anthropic / OpenAI / Ollama, with full event-log traceability, typed
signals, cost accounting, and kill -9 resume. Plugins (M3), vault (M4),
recursion/strategies (M5) follow the roadmap in `docs/superpowers/plans/`.

## Stack

TypeScript end-to-end on Bun (package manager, runtime, test runner).
Postgres via docker compose (canonical event log + DBOS system DB).
Drizzle ORM over node-postgres. DBOS Transact for durable execution.
Vercel AI SDK v7 (+ ai-sdk-ollama) for models. Zod contracts. Commander CLI.

## Quickstart

```bash
docker compose up -d --wait     # Postgres on :5433 — required for everything
bun install && bun test

alias orc="bun $PWD/packages/cli/src/bin.ts"
export ANTHROPIC_API_KEY=...    # and/or run a local Ollama

orc new "write release notes" --spec "summarize changes since v1.2; signal with the notes as summary"
orc propose <task-id> --model anthropic/claude-sonnet-5   # or ollama/<model>
orc plan <task-id>              # review it
orc approve <task-id>           # the human gate
orc run <task-id>               # durable execution with live event tail
orc status <task-id>            # per-step state + token/cost totals
orc retry <task-id>             # re-run failed steps after a block
```

Every state change is an append-only event in Postgres; all state is a pure
fold over that log — replay and audit come for free. Kill the process
mid-run and `orc run` again: DBOS resumes from the last checkpoint and no
completed model call is ever re-billed.

## Operational notes

- `ORC_DATABASE_URL` overrides the default `postgresql://postgres:orc@localhost:5433/orc`.
- Never bundle the CLI (`bun build`): DBOS must run unbundled via `bun run`.
- Upgrading orc: finish or `orc cancel` active runs first — DBOS recovery is
  keyed to the app version (`DBOS__APPVERSION`).
- Optional ops tooling: DBOS Conductor / admin API can inspect workflow state;
  nothing is wired to it by default (local-first).
```

- [ ] **Step 6: Full suite, typecheck, commit**

Run: `docker compose up -d --wait && bun test && bun run typecheck`
Expected: everything PASS (resume test included), typecheck clean.

```bash
git add -A
git commit -m "test: kill-9 resume guarantee + live smoke + M2 README"
```

---

## Self-Review Notes

- **Spec coverage:** D1 infra + consolidation → Tasks 1–3; §5 contracts → Task 4; fold/dedup + `(runToken, kind, iteration, toolCallId)` → Task 5; D4 providers + §7 → Task 6; D5 tools + §6.3 trust boundary → Task 7; §6.2 step loop, append-inside-checkpoint, runToken=workflowID, throw-transient/return-terminal → Task 8; D2/D3 port, §6.1 waves + idempotent IDs + retry `r<K>` + cancel cascade, §9 taxonomy, budget checkpointed read → Task 9; §8 CLI → Task 10; §10/§11 quality scenarios (resume, replay identity, no re-billing) + live smoke + D6/D7 docs → Task 11. Deliberate cuts (§1 of the spec) are absent by design: no send/recv gates, no streaming deltas, no `orc signal`, no Google provider.
- **Known API-drift hedges (flagged inline where they apply):** `ai/test` mock class name (Task 8), `ai-sdk-ollama` factory export (Task 6), DBOS queue/step option names + single-runtime-per-process constraint (Task 9), drizzle pg identity-column builder (Task 1). Rule everywhere: adapt to the installed API; the tests are the contract.
- **Type consistency check:** `EventLogOps` threading (Tasks 1→2→9); `Checkpoint`/`EventDraft` (4→8→9→11); `runToken = step:<taskId>:<stepId>:a<attempt>` (4→5→8→9→11); `resolveModel` (4→6→9); `STEP_RUN_STATUS`/`RUN_OUTCOME` const maps used in fold, port, CLI; `taskUsage` (5→9→10); `RunHandle.wait()` (4→9→10→11).
- **Dedup design note:** `task_status_changed` is deliberately excluded from fold dedup — run-init (→running) and run-finish (→done/blocked) share the run workflowID as runToken and would otherwise collide; replayed status appends are idempotent in fold. Run-level events (`run_started`, run status changes) carry `stepId: null` and `runToken = run workflowID`.
- **Sequencing constraint:** Tasks 1–3 are one atomic migration (root `bun test` is red between them) — land them in one session; every task from 4 on keeps the full suite green.
- **No placeholders:** every step has complete code or exact commands; the four drift hedges name the exact file to check and the fallback behavior.



