# M1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The event-sourced kernel of the orchestrator: create a task, propose/edit a versioned plan, approve it through the human gate, and prove full replayability — driven by an `orc` CLI.

**Architecture:** pnpm monorepo with three packages. `@orc/contracts` holds zod schemas only (the ecosystem's API surface). `@orc/kernel` is an append-only SQLite event log plus a pure `fold()` that derives all state from events — replay is identity by construction. `@orc/cli` is a thin commander wrapper. No DBOS, no providers, no plugins in M1 (those are M2/M3); the canonical event schema built here is what they attach to (spec ADR-004).

**Tech Stack:** Node ≥ 22, pnpm workspaces, TypeScript strict (NodeNext), zod, better-sqlite3 (WAL), commander, vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-orchestrator-design.md`

## Global Constraints

- Node >= 22, pnpm >= 9. ESM only: `"type": "module"` in every package.json.
- TypeScript strict; `module`/`moduleResolution` = `NodeNext`; relative imports use `.js` extensions.
- `@orc/contracts` has exactly ONE runtime dependency: `zod`. Nothing else, ever.
- Every state change is an event append through `EventLog.append` — no other writes to the DB, no mutable state tables (spec §8.1). Multi-event invariants are wrapped in `EventLog.transaction`.
- Statuses (spec §5.2, copy verbatim): `draft | awaiting_approval | approved | running | blocked | done | failed | cancelled`.
- Event kinds in M1 (subset of spec §8.1): `task_created | plan_proposed | plan_edited | plan_approved | task_status_changed`.
- Approved plans are immutable; editing requires `awaiting_approval`; every edit is a new version (spec §5.2).
- No DBOS, no LLM/provider SDKs, no plugin loading in M1.
- Tests colocated as `packages/*/src/*.test.ts`; run with `pnpm test` (root vitest).
- Every commit message ends with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Milestone Roadmap (later plans, not this one)

- **M2 Execution:** ExecutionPort + DBOS, DAG interpreter, `api-loop` executor (Vercel AI SDK, incl. Ollama), typed signals, durable gates, usage accounting.
- **M3 Plugin host:** T0 SKILL.md watcher + progressive disclosure, T2 jiti extensions, T1 MCP client.
- **M4 Vault:** OKF projector, session transcripts, plan-edit parser (Obsidian round-trip), memory scopes + single-writer gateway.
- **M5 Recursion & strategies:** child splits + ApprovalPolicy rules, strategy presets, `claude-code` adapter, worktree sandbox, zones.

---

### Task 1: Monorepo scaffold + TaskNode contract

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`, `packages/contracts/src/index.ts`, `packages/contracts/src/task.ts`
- Create: `packages/kernel/package.json`, `packages/kernel/tsconfig.json`, `packages/kernel/src/index.ts`
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/main.ts` (empty export for now)
- Test: `packages/contracts/src/task.test.ts`

**Interfaces:**
- Produces: `TaskStatus` (zod enum, 8 statuses), `TaskNode` (zod object) and their inferred types, exported from `@orc/contracts`. All later tasks import from `@orc/contracts`.

- [ ] **Step 1: Write scaffold files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
```

`package.json`:
```json
{
  "name": "orchestrator",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit -p packages/contracts && tsc --noEmit -p packages/kernel && tsc --noEmit -p packages/cli"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['packages/*/src/**/*.test.ts'] },
})
```

`.gitignore`:
```
node_modules/
dist/
.orc/
*.db
*.db-journal
*.db-wal
*.db-shm
```

`packages/contracts/package.json`:
```json
{
  "name": "@orc/contracts",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/kernel/package.json`:
```json
{
  "name": "@orc/kernel",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/cli/package.json`:
```json
{
  "name": "@orc/cli",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/main.ts" }
}
```

`packages/contracts/tsconfig.json` — identical file also at `packages/kernel/tsconfig.json` and `packages/cli/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

`packages/kernel/src/index.ts` and `packages/cli/src/main.ts` (both, so typecheck passes until their real tasks):
```ts
export {}
```

- [ ] **Step 2: Install dev deps and zod**

Run:
```bash
pnpm add -D -w typescript vitest tsx @types/node
pnpm add zod --filter @orc/contracts
```
Expected: lockfile created, `node_modules` populated, no errors.

- [ ] **Step 3: Write the failing test**

`packages/contracts/src/task.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { TaskNode } from './task.js'

const valid = {
  id: 'a', parentId: null, type: 'generic', title: 'hello', spec: '',
  status: 'draft', zone: [], budgetUSD: null, depth: 0,
  createdAt: '2026-07-16T00:00:00.000Z',
}

describe('TaskNode', () => {
  it('parses a valid node', () => {
    expect(TaskNode.parse(valid)).toEqual(valid)
  })
  it('rejects unknown status', () => {
    expect(() => TaskNode.parse({ ...valid, status: 'nope' })).toThrow()
  })
  it('rejects negative depth', () => {
    expect(() => TaskNode.parse({ ...valid, depth: -1 })).toThrow()
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./task.js`.

- [ ] **Step 5: Implement the contract**

`packages/contracts/src/task.ts`:
```ts
import { z } from 'zod'

export const TaskStatus = z.enum([
  'draft', 'awaiting_approval', 'approved', 'running',
  'blocked', 'done', 'failed', 'cancelled',
])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TaskNode = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  type: z.string().min(1),
  title: z.string().min(1),
  spec: z.string(),
  status: TaskStatus,
  zone: z.array(z.string()),
  budgetUSD: z.number().nonnegative().nullable(),
  depth: z.number().int().min(0),
  createdAt: z.string(),
})
export type TaskNode = z.infer<typeof TaskNode>
```

`packages/contracts/src/index.ts`:
```ts
export * from './task.js'
```

- [ ] **Step 6: Run tests + typecheck to verify green**

Run: `pnpm test && pnpm typecheck`
Expected: 3 tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: monorepo scaffold + TaskNode contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Plan contracts + validatePlan

**Files:**
- Create: `packages/contracts/src/plan.ts`
- Modify: `packages/contracts/src/index.ts` (add export)
- Test: `packages/contracts/src/plan.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `IsolationTier`, `PlanStep`, `Plan` (zod + types), `PlanDraft` (= `Plan` minus `taskId`/`version`), `validatePlan(plan: Plan): { ok: true } | { ok: false; errors: string[] }`.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/plan.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { Plan, validatePlan, type PlanStep } from './plan.js'

const step = (id: string, dependsOn: string[] = []): PlanStep => ({
  id, role: 'worker', title: id, instructions: 'do the thing',
  executorRef: 'api-loop', modelRef: 'anthropic/claude-sonnet-5',
  skillRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn,
})

const plan = (steps: PlanStep[]) =>
  Plan.parse({ taskId: 't1', version: 1, strategyRef: 'template:single', costEstimateUSD: null, steps })

describe('validatePlan', () => {
  it('accepts a valid DAG', () => {
    expect(validatePlan(plan([step('a'), step('b', ['a'])]))).toEqual({ ok: true })
  })
  it('rejects duplicate step ids', () => {
    const r = validatePlan(plan([step('a'), step('a')]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('duplicate')
  })
  it('rejects unknown dependencies', () => {
    const r = validatePlan(plan([step('a', ['ghost'])]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('unknown')
  })
  it('rejects cycles', () => {
    const r = validatePlan(plan([step('a', ['b']), step('b', ['a'])]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors[0]).toContain('cycle')
  })
  it('rejects an empty plan at parse time', () => {
    expect(() => plan([])).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./plan.js`.

- [ ] **Step 3: Implement**

`packages/contracts/src/plan.ts`:
```ts
import { z } from 'zod'

export const IsolationTier = z.enum(['local', 'worktree', 'docker'])
export type IsolationTier = z.infer<typeof IsolationTier>

export const PlanStep = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().min(1),
  executorRef: z.string().min(1),
  modelRef: z.string().min(1),
  skillRefs: z.array(z.string()),
  isolation: IsolationTier,
  zone: z.array(z.string()),
  maxIterations: z.number().int().positive(),
  dependsOn: z.array(z.string()),
})
export type PlanStep = z.infer<typeof PlanStep>

export const Plan = z.object({
  taskId: z.string().min(1),
  version: z.number().int().positive(),
  strategyRef: z.string().min(1),
  costEstimateUSD: z.number().nonnegative().nullable(),
  steps: z.array(PlanStep).min(1),
})
export type Plan = z.infer<typeof Plan>

export const PlanDraft = Plan.omit({ taskId: true, version: true })
export type PlanDraft = z.infer<typeof PlanDraft>

export function validatePlan(plan: Plan): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const s of plan.steps) {
    if (ids.has(s.id)) errors.push(`duplicate step id: ${s.id}`)
    ids.add(s.id)
  }
  for (const s of plan.steps)
    for (const d of s.dependsOn)
      if (!ids.has(d)) errors.push(`step ${s.id} depends on unknown step: ${d}`)
  if (errors.length > 0) return { ok: false, errors }

  // ponytail: O(n^2) fixpoint cycle check — Kahn's with a real queue if plans get huge
  const remaining = new Map(plan.steps.map(s => [s.id, s.dependsOn]))
  const done = new Set<string>()
  let progress = true
  while (progress) {
    progress = false
    for (const [id, deps] of remaining) {
      if (deps.every(d => done.has(d))) {
        done.add(id)
        remaining.delete(id)
        progress = true
      }
    }
  }
  if (remaining.size > 0)
    errors.push(`dependency cycle involving: ${[...remaining.keys()].join(', ')}`)
  return errors.length > 0 ? { ok: false, errors } : { ok: true }
}
```

Append to `packages/contracts/src/index.ts`:
```ts
export * from './plan.js'
```

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm test`
Expected: all PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Plan/PlanStep contracts + DAG validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Event contracts

**Files:**
- Create: `packages/contracts/src/events.ts`
- Modify: `packages/contracts/src/index.ts` (add export)
- Test: `packages/contracts/src/events.test.ts`

**Interfaces:**
- Consumes: `TaskNode`, `TaskStatus` from `./task.js`; `Plan` from `./plan.js`.
- Produces: `EventKind` (zod enum), `PAYLOAD_SCHEMAS: Record<EventKind, z.ZodType>`, `EventInput` (zod: `{taskId, stepId, runToken, kind, payload}`), `EventRecord` (interface: `EventInput & {seq: number; ts: string}`). Named `EventRecord`, not `Event`, to avoid shadowing the Node.js global.

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/events.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { EventInput, EventKind, PAYLOAD_SCHEMAS } from './events.js'

describe('events', () => {
  it('has a payload schema for every kind', () => {
    for (const kind of EventKind.options) {
      expect(PAYLOAD_SCHEMAS[kind], kind).toBeDefined()
    }
  })
  it('parses a valid input envelope', () => {
    const input = {
      taskId: 't1', stepId: null, runToken: null,
      kind: 'task_status_changed',
      payload: { taskId: 't1', from: 'draft', to: 'awaiting_approval' },
    }
    expect(EventInput.parse(input)).toEqual(input)
  })
  it('payload schemas reject wrong shapes', () => {
    expect(() => PAYLOAD_SCHEMAS.plan_approved.parse({})).toThrow()
    expect(() =>
      PAYLOAD_SCHEMAS.task_status_changed.parse({ taskId: 't1', from: 'draft', to: 'not_a_status' }),
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./events.js`.

- [ ] **Step 3: Implement**

`packages/contracts/src/events.ts`:
```ts
import { z } from 'zod'
import { TaskNode, TaskStatus } from './task.js'
import { Plan } from './plan.js'

export const EventKind = z.enum([
  'task_created', 'plan_proposed', 'plan_edited', 'plan_approved', 'task_status_changed',
])
export type EventKind = z.infer<typeof EventKind>

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
}

export const EventInput = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1).nullable(),
  runToken: z.string().min(1).nullable(),
  kind: EventKind,
  payload: z.record(z.string(), z.unknown()),
})
export type EventInput = z.infer<typeof EventInput>

export interface EventRecord extends EventInput {
  seq: number
  ts: string
}
```

Append to `packages/contracts/src/index.ts`:
```ts
export * from './events.js'
```

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm test`
Expected: all PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: event contracts with per-kind payload schemas

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: EventLog (SQLite append-only store)

**Files:**
- Create: `packages/kernel/src/eventlog.ts`
- Modify: `packages/kernel/src/index.ts` (replace `export {}`)
- Test: `packages/kernel/src/eventlog.test.ts`

**Interfaces:**
- Consumes: `EventInput`, `EventRecord`, `PAYLOAD_SCHEMAS` from `@orc/contracts`.
- Produces: `class EventLog { constructor(path: string); append(input: EventInput): EventRecord; byTask(taskId: string): EventRecord[]; all(): EventRecord[]; transaction<T>(fn: () => T): T; close(): void }`. Appends validate the envelope AND the kind-specific payload; `seq` is strictly monotonic; `ts` is set by SQLite.

- [ ] **Step 1: Install deps**

Run:
```bash
pnpm add better-sqlite3 --filter @orc/kernel
pnpm add @orc/contracts --workspace --filter @orc/kernel
pnpm add -D -w @types/better-sqlite3
```
Expected: installs clean (better-sqlite3 compiles a native module).

- [ ] **Step 2: Write the failing test**

`packages/kernel/src/eventlog.test.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { EventInput } from '@orc/contracts'
import { EventLog } from './eventlog.js'

const freshDbPath = () => path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')

const statusEvent = (taskId = 't1'): EventInput => ({
  taskId, stepId: null, runToken: null,
  kind: 'task_status_changed',
  payload: { taskId, from: 'draft', to: 'awaiting_approval' },
})

describe('EventLog', () => {
  it('appends with monotonic seq and a timestamp', () => {
    const log = new EventLog(freshDbPath())
    const a = log.append(statusEvent())
    const b = log.append(statusEvent())
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
  it('rejects payloads that do not match the kind schema', () => {
    const log = new EventLog(freshDbPath())
    expect(() =>
      log.append({ ...statusEvent(), payload: { wrong: true } }),
    ).toThrow()
    expect(log.all()).toHaveLength(0)
  })
  it('filters by task and orders by seq', () => {
    const log = new EventLog(freshDbPath())
    log.append(statusEvent('t1'))
    log.append(statusEvent('t2'))
    log.append(statusEvent('t1'))
    expect(log.byTask('t1').map(e => e.seq)).toEqual([1, 3])
  })
  it('persists across reopen', () => {
    const p = freshDbPath()
    const log = new EventLog(p)
    log.append(statusEvent())
    log.close()
    const reopened = new EventLog(p)
    expect(reopened.all()).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./eventlog.js`.

- [ ] **Step 4: Implement**

`packages/kernel/src/eventlog.ts`:
```ts
import Database from 'better-sqlite3'
import { EventInput, PAYLOAD_SCHEMAS, type EventRecord } from '@orc/contracts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  step_id TEXT,
  run_token TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
`

interface Row {
  seq: number
  task_id: string
  step_id: string | null
  run_token: string | null
  kind: string
  payload: string
  ts: string
}

const toRecord = (r: Row): EventRecord => ({
  seq: r.seq,
  taskId: r.task_id,
  stepId: r.step_id,
  runToken: r.run_token,
  kind: r.kind as EventRecord['kind'],
  payload: JSON.parse(r.payload) as Record<string, unknown>,
  ts: r.ts,
})

export class EventLog {
  private readonly db: Database.Database

  constructor(path: string) {
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  append(input: EventInput): EventRecord {
    const parsed = EventInput.parse(input)
    PAYLOAD_SCHEMAS[parsed.kind].parse(parsed.payload)
    const row = this.db
      .prepare(
        `INSERT INTO events (task_id, step_id, run_token, kind, payload)
         VALUES (?, ?, ?, ?, ?) RETURNING seq, ts`,
      )
      .get(parsed.taskId, parsed.stepId, parsed.runToken, parsed.kind, JSON.stringify(parsed.payload)) as
      Pick<Row, 'seq' | 'ts'>
    return { ...parsed, seq: row.seq, ts: row.ts }
  }

  byTask(taskId: string): EventRecord[] {
    return (this.db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY seq').all(taskId) as Row[]).map(toRecord)
  }

  all(): EventRecord[] {
    return (this.db.prepare('SELECT * FROM events ORDER BY seq').all() as Row[]).map(toRecord)
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  close(): void {
    this.db.close()
  }
}
```

`packages/kernel/src/index.ts`:
```ts
export * from './eventlog.js'
```

- [ ] **Step 5: Run tests + typecheck to verify green**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS (15 tests total), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: append-only SQLite event log with payload validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: State fold (projections)

**Files:**
- Create: `packages/kernel/src/projections.ts`
- Modify: `packages/kernel/src/index.ts` (add export)
- Test: `packages/kernel/src/projections.test.ts`

**Interfaces:**
- Consumes: `EventRecord`, `TaskNode`, `TaskStatus`, `Plan` from `@orc/contracts`.
- Produces: `interface TaskPlans { versions: Plan[]; approvedVersion: number | null }`, `interface State { tasks: Map<string, TaskNode>; plans: Map<string, TaskPlans> }`, `fold(events: EventRecord[]): State` — a PURE function; all reads everywhere derive from it.

- [ ] **Step 1: Write the failing test**

`packages/kernel/src/projections.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { EventRecord, Plan, TaskNode } from '@orc/contracts'
import { fold } from './projections.js'

const task: TaskNode = {
  id: 't1', parentId: null, type: 'generic', title: 'hello', spec: '',
  status: 'draft', zone: [], budgetUSD: null, depth: 0,
  createdAt: '2026-07-16T00:00:00.000Z',
}

const planV = (version: number): Plan => ({
  taskId: 't1', version, strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 'hello', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'm', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
  }],
})

const evt = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord =>
  ({ seq, ts: '2026-07-16T00:00:00.000Z', taskId: 't1', stepId: null, runToken: null, kind, payload })

describe('fold', () => {
  it('replays a full lifecycle into consistent state', () => {
    const state = fold([
      evt(1, 'task_created', { task }),
      evt(2, 'plan_proposed', { plan: planV(1) }),
      evt(3, 'task_status_changed', { taskId: 't1', from: 'draft', to: 'awaiting_approval' }),
      evt(4, 'plan_edited', { plan: planV(2) }),
      evt(5, 'plan_approved', { taskId: 't1', version: 2, approvedAt: '2026-07-16T01:00:00.000Z' }),
      evt(6, 'task_status_changed', { taskId: 't1', from: 'awaiting_approval', to: 'approved' }),
    ])
    expect(state.tasks.get('t1')?.status).toBe('approved')
    expect(state.plans.get('t1')?.versions.map(p => p.version)).toEqual([1, 2])
    expect(state.plans.get('t1')?.approvedVersion).toBe(2)
  })
  it('is pure: same input, same output', () => {
    const events = [evt(1, 'task_created', { task })]
    expect(fold(events)).toEqual(fold(events))
  })
  it('empty log folds to empty state', () => {
    const state = fold([])
    expect(state.tasks.size).toBe(0)
    expect(state.plans.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./projections.js`.

- [ ] **Step 3: Implement**

`packages/kernel/src/projections.ts`:
```ts
import type { EventRecord, Plan, TaskNode, TaskStatus } from '@orc/contracts'

export interface TaskPlans {
  versions: Plan[]
  approvedVersion: number | null
}

export interface State {
  tasks: Map<string, TaskNode>
  plans: Map<string, TaskPlans>
}

export function fold(events: EventRecord[]): State {
  const state: State = { tasks: new Map(), plans: new Map() }
  for (const e of events) {
    switch (e.kind) {
      case 'task_created': {
        const { task } = e.payload as { task: TaskNode }
        state.tasks.set(task.id, task)
        break
      }
      case 'plan_proposed':
      case 'plan_edited': {
        const { plan } = e.payload as { plan: Plan }
        const tp = state.plans.get(plan.taskId) ?? { versions: [], approvedVersion: null }
        tp.versions.push(plan)
        state.plans.set(plan.taskId, tp)
        break
      }
      case 'plan_approved': {
        const p = e.payload as { taskId: string; version: number }
        const tp = state.plans.get(p.taskId)
        if (tp) tp.approvedVersion = p.version
        break
      }
      case 'task_status_changed': {
        const p = e.payload as { taskId: string; to: TaskStatus }
        const t = state.tasks.get(p.taskId)
        if (t) state.tasks.set(p.taskId, { ...t, status: p.to })
        break
      }
    }
  }
  return state
}
```

Append to `packages/kernel/src/index.ts`:
```ts
export * from './projections.js'
```

- [ ] **Step 4: Run tests to verify green**

Run: `pnpm test`
Expected: all PASS (18 tests total).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: pure fold projection from event log to state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Kernel facade (lifecycle state machine)

**Files:**
- Create: `packages/kernel/src/errors.ts`, `packages/kernel/src/kernel.ts`
- Modify: `packages/kernel/src/index.ts` (add exports)
- Test: `packages/kernel/src/kernel.test.ts`

**Interfaces:**
- Consumes: `EventLog` (Task 4), `fold`/`State` (Task 5), contracts.
- Produces:
  - `type KernelErrorCode = 'task_not_found' | 'invalid_transition' | 'version_conflict' | 'plan_validation_failed'`
  - `class KernelError extends Error { readonly code: KernelErrorCode }`
  - `class Kernel { constructor(log: EventLog); createTask(input: {title: string; spec?: string; type?: string; parentId?: string}): TaskNode; proposePlan(taskId: string, draft: PlanDraft): Plan; editPlan(taskId: string, draft: PlanDraft): Plan; approvePlan(taskId: string, version?: number): Plan; state(): State; getTask(id: string): TaskNode | undefined; listTasks(): TaskNode[]; getPlan(taskId: string, version?: number): Plan | undefined; eventsFor(taskId: string): EventRecord[] }`

Lifecycle rules (spec §5.3, §6.1): `proposePlan` only from `draft` (→ `awaiting_approval`); `editPlan` only in `awaiting_approval` (version+1); `approvePlan` only in `awaiting_approval` and only for the LATEST version (→ `approved`). Child tasks inherit `budgetUSD` and get `depth = parent.depth + 1`.

- [ ] **Step 1: Write the failing test**

`packages/kernel/src/kernel.test.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PlanDraft } from '@orc/contracts'
import { EventLog } from './eventlog.js'
import { KernelError } from './errors.js'
import { Kernel } from './kernel.js'

const freshKernel = () =>
  new Kernel(new EventLog(path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')))

const draft = (): PlanDraft => ({
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 't', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'm', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
  }],
})

describe('Kernel lifecycle', () => {
  it('create → propose → edit → approve happy path', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'hello', spec: 'world' })
    expect(t.status).toBe('draft')

    const v1 = k.proposePlan(t.id, draft())
    expect(v1.version).toBe(1)
    expect(k.getTask(t.id)?.status).toBe('awaiting_approval')

    const v2 = k.editPlan(t.id, draft())
    expect(v2.version).toBe(2)

    const approved = k.approvePlan(t.id)
    expect(approved.version).toBe(2)
    expect(k.getTask(t.id)?.status).toBe('approved')
    expect(k.state().plans.get(t.id)?.approvedVersion).toBe(2)
  })

  it('child tasks inherit budget and increment depth', () => {
    const k = freshKernel()
    const parent = k.createTask({ title: 'p' })
    const child = k.createTask({ title: 'c', parentId: parent.id })
    expect(child.depth).toBe(1)
    expect(child.parentId).toBe(parent.id)
  })

  it('rejects proposing twice', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    expect(() => k.proposePlan(t.id, draft())).toThrowError(
      expect.objectContaining({ code: 'invalid_transition' }),
    )
  })

  it('rejects editing before a proposal exists', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    expect(() => k.editPlan(t.id, draft())).toThrowError(
      expect.objectContaining({ code: 'invalid_transition' }),
    )
  })

  it('rejects approving a stale version', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    k.editPlan(t.id, draft())
    expect(() => k.approvePlan(t.id, 1)).toThrowError(
      expect.objectContaining({ code: 'version_conflict' }),
    )
  })

  it('rejects unknown tasks', () => {
    const k = freshKernel()
    expect(() => k.proposePlan('ghost', draft())).toThrowError(
      expect.objectContaining({ code: 'task_not_found' }),
    )
  })

  it('rejects invalid plan drafts (cycle)', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    const bad = draft()
    bad.steps = [
      { ...bad.steps[0], id: 'a', dependsOn: ['b'] },
      { ...bad.steps[0], id: 'b', dependsOn: ['a'] },
    ]
    expect(() => k.proposePlan(t.id, bad)).toThrowError(
      expect.objectContaining({ code: 'plan_validation_failed' }),
    )
    expect(k.getTask(t.id)?.status).toBe('draft')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot find module `./errors.js` / `./kernel.js`.

- [ ] **Step 3: Implement**

`packages/kernel/src/errors.ts`:
```ts
export type KernelErrorCode =
  | 'task_not_found'
  | 'invalid_transition'
  | 'version_conflict'
  | 'plan_validation_failed'

export class KernelError extends Error {
  constructor(readonly code: KernelErrorCode, message: string) {
    super(message)
    this.name = 'KernelError'
  }
}
```

`packages/kernel/src/kernel.ts`:
```ts
import { randomUUID } from 'node:crypto'
import {
  PlanDraft, validatePlan,
  type EventRecord, type Plan, type TaskNode, type TaskStatus,
} from '@orc/contracts'
import { EventLog } from './eventlog.js'
import { fold, type State } from './projections.js'
import { KernelError } from './errors.js'

export class Kernel {
  constructor(private readonly log: EventLog) {}

  createTask(input: { title: string; spec?: string; type?: string; parentId?: string }): TaskNode {
    return this.log.transaction(() => {
      const parent = input.parentId ? this.requireTask(input.parentId) : null
      const task: TaskNode = {
        id: randomUUID(),
        parentId: parent?.id ?? null,
        type: input.type ?? 'generic',
        title: input.title,
        spec: input.spec ?? '',
        status: 'draft',
        zone: [],
        budgetUSD: parent?.budgetUSD ?? null,
        depth: parent ? parent.depth + 1 : 0,
        createdAt: new Date().toISOString(),
      }
      this.append(task.id, 'task_created', { task })
      return task
    })
  }

  proposePlan(taskId: string, draft: PlanDraft): Plan {
    return this.log.transaction(() => {
      const task = this.requireTask(taskId)
      if (task.status !== 'draft')
        throw new KernelError('invalid_transition', `cannot propose a plan while task is '${task.status}'`)
      return this.appendPlanVersion(taskId, draft, 'plan_proposed', task.status)
    })
  }

  editPlan(taskId: string, draft: PlanDraft): Plan {
    return this.log.transaction(() => {
      const task = this.requireTask(taskId)
      if (task.status !== 'awaiting_approval')
        throw new KernelError('invalid_transition', `cannot edit a plan while task is '${task.status}'`)
      return this.appendPlanVersion(taskId, draft, 'plan_edited', task.status)
    })
  }

  approvePlan(taskId: string, version?: number): Plan {
    return this.log.transaction(() => {
      const task = this.requireTask(taskId)
      if (task.status !== 'awaiting_approval')
        throw new KernelError('invalid_transition', `cannot approve while task is '${task.status}'`)
      const latest = this.state().plans.get(taskId)?.versions.at(-1)
      if (!latest) throw new KernelError('invalid_transition', 'no plan to approve')
      const wanted = version ?? latest.version
      if (wanted !== latest.version)
        throw new KernelError('version_conflict', `latest plan is v${latest.version}, not v${wanted}`)
      this.append(taskId, 'plan_approved', {
        taskId, version: wanted, approvedAt: new Date().toISOString(),
      })
      this.append(taskId, 'task_status_changed', { taskId, from: task.status, to: 'approved' })
      return latest
    })
  }

  // ponytail: state() refolds the whole log on every call — add snapshots when it measurably slows
  state(): State {
    return fold(this.log.all())
  }

  getTask(id: string): TaskNode | undefined {
    return this.state().tasks.get(id)
  }

  listTasks(): TaskNode[] {
    return [...this.state().tasks.values()]
  }

  getPlan(taskId: string, version?: number): Plan | undefined {
    const tp = this.state().plans.get(taskId)
    if (!tp) return undefined
    return version === undefined ? tp.versions.at(-1) : tp.versions.find(p => p.version === version)
  }

  eventsFor(taskId: string): EventRecord[] {
    return this.log.byTask(taskId)
  }

  private appendPlanVersion(
    taskId: string,
    draft: PlanDraft,
    kind: 'plan_proposed' | 'plan_edited',
    from: TaskStatus,
  ): Plan {
    const versions = this.state().plans.get(taskId)?.versions ?? []
    const plan: Plan = { ...PlanDraft.parse(draft), taskId, version: versions.length + 1 }
    const check = validatePlan(plan)
    if (!check.ok) throw new KernelError('plan_validation_failed', check.errors.join('; '))
    this.append(taskId, kind, { plan })
    if (from !== 'awaiting_approval')
      this.append(taskId, 'task_status_changed', { taskId, from, to: 'awaiting_approval' })
    return plan
  }

  private append(taskId: string, kind: EventRecord['kind'], payload: Record<string, unknown>): void {
    this.log.append({ taskId, stepId: null, runToken: null, kind, payload })
  }

  private requireTask(id: string): TaskNode {
    const t = this.state().tasks.get(id)
    if (!t) throw new KernelError('task_not_found', `no task '${id}'`)
    return t
  }
}
```

Append to `packages/kernel/src/index.ts`:
```ts
export * from './errors.js'
export * from './kernel.js'
```

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS (25 tests total), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: kernel facade with transactional plan lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CLI (`orc`)

**Files:**
- Modify: `packages/cli/src/main.ts` (replace `export {}`)
- Create: `packages/cli/src/bin.ts`
- Test: `packages/cli/src/main.test.ts`

**Interfaces:**
- Consumes: `Kernel`, `EventLog` from `@orc/kernel`; `PlanDraft` from `@orc/contracts`.
- Produces: `openKernel(dir?: string): Kernel` (opens `<dir>/.orc/state.db`, mkdir -p), `singleStepDraft(task: {title: string; spec: string}, modelRef: string): PlanDraft`, `buildProgram(kernel: Kernel): Command`. Commands: `new <title> [--spec] [--parent]` (prints task id), `propose <taskId> [--file plan.json] [--model ref]` (no file → single-step template), `plan <taskId> [--version n]` (prints plan JSON), `approve <taskId> [--version n]`, `tasks`, `log <taskId>`.

- [ ] **Step 1: Install deps**

Run:
```bash
pnpm add commander --filter @orc/cli
pnpm add @orc/kernel @orc/contracts --workspace --filter @orc/cli
```

- [ ] **Step 2: Write the failing test**

`packages/cli/src/main.test.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildProgram, openKernel } from './main.js'

function makeCli() {
  const kernel = openKernel(mkdtempSync(path.join(tmpdir(), 'orc-')))
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '))
  })
  // fresh Command instance per invocation; commander does not re-parse cleanly
  const run = async (...args: string[]) => {
    await buildProgram(kernel).parseAsync(args, { from: 'user' })
    return lines
  }
  return { run, lines }
}

afterEach(() => vi.restoreAllMocks())

describe('orc CLI', () => {
  it('new → propose → approve → log round-trip', async () => {
    const { run, lines } = makeCli()
    await run('new', 'hello world', '--spec', 'do things')
    const taskId = lines[0]
    expect(taskId).toMatch(/[0-9a-f-]{36}/)

    await run('propose', taskId)
    expect(lines[1]).toContain('plan v1 proposed')

    await run('approve', taskId)
    expect(lines[2]).toContain('plan v1 approved')

    lines.length = 0
    await run('log', taskId)
    const kinds = lines.map(l => l.split(/\s+/).at(-1))
    expect(kinds).toEqual([
      'task_created', 'plan_proposed', 'task_status_changed',
      'plan_approved', 'task_status_changed',
    ])
  })

  it('plan prints the plan as JSON', async () => {
    const { run, lines } = makeCli()
    await run('new', 'x')
    const taskId = lines[0]
    await run('propose', taskId, '--model', 'ollama/llama3')
    lines.length = 0
    await run('plan', taskId)
    const plan = JSON.parse(lines.join('\n'))
    expect(plan.steps[0].modelRef).toBe('ollama/llama3')
    expect(plan.strategyRef).toBe('template:single')
  })

  it('tasks lists id, status and title', async () => {
    const { run, lines } = makeCli()
    await run('new', 'listed task')
    lines.length = 0
    await run('tasks')
    expect(lines[0]).toContain('draft')
    expect(lines[0]).toContain('listed task')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `main.js` has no export `buildProgram`.

- [ ] **Step 4: Implement**

`packages/cli/src/main.ts`:
```ts
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import { PlanDraft } from '@orc/contracts'
import { EventLog, Kernel } from '@orc/kernel'

export function openKernel(dir: string = process.cwd()): Kernel {
  const dbDir = path.join(dir, '.orc')
  mkdirSync(dbDir, { recursive: true })
  return new Kernel(new EventLog(path.join(dbDir, 'state.db')))
}

export function singleStepDraft(task: { title: string; spec: string }, modelRef: string): PlanDraft {
  return {
    strategyRef: 'template:single',
    costEstimateUSD: null,
    steps: [{
      id: 's1',
      role: 'worker',
      title: task.title,
      instructions: task.spec === '' ? task.title : task.spec,
      executorRef: 'api-loop',
      modelRef,
      skillRefs: [],
      isolation: 'worktree',
      zone: [],
      maxIterations: 25,
      dependsOn: [],
    }],
  }
}

export function buildProgram(kernel: Kernel): Command {
  const program = new Command('orc')
  program.description('multi-agent orchestrator')

  program
    .command('new <title>')
    .description('create a task')
    .option('--spec <text>', 'task description', '')
    .option('--parent <id>', 'parent task id')
    .action((title: string, opts: { spec: string; parent?: string }) => {
      const t = kernel.createTask({ title, spec: opts.spec, parentId: opts.parent })
      console.log(t.id)
    })

  program
    .command('propose <taskId>')
    .description('propose a plan (default: single-step template)')
    .option('--file <path>', 'plan draft JSON file')
    .option('--model <ref>', 'model for template steps', 'anthropic/claude-sonnet-5')
    .action((taskId: string, opts: { file?: string; model: string }) => {
      const task = kernel.getTask(taskId)
      if (!task) throw new Error(`no task '${taskId}'`)
      const draft = opts.file
        ? PlanDraft.parse(JSON.parse(readFileSync(opts.file, 'utf8')))
        : singleStepDraft(task, opts.model)
      const plan = kernel.proposePlan(taskId, draft)
      console.log(`plan v${plan.version} proposed (${plan.steps.length} steps) — review with: orc plan ${taskId}`)
    })

  program
    .command('plan <taskId>')
    .description('show a plan (latest by default)')
    .option('--version <n>', 'plan version')
    .action((taskId: string, opts: { version?: string }) => {
      const plan = kernel.getPlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
      if (!plan) throw new Error(`no plan for task '${taskId}'`)
      console.log(JSON.stringify(plan, null, 2))
    })

  program
    .command('approve <taskId>')
    .description('approve the latest plan (the human gate)')
    .option('--version <n>', 'expected version (fails if stale)')
    .action((taskId: string, opts: { version?: string }) => {
      const plan = kernel.approvePlan(taskId, opts.version === undefined ? undefined : Number(opts.version))
      console.log(`plan v${plan.version} approved`)
    })

  program
    .command('tasks')
    .description('list tasks')
    .action(() => {
      for (const t of kernel.listTasks())
        console.log(`${t.id}  ${t.status.padEnd(17)} ${t.title}`)
    })

  program
    .command('log <taskId>')
    .description('show the event trail for a task')
    .action((taskId: string) => {
      for (const e of kernel.eventsFor(taskId))
        console.log(`${String(e.seq).padStart(4)}  ${e.ts}  ${e.kind}`)
    })

  return program
}
```

`packages/cli/src/bin.ts`:
```ts
import { buildProgram, openKernel } from './main.js'

try {
  await buildProgram(openKernel()).parseAsync(process.argv)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}
```

- [ ] **Step 5: Run tests to verify green**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS (28 tests total), typecheck clean.

- [ ] **Step 6: Manual smoke test**

Run:
```bash
cd /tmp && mkdir -p orc-smoke && cd orc-smoke
node --import tsx /home/yanneck/Work/orchestrator/packages/cli/src/bin.ts new "smoke test" --spec "prove the cli works"
```
Expected: prints a UUID. Then with that id:
```bash
node --import tsx /home/yanneck/Work/orchestrator/packages/cli/src/bin.ts propose <id>
node --import tsx /home/yanneck/Work/orchestrator/packages/cli/src/bin.ts approve <id>
node --import tsx /home/yanneck/Work/orchestrator/packages/cli/src/bin.ts log <id>
```
Expected: propose/approve confirmations, then 5 events ending in `task_status_changed`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: orc CLI — new/propose/plan/approve/tasks/log

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Replay guarantee + README

**Files:**
- Test: `packages/kernel/src/replay.test.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: everything above. Produces no new API — this task locks in the spec §10 quality scenarios "Determinism" and "Robustness" as tests.

- [ ] **Step 1: Write the replay test (this is the point of the whole milestone)**

`packages/kernel/src/replay.test.ts`:
```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PlanDraft } from '@orc/contracts'
import { EventLog } from './eventlog.js'
import { Kernel } from './kernel.js'
import { fold } from './projections.js'

const draft = (): PlanDraft => ({
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 't', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'm', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
  }],
})

describe('replay guarantee (spec §10)', () => {
  it('a reopened kernel folds to the identical state ("kill -9" scenario)', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')

    const log1 = new EventLog(dbPath)
    const k1 = new Kernel(log1)
    const t = k1.createTask({ title: 'parent', spec: 'root task' })
    const child = k1.createTask({ title: 'child', parentId: t.id })
    k1.proposePlan(t.id, draft())
    k1.editPlan(t.id, draft())
    k1.approvePlan(t.id)
    const before = k1.state()
    log1.close() // simulated process death — nothing held in memory matters

    const k2 = new Kernel(new EventLog(dbPath))
    expect(k2.state()).toEqual(before)
    expect(k2.getTask(t.id)?.status).toBe('approved')
    expect(k2.getTask(child.id)?.status).toBe('draft')
  })

  it('the event trail is the complete story, in order', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')
    const log = new EventLog(dbPath)
    const k = new Kernel(log)
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    k.approvePlan(t.id)
    expect(log.byTask(t.id).map(e => e.kind)).toEqual([
      'task_created',
      'plan_proposed',
      'task_status_changed',
      'plan_approved',
      'task_status_changed',
    ])
  })

  it('fold twice over the same log yields equal states (pure replay)', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')
    const log = new EventLog(dbPath)
    const k = new Kernel(log)
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    expect(fold(log.all())).toEqual(fold(log.all()))
  })
})
```

- [ ] **Step 2: Run tests to verify green**

Run: `pnpm test`
Expected: all PASS (31 tests total). These should pass with no production changes — if any fail, the kernel has a replay bug: STOP and fix the kernel, do not adjust the test.

- [ ] **Step 3: Write README**

`README.md`:
```markdown
# orchestrator

A generic multi-agent orchestrator: recursive task splitting, human plan
approval, multi-provider agent dispatch, plugin-first. Design spec:
`docs/superpowers/specs/2026-07-16-orchestrator-design.md`.

## Status

M1 (foundation) — event-sourced kernel + CLI. Execution (M2), plugins (M3),
vault (M4), recursion/strategies (M5) follow the roadmap in
`docs/superpowers/plans/`.

## Quickstart

```bash
pnpm install && pnpm test

alias orc="node --import tsx $PWD/packages/cli/src/bin.ts"
orc new "write release notes" --spec "summarize changes since v1.2"
orc propose <task-id>        # single-step template plan
orc plan <task-id>           # review it
orc approve <task-id>        # the human gate
orc log <task-id>            # the full event trail
```

Every state change is an append-only event in `.orc/state.db`; all state is
a pure fold over that log — replay and audit come for free.
```

- [ ] **Step 4: Full suite + typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: 31 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: replay/restart guarantee + README quickstart

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage (M1 slice):** R9 traceability → Tasks 4, 8; R2 gate (manual approve) → Tasks 6, 7; R1 tree shape (`parentId`/`depth`/budget inheritance) → Task 6; §5.2 contracts subset → Tasks 1-3; §10 Determinism + Robustness scenarios → Task 8. Deliberately deferred per roadmap: execution/R3 (M2), plugins/R5 (M3), vault/R10 + memory/R6 (M4), recursion execution + ApprovalPolicy rules + isolation/R7 (M5). `CoordinationStrategy`/`TypedEdge` schemas land in M5 with the strategy engine that consumes them (YAGNI until then; `strategyRef` string field already reserves the seam).
- **Type consistency check:** `EventRecord` (not `Event`) everywhere; `PlanDraft` = `Plan.omit(taskId, version)`; `KernelError.code` values match test expectations; `fold` consumed by both `Kernel.state()` and replay tests.
- **No placeholders:** every step has complete code or exact commands.
