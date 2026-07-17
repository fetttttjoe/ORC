# M4a Event Stream + Vault Projector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a push-based event stream over the append-only log and project it into an OKF-compatible markdown vault (Obsidian-ready), with a live "current working graph" and a bidirectional plan-edit surface.

**Architecture:** `EventLog` gains `subscribe` backed by Postgres `LISTEN/NOTIFY` (seq-cursored, ordered, catch-up on connect) — the one datastream every live consumer uses. A new first-party `@orc/vault-projector` package (depends on `@orc/kernel` for `fold`/`EventLog`, so it lives under `packages/`, not `plugins/` — the "plugins import only contracts" rule is for swappable T-tier adapters, which this is not) renders each task's events to `vault/tasks/<id>/…` and is driven by the stream. Truth stays in the log; the vault is a disposable projection.

**Tech Stack:** Bun ≥ 1.3 (native `Bun.YAML`), TypeScript strict, zod, Drizzle/pg, `@dbos-inc/dbos-sdk` (unchanged), commander, compose Postgres.

**Spec:** `docs/superpowers/specs/2026-07-17-m4a-vault-projector-design.md`

## Global Constraints

- Bun ≥ 1.2 is package manager, runtime, AND test runner. No Node-specific tooling.
- TypeScript everywhere, strict. `moduleResolution: "bundler"`, extensionless relative imports, ESM only.
- `@orc/contracts` has exactly ONE runtime dependency: `zod`. The MCP/AI SDKs never enter contracts or kernel.
- **Postgres required** for integration tests: `docker compose up -d --wait` first; ephemeral DBs via `@orc/kernel/test-helpers` (`createTestDb`).
- Every state change is an event append through `EventLog`; in execution code every append happens inside a durable step. **M4a adds NO new domain event kinds** — the only kernel addition is `EventLog.subscribe` + a `pg_notify` on append.
- No scattered strings: matched values only via const maps from zod enums (`EVENT_KIND`, `TASK_STATUS`, `STEP_RUN_STATUS`, …).
- `Bun.YAML` is native to Bun 1.3 (verified: `parse` + `stringify`). No `yaml`/`js-yaml` dependency.
- Config house rule: orc's own settings resolve through ONE zod schema — defaults via `.default()`; a value derived from another resolved field is a documented cross-field derivation in `loadConfig`, not a scattered `??`.
- Tests colocated `src/**/*.test.ts`, `bun:test`, run with `bun test` from repo root. `bun run typecheck` must stay green — add every new package to the root `typecheck` script.
- Commit style: Conventional Commits, single-line subject, max 2 lines total, NO AI attribution or trailers of any kind.
- Markdown the projector writes uses `type` frontmatter (OKF). Only `plugins`… n/a. Projector writes ONLY under `vault/tasks/**` + `vault/index.md`; never `vault/memory/` or `vault/skills/`.

---

### Task 1: `EventLog.subscribe` (Postgres LISTEN/NOTIFY)

**Files:**
- Modify: `packages/kernel/src/eventlog.ts`
- Test: `packages/kernel/src/eventlog.subscribe.test.ts` (new)

**Interfaces:**
- Produces: `EventLog.subscribe(opts: { fromSeq?: number }, handler: (e: EventRecord) => void | Promise<void>): Promise<() => Promise<void>>` — delivers events with `seq > fromSeq` in ascending `seq` order, catches up on subscribe, then pushes on `NOTIFY`; returns an async unsubscribe. `fromSeq` default = latest seq at call time (only new events).
- Produces: every committed `append` issues `pg_notify('orc_events', '<seq>')`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/kernel/src/eventlog.subscribe.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import type { TaskNode } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import { createTestDb } from './test-helpers'
import { EventLog } from './eventlog'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop() })

const task = (id: string): TaskNode => ({
  id, parentId: null, type: 'generic', title: id, spec: '', status: 'draft',
  zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-17T00:00:00.000Z',
})
const appendCreated = (log: EventLog, id: string) =>
  log.append({ taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task(id) } })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('EventLog.subscribe', () => {
  it('catches up from fromSeq then pushes new appends in order', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = await EventLog.open(db.url)
    await appendCreated(log, 'a')
    await appendCreated(log, 'b')

    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    await sleep(50)
    expect(seen).toEqual([1, 2])              // catch-up

    await appendCreated(log, 'c')
    await sleep(100)
    expect(seen).toEqual([1, 2, 3])           // pushed, no poll

    await unsub()
    await log.close()
  })

  it('delivers nothing for a rolled-back transaction (commit-only)', async () => {
    const db = await createTestDb(); dbs.push(db)
    const log = await EventLog.open(db.url)
    const seen: number[] = []
    const unsub = await log.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    await sleep(30)
    await log.transaction(async tx => { await tx.append({ taskId: 'x', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: task('x') } }); throw new Error('rollback') }).catch(() => {})
    await sleep(100)
    expect(seen).toEqual([])
    await unsub()
    await log.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/kernel/src/eventlog.subscribe.test.ts`
Expected: FAIL — `log.subscribe is not a function`.

- [ ] **Step 3: Add `pg_notify` on append + store url + `subscribe`**

In `packages/kernel/src/eventlog.ts`:

Broaden the `Queryable` type and imports:

```ts
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
// ...
type Queryable = Pick<NodePgDatabase, 'insert' | 'select' | 'execute'>
```

In `makeOps(...).append`, after the insert `.returning(...)` and before `notify?.(record)`, add the commit-scoped NOTIFY (runs on the same connection/tx, so it fires only on commit):

```ts
    await db.execute(sql`select pg_notify('orc_events', ${String(row!.seq)})`)
```

Store the url and add the subscription (dedicated `pg.Client`, reads via the pool `db`):

```ts
  private constructor(
    private readonly pool: pg.Pool,
    private readonly db: NodePgDatabase,
    private readonly url: string,
  ) {
    this.ops = makeOps(db, e => this.onAppend?.(e))
  }

  static async open(url: string): Promise<EventLog> {
    const pool = new pg.Pool({ connectionString: url })
    const db = drizzle(pool)
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
    return new EventLog(pool, db, url)
  }

  private async latestSeq(): Promise<number> {
    const [row] = await this.db.select({ seq: events.seq }).from(events).orderBy(desc(events.seq)).limit(1)
    return row?.seq ?? 0
  }

  // Durable, ordered event stream (spec §4.1). One dedicated LISTEN connection; reads go
  // through the pool. Catch-up on connect closes the gap between fromSeq and now.
  async subscribe(
    opts: { fromSeq?: number },
    handler: (e: EventRecord) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    const client = new pg.Client({ connectionString: this.url })
    await client.connect()
    await client.query('LISTEN orc_events')
    let cursor = opts.fromSeq ?? (await this.latestSeq())
    let pumping = false
    let wakeAgain = false
    const pump = async (): Promise<void> => {
      if (pumping) { wakeAgain = true; return }
      pumping = true
      try {
        do {
          wakeAgain = false
          const rows = await this.db.select().from(events).where(gt(events.seq, cursor)).orderBy(asc(events.seq))
          for (const r of rows) { cursor = r.seq; await handler(toRecord(r)) }
        } while (wakeAgain)
      } finally { pumping = false }
    }
    client.on('notification', () => { void pump() })
    await pump() // initial catch-up
    return async () => { client.removeAllListeners('notification'); await client.end() }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/kernel/src/eventlog.subscribe.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add packages/kernel/src/eventlog.ts packages/kernel/src/eventlog.subscribe.test.ts
git commit -m "feat: EventLog.subscribe over Postgres LISTEN/NOTIFY"
```

---

### Task 2: Migrate the CLI event tail off polling

**Files:**
- Modify: `packages/kernel/src/kernel.ts` (add `subscribe` passthrough)
- Modify: `packages/cli/src/main.ts:47-65` (`tailUntilDone`)
- Test: `packages/kernel/src/kernel.test.ts` (add one case)

**Interfaces:**
- Consumes: `EventLog.subscribe` (Task 1).
- Produces: `Kernel.subscribe(opts: { fromSeq?: number }, handler): Promise<() => Promise<void>>` delegating to the log.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/kernel/src/kernel.test.ts
it('subscribe delivers appended events by seq', async () => {
  const seen: number[] = []
  const unsub = await kernel.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
  await kernel.createTask({ title: 'x' })
  await new Promise(r => setTimeout(r, 100))
  expect(seen.length).toBeGreaterThan(0)
  await unsub()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/kernel/src/kernel.test.ts -t subscribe`
Expected: FAIL — `kernel.subscribe is not a function`.

- [ ] **Step 3: Add the passthrough on `Kernel`**

In `packages/kernel/src/kernel.ts`, add a method to the `Kernel` class:

```ts
  subscribe(opts: { fromSeq?: number }, handler: (e: EventRecord) => void | Promise<void>): Promise<() => Promise<void>> {
    return this.log.subscribe(opts, handler)
  }
```

(`EventRecord` is already imported in this file.)

- [ ] **Step 4: Rewrite `tailUntilDone` to use the stream**

Replace `tailUntilDone` in `packages/cli/src/main.ts` with:

```ts
// stream-driven tail (spec §5): no polling — LISTEN/NOTIFY pushes each event as it commits
async function tailUntilDone(kernel: Kernel, taskId: string, handle: RunHandle): Promise<string> {
  const print = (e: EventRecord) => console.log(`${String(e.seq).padStart(4)}  ${e.kind}${e.stepId ? `  ${e.stepId}` : ''}`)
  let lastSeen = Math.max(0, ...(await kernel.eventsFor(taskId)).map(e => e.seq))
  const unsub = await kernel.subscribe({ fromSeq: lastSeen }, e => {
    if (e.taskId === taskId) { print(e); lastSeen = e.seq }
  })
  try {
    return await handle.wait()
  } finally {
    await unsub()
    for (const e of await kernel.eventsSince(taskId, lastSeen)) print(e) // drain final window
  }
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test packages/kernel/src/kernel.test.ts && bun run typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/kernel.ts packages/kernel/src/kernel.test.ts packages/cli/src/main.ts
git commit -m "refactor: stream-driven CLI tail, delete the poll"
```

---

### Task 3: `vaultDir` config + derived `skillsDir`

**Files:**
- Modify: `packages/kernel/src/config.ts`
- Test: `packages/kernel/src/config.test.ts` (add two cases)

**Interfaces:**
- Produces: `OrcConfig.vaultDir: string` (default `<dir>/vault`); `OrcConfig.skillsDir: string` = explicit value or `<vaultDir>/skills`.

- [ ] **Step 1: Write the failing test**

```ts
// add to packages/kernel/src/config.test.ts
it('vaultDir defaults under dir and skillsDir derives from it', () => {
  const c = loadConfig('/proj')
  expect(c.vaultDir).toBe(path.join('/proj', 'vault'))
  expect(c.skillsDir).toBe(path.join('/proj', 'vault', 'skills'))
})

it('overriding vaultDir moves skillsDir with it', () => {
  const d = tmpProject({ vaultDir: 'kb' })   // helper writes .orc/config.json
  const c = loadConfig(d)
  expect(c.vaultDir).toBe(path.join(d, 'kb'))
  expect(c.skillsDir).toBe(path.join(d, 'kb', 'skills'))
})
```

If `config.test.ts` lacks a `tmpProject` helper, add at top of the file:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
function tmpProject(cfg: Record<string, unknown>): string {
  const d = mkdtempSync(path.join(tmpdir(), 'orc-cfg-'))
  mkdirSync(path.join(d, '.orc'), { recursive: true })
  writeFileSync(path.join(d, '.orc', 'config.json'), JSON.stringify(cfg))
  return d
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/kernel/src/config.test.ts -t vaultDir`
Expected: FAIL — `c.vaultDir` is `undefined`.

- [ ] **Step 3: Add `vaultDir`, make `skillsDir` derived**

In `packages/kernel/src/config.ts`, inside `settingsSchema(dir)` object, replace the `skillsDir` line and add `vaultDir`:

```ts
    vaultDir: z.string().default(path.join(dir, 'vault')).transform(p => path.resolve(dir, p)),
    skillsDir: z.string().optional().transform(p => (p === undefined ? undefined : path.resolve(dir, p))),
```

Update `OrcConfig` so `skillsDir` is always present:

```ts
export type OrcConfig = Omit<z.infer<ReturnType<typeof settingsSchema>>, 'skillsDir'> & {
  dir: string
  systemDatabaseUrl: string
  appVersion: string
  skillsDir: string
}
```

In `loadConfig`'s return object, add the derivation:

```ts
  return {
    ...parsed.data,
    dir,
    skillsDir: parsed.data.skillsDir ?? path.join(parsed.data.vaultDir, 'skills'),
    systemDatabaseUrl: deriveSystemUrl(parsed.data.databaseUrl),
    appVersion: APP_VERSION,
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test packages/kernel/src/config.test.ts && bun run typecheck`
Expected: PASS; no type errors. (Existing skills tests still green — default unchanged.)

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/config.ts packages/kernel/src/config.test.ts
git commit -m "feat: vaultDir config, skillsDir derived from it"
```

---

### Task 4: Create `@orc/vault-projector` package + plan round-trip

**Files:**
- Create: `packages/vault-projector/package.json`
- Create: `packages/vault-projector/tsconfig.json`
- Create: `packages/vault-projector/src/plan-md.ts`
- Test: `packages/vault-projector/src/plan-md.test.ts`
- Modify: root `package.json` (`typecheck` script)

**Interfaces:**
- Produces: `renderPlanFile(plan: Plan, status: string): string`
- Produces: `parsePlanFile(text: string): PlanDraft` (throws on bad fence / invalid YAML / schema failure)

- [ ] **Step 1: Scaffold the package**

Create `packages/vault-projector/package.json`:

```json
{
  "name": "@orc/vault-projector",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@orc/contracts": "workspace:*",
    "@orc/kernel": "workspace:*"
  }
}
```

Create `packages/vault-projector/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Append to the root `package.json` `typecheck` script (add at the end of the chain):

```
 && tsc --noEmit -p packages/vault-projector
```

Run: `bun install`
Expected: workspace linked, no errors.

- [ ] **Step 2: Write the failing round-trip test**

```ts
// packages/vault-projector/src/plan-md.ts test
import { describe, expect, it } from 'bun:test'
import { PlanDraft } from '@orc/contracts'
import { draftFixture, planFixture, stepFixture } from '@orc/contracts/fixtures'
import { parsePlanFile, renderPlanFile } from './plan-md'

describe('plan-md round-trip', () => {
  it('parse(render(plan)) equals the draft, including arrays and null cost', () => {
    const plan = planFixture({
      costEstimateUSD: null,
      steps: [
        stepFixture({ id: 's1', dependsOn: [], skillRefs: ['a'], toolRefs: ['srv/tool'] }),
        stepFixture({ id: 's2', dependsOn: ['s1'], skillRefs: [], toolRefs: [] }),
      ],
    })
    const parsed = parsePlanFile(renderPlanFile(plan, 'awaiting_approval'))
    expect(parsed).toEqual(PlanDraft.parse(draftFixture(plan.steps)))
  })

  it('throws on missing frontmatter fence', () => {
    expect(() => parsePlanFile('# no fence')).toThrow()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test packages/vault-projector/src/plan-md.test.ts`
Expected: FAIL — cannot find `./plan-md`.

- [ ] **Step 4: Implement `plan-md.ts`**

```ts
// packages/vault-projector/src/plan-md.ts
import { PlanDraft, type Plan } from '@orc/contracts'

const FENCE = '---'

export function renderPlanFile(plan: Plan, status: string): string {
  const front = Bun.YAML.stringify({
    type: 'plan',
    task: plan.taskId,
    version: plan.version,
    status,
    strategyRef: plan.strategyRef,
    costEstimateUSD: plan.costEstimateUSD,
    steps: plan.steps,
  })
  const summary = plan.steps
    .map(s => `- **${s.id}** (${s.role}) — ${s.title} · ${s.executorRef} · ${s.modelRef} · ${s.isolation}`)
    .join('\n')
  return `${FENCE}\n${front}${FENCE}\n\n# Plan v${plan.version}\n\n${summary}\n\n` +
    `> The frontmatter above is authoritative. Edit it, then run \`orc edit ${plan.taskId} --from-vault\` to apply as a new version.\n`
}

export function parsePlanFile(text: string): PlanDraft {
  if (!text.startsWith(`${FENCE}\n`)) throw new Error('plan file missing frontmatter fence')
  const end = text.indexOf(`\n${FENCE}`, FENCE.length)
  if (end === -1) throw new Error('plan file has unclosed frontmatter fence')
  const data = Bun.YAML.parse(text.slice(FENCE.length + 1, end)) as Record<string, unknown>
  return PlanDraft.parse({
    strategyRef: data.strategyRef,
    costEstimateUSD: data.costEstimateUSD ?? null,
    steps: data.steps,
  })
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `bun test packages/vault-projector/src/plan-md.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/vault-projector package.json bun.lock
git commit -m "feat: vault-projector package, plan-md round-trip via Bun.YAML"
```

---

### Task 5: Renderer (`render.ts`) — task files, mermaid DAG, log, sessions, root index

**Files:**
- Create: `packages/vault-projector/src/render.ts`
- Test: `packages/vault-projector/src/render.test.ts`

**Interfaces:**
- Consumes: `renderPlanFile` (Task 4); `fold`, `taskUsage`, `State`, `StepState` from `@orc/kernel`.
- Produces: `type VaultFiles = Record<string, string>` (relPath under vaultDir → content)
- Produces: `renderTaskFiles(taskId: string, events: EventRecord[]): VaultFiles`
- Produces: `renderRootIndex(tasks: TaskNode[]): string` (returns `index.md` body)

- [ ] **Step 1: Write the failing test**

```ts
// packages/vault-projector/src/render.test.ts
import { describe, expect, it } from 'bun:test'
import type { EventRecord, TaskNode } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import { planFixture, stepFixture } from '@orc/contracts/fixtures'
import { renderRootIndex, renderTaskFiles } from './render'

let seq = 0
const ev = (over: Partial<EventRecord>): EventRecord => ({
  seq: ++seq, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created,
  payload: {}, usage: null, ts: '2026-07-17T00:00:00.000Z', ...over,
})
const task = (over: Partial<TaskNode> = {}): TaskNode => ({
  id: 't1', parentId: null, type: 'generic', title: 'demo', spec: 'do it', status: 'running',
  zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-17T00:00:00.000Z', ...over,
})

describe('renderTaskFiles', () => {
  it('emits task index with a mermaid DAG, a plan file, log, and a session', () => {
    seq = 0
    const plan = planFixture({ taskId: 't1', version: 1, steps: [stepFixture({ id: 's1' })] })
    const events: EventRecord[] = [
      ev({ kind: EVENT_KIND.task_created, payload: { task: task() } }),
      ev({ kind: EVENT_KIND.plan_proposed, payload: { plan } }),
      ev({ kind: EVENT_KIND.step_started, stepId: 's1', runToken: 'r', payload: { stepId: 's1', runToken: 'r', attempt: 1 } }),
      ev({ kind: EVENT_KIND.tool_call, stepId: 's1', runToken: 'r', payload: { stepId: 's1', runToken: 'r', iteration: 1, toolCallId: 'c1', toolName: 'fs_write', input: { path: 'x.txt' } } }),
    ]
    const files = renderTaskFiles('t1', events)
    expect(files['tasks/t1/index.md']).toContain('type: task')
    expect(files['tasks/t1/index.md']).toContain('graph TD')
    expect(files['tasks/t1/index.md']).toContain('s1')
    expect(files['tasks/t1/plan-v1.md']).toContain('type: plan')
    expect(files['tasks/t1/log.md']).toContain('type: log')
    expect(files['tasks/t1/sessions/s1.md']).toContain('fs_write')
  })
})

describe('renderRootIndex', () => {
  it('lists running tasks under active runs', () => {
    const md = renderRootIndex([task({ status: 'running' })])
    expect(md).toContain('type: index')
    expect(md).toContain('Active runs')
    expect(md).toContain('tasks/t1/index.md')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/vault-projector/src/render.test.ts`
Expected: FAIL — cannot find `./render`.

- [ ] **Step 3: Implement `render.ts`**

Note the mermaid generator emits triple-backtick fences; this block is wrapped in a four-backtick fence so those inner fences don't terminate it.

````ts
// packages/vault-projector/src/render.ts
import { EVENT_KIND, STEP_RUN_STATUS, TASK_STATUS, type EventRecord, type Plan, type TaskNode } from '@orc/contracts'
import { fold, taskUsage, type State, type StepState } from '@orc/kernel'
import { renderPlanFile } from './plan-md'

export type VaultFiles = Record<string, string>

const fm = (obj: Record<string, unknown>, body: string): string => `---\n${Bun.YAML.stringify(obj)}---\n\n${body}\n`
const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s)

const statusClass = (s: StepState | undefined): 'done' | 'running' | 'failed' | 'pending' =>
  !s ? 'pending'
    : s.status === STEP_RUN_STATUS.completed ? 'done'
    : s.status === STEP_RUN_STATUS.failed ? 'failed'
    : 'running'

function mermaidDag(plan: Plan, steps: Map<string, StepState> | undefined): string {
  const lines = ['```mermaid', 'graph TD']
  for (const st of plan.steps) {
    const s = steps?.get(st.id)
    const iter = s && s.status === STEP_RUN_STATUS.running ? ` · iter ${s.iterations}` : ''
    lines.push(`  ${st.id}["${st.id} · ${st.executorRef} · ${st.modelRef}${iter}"]:::${statusClass(s)}`)
  }
  for (const st of plan.steps) for (const d of st.dependsOn) lines.push(`  ${d} --> ${st.id}`)
  lines.push('  classDef done fill:#1a7f37,color:#fff')
  lines.push('  classDef running fill:#bf8700,color:#fff')
  lines.push('  classDef failed fill:#cf222e,color:#fff')
  lines.push('  classDef pending fill:#6e7781,color:#fff')
  lines.push('```')
  return lines.join('\n')
}

function renderTaskIndex(task: TaskNode, plan: Plan | undefined, steps: Map<string, StepState> | undefined, state: State): string {
  const links = [
    plan ? `- [Plan v${plan.version}](plan-v${plan.version}.md)` : '',
    '- [Log](log.md)',
    ...(plan?.steps ?? []).map(s => `- [Session: ${s.id}](sessions/${s.id}.md)`),
  ].filter(Boolean).join('\n')
  const dag = plan ? mermaidDag(plan, steps) : '_no plan yet_'
  const u = taskUsage(state, task.id)
  return fm(
    { type: 'task', id: task.id, title: task.title, status: task.status, parent: task.parentId, depth: task.depth, budgetUSD: task.budgetUSD },
    `# ${task.title}\n\n${task.spec || '_no spec_'}\n\n## Working graph\n\n${dag}\n\n## Artifacts\n\n${links}\n\n_tokens in/out: ${u.inputTokens}/${u.outputTokens}_`,
  )
}

function renderLog(events: EventRecord[]): string {
  const rows = [...events].reverse()
    .map(e => `- \`${String(e.seq).padStart(4)}\` ${e.ts} · **${e.kind}**${e.stepId ? ` · ${e.stepId}` : ''}`)
    .join('\n')
  return fm({ type: 'log' }, `# Log\n\n${rows || '_empty_'}`)
}

function renderSession(stepId: string, events: EventRecord[], step: StepState | undefined): string {
  const parts: string[] = []
  for (const e of events) {
    const p = e.payload as Record<string, any>
    if (e.kind === EVENT_KIND.agent_call) parts.push(`### Iteration ${p.iteration}\n\n${p.response?.text || '_(tool-only turn)_'}`)
    else if (e.kind === EVENT_KIND.tool_call) parts.push(`- 🔧 **${p.toolName}** \`${truncate(JSON.stringify(p.input), 200)}\``)
    else if (e.kind === EVENT_KIND.tool_result) parts.push(`  ↳ ${p.isError ? '❌' : '✓'} \`${truncate(JSON.stringify(p.output), 200)}\``)
    else if (e.kind === EVENT_KIND.signal_received) parts.push(`### Signal: ${p.signal.outcome}\n\n${p.signal.summary}`)
  }
  return fm({ type: 'session', step: stepId, status: step?.status ?? 'pending' }, `# Session: ${stepId}\n\n${parts.join('\n') || '_no activity yet_'}`)
}

export function renderTaskFiles(taskId: string, events: EventRecord[]): VaultFiles {
  const state = fold(events)
  const task = state.tasks.get(taskId)
  if (!task) return {}
  const base = `tasks/${taskId}`
  const plans = state.plans.get(taskId)
  const steps = state.steps.get(taskId)
  const files: VaultFiles = {
    [`${base}/index.md`]: renderTaskIndex(task, plans?.versions.at(-1), steps, state),
    [`${base}/log.md`]: renderLog(events),
  }
  for (const p of plans?.versions ?? []) files[`${base}/plan-v${p.version}.md`] = renderPlanFile(p, task.status)
  const byStep = new Map<string, EventRecord[]>()
  for (const e of events) if (e.stepId) { const a = byStep.get(e.stepId) ?? []; a.push(e); byStep.set(e.stepId, a) }
  for (const [stepId, evs] of byStep) files[`${base}/sessions/${stepId}.md`] = renderSession(stepId, evs, steps?.get(stepId))
  return files
}

export function renderRootIndex(tasks: TaskNode[]): string {
  const link = (t: TaskNode, suffix: string): string => `- [${t.title}](tasks/${t.id}/index.md) — ${suffix}`
  const running = tasks.filter(t => t.status === TASK_STATUS.running)
  const active = running.length ? running.map(t => link(t, 'running')).join('\n') : '_none_'
  const all = tasks.length ? tasks.map(t => link(t, t.status)).join('\n') : '_no tasks_'
  return fm({ type: 'index' }, `# Vault\n\n## Active runs\n\n${active}\n\n## All tasks\n\n${all}`)
}
````

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test packages/vault-projector/src/render.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/vault-projector/src/render.ts packages/vault-projector/src/render.test.ts
git commit -m "feat: vault renderer with live mermaid DAG, log, sessions"
```

---

### Task 6: Writer (`write.ts`) — atomic, skip-unchanged, write-once, drift warn

**Files:**
- Create: `packages/vault-projector/src/write.ts`
- Test: `packages/vault-projector/src/write.test.ts`

**Interfaces:**
- Consumes: `VaultFiles` (Task 5).
- Produces: `writeVaultFiles(vaultDir: string, files: VaultFiles): void` — atomic per-file writes; skips unchanged; never rewrites an existing `plan-v<N>.md`; warns before overwriting a hand-edited projection-only file; maintains `<vaultDir>/.orc-manifest.json`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/vault-projector/src/write.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeVaultFiles } from './write'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
const vault = () => { const d = mkdtempSync(path.join(tmpdir(), 'orc-vault-')); dirs.push(d); return d }

describe('writeVaultFiles', () => {
  it('writes files, is idempotent, and never leaves .tmp files', () => {
    const d = vault()
    writeVaultFiles(d, { 'tasks/t1/log.md': 'a' })
    expect(readFileSync(path.join(d, 'tasks/t1/log.md'), 'utf8')).toBe('a')
    expect(existsSync(path.join(d, 'tasks/t1/log.md.tmp'))).toBe(false)
    // idempotent: re-write identical content changes nothing (mtime check via content compare only)
    writeVaultFiles(d, { 'tasks/t1/log.md': 'a' })
    expect(readFileSync(path.join(d, 'tasks/t1/log.md'), 'utf8')).toBe('a')
  })

  it('never rewrites an existing plan version (write-once protects edits)', () => {
    const d = vault()
    writeVaultFiles(d, { 'tasks/t1/plan-v1.md': 'original' })
    writeVaultFiles(d, { 'tasks/t1/plan-v1.md': 'regenerated' })
    expect(readFileSync(path.join(d, 'tasks/t1/plan-v1.md'), 'utf8')).toBe('original')
  })

  it('overwrites a hand-edited projection-only file (disposable)', () => {
    const d = vault()
    writeVaultFiles(d, { 'tasks/t1/log.md': 'v1' })
    writeFileSync(path.join(d, 'tasks/t1/log.md'), 'HAND EDIT')
    writeVaultFiles(d, { 'tasks/t1/log.md': 'v2' })
    expect(readFileSync(path.join(d, 'tasks/t1/log.md'), 'utf8')).toBe('v2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/vault-projector/src/write.test.ts`
Expected: FAIL — cannot find `./write`.

- [ ] **Step 3: Implement `write.ts`**

```ts
// packages/vault-projector/src/write.ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { VaultFiles } from './render'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const isPlanFile = (rel: string): boolean => /\/plan-v\d+\.md$/.test(rel)

// Single writer for the trace subtree (spec D5). Atomic per file, skip-unchanged,
// write-once for plan versions, warn-then-overwrite for hand-edited projection files.
export function writeVaultFiles(vaultDir: string, files: VaultFiles): void {
  const manifestPath = path.join(vaultDir, '.orc-manifest.json')
  let manifest: Record<string, string> = {}
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { manifest = {} }

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vaultDir, rel)
    const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    if (onDisk === content) continue                       // unchanged
    if (isPlanFile(rel) && onDisk !== null) continue       // write-once (protects human edits)
    if (!isPlanFile(rel) && onDisk !== null && sha(onDisk) !== manifest[rel])
      console.warn(`vault: ${rel} was hand-edited; it is projection-only and is being overwritten`)
    mkdirSync(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, abs)                                   // atomic swap
    manifest[rel] = sha(content)
  }
  mkdirSync(vaultDir, { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test packages/vault-projector/src/write.test.ts && bun run typecheck`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/vault-projector/src/write.ts packages/vault-projector/src/write.test.ts
git commit -m "feat: atomic single-writer with write-once plans and drift warn"
```

---

### Task 7: `createVaultProjector` + runtime/CLI wiring

**Files:**
- Create: `packages/vault-projector/src/index.ts`
- Test: `packages/vault-projector/src/index.test.ts`
- Modify: `packages/cli/src/runtime.ts` (build + start the projector during runs)
- Modify: `packages/cli/src/main.ts` (`orc vault render`, `orc edit --from-vault`, render after mutations)
- Modify: `packages/cli/src/bin.ts` (await projector `close()` in shutdown)
- Modify: `packages/cli/package.json` (add `@orc/vault-projector` dep)

**Interfaces:**
- Consumes: `renderTaskFiles`, `renderRootIndex` (Task 5); `writeVaultFiles` (Task 6); `EventLog`/`OrcConfig`/`fold` (kernel).
- Produces: `createVaultProjector({ log, config }): VaultProjector` with `{ renderTask(taskId), renderAll(), start(), close(), parsePlanFile }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/vault-projector/src/index.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Kernel, EventLog } from '@orc/kernel'
import { createTestDb } from '@orc/kernel/test-helpers'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { createVaultProjector } from './index'

const dbs: Array<{ drop: () => Promise<void> }> = []
const dirs: string[] = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('createVaultProjector.renderAll', () => {
  it('renders a task tree from the log', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vp-')); dirs.push(vaultDir)
    const log = await EventLog.open(db.url)
    const kernel = new Kernel(log)
    const t = await kernel.createTask({ title: 'demo', spec: 'do it' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', modelRef: 'anthropic/claude-sonnet-5' })]))

    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.renderAll()
    await projector.close()

    expect(existsSync(path.join(vaultDir, 'index.md'))).toBe(true)
    expect(readFileSync(path.join(vaultDir, `tasks/${t.id}/index.md`), 'utf8')).toContain('type: task')
    expect(existsSync(path.join(vaultDir, `tasks/${t.id}/plan-v1.md`))).toBe(true)
    await log.close()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/vault-projector/src/index.test.ts`
Expected: FAIL — cannot find `./index`.

- [ ] **Step 3: Implement `index.ts`**

```ts
// packages/vault-projector/src/index.ts
import { fold, type EventLog } from '@orc/kernel'
import { renderRootIndex, renderTaskFiles } from './render'
import { writeVaultFiles } from './write'

export { parsePlanFile, renderPlanFile } from './plan-md'
export { renderRootIndex, renderTaskFiles, type VaultFiles } from './render'
export { writeVaultFiles } from './write'

export interface VaultProjector {
  renderTask(taskId: string): Promise<void>
  renderAll(): Promise<void>
  start(): Promise<void>
  close(): Promise<void>
}

// Only vaultDir is consumed; a structural type keeps the projector decoupled from
// full OrcConfig (runtime passes the whole config; tests pass just { vaultDir }).
export function createVaultProjector(opts: { log: EventLog; config: { vaultDir: string } }): VaultProjector {
  const { log } = opts
  const vaultDir = opts.config.vaultDir
  let unsub: (() => Promise<void>) | null = null
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const renderRoot = async (): Promise<void> => {
    const tasks = [...fold(await log.all()).tasks.values()]
    writeVaultFiles(vaultDir, { 'index.md': renderRootIndex(tasks) })
  }
  const renderTask = async (taskId: string): Promise<void> => {
    writeVaultFiles(vaultDir, renderTaskFiles(taskId, await log.byTask(taskId)))
    await renderRoot()
  }
  const renderAll = async (): Promise<void> => {
    const byTask = new Set((await log.all()).map(e => e.taskId))
    for (const id of byTask) writeVaultFiles(vaultDir, renderTaskFiles(id, await log.byTask(id)))
    await renderRoot()
  }
  const flush = async (): Promise<void> => {
    const ids = [...timers.keys()]
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    for (const id of ids) await renderTask(id)
  }

  return {
    renderTask, renderAll,
    start: async () => {
      await renderAll()
      unsub = await log.subscribe({}, e => {
        const prev = timers.get(e.taskId)
        if (prev) clearTimeout(prev)
        // coalesce a burst into one render per task (spec §5) — not a poll
        timers.set(e.taskId, setTimeout(() => { timers.delete(e.taskId); void renderTask(e.taskId) }, 50))
      })
    },
    close: async () => {
      if (unsub) { await unsub(); unsub = null }
      await flush()
    },
  }
}
```

- [ ] **Step 4: Run the package test + typecheck**

Run: `bun test packages/vault-projector/src/index.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Wire the projector into the CLI runtime**

Add the dependency to `packages/cli/package.json` `dependencies`: `"@orc/vault-projector": "workspace:*"`, then `bun install`.

In `packages/cli/src/runtime.ts`, import and start the projector inside `buildRuntime` so runs project live:

```ts
import { createVaultProjector } from '@orc/vault-projector'
// ... inside buildRuntime, after `const port = await createDbosPort(...)` and `await port.launch()`:
  const projector = createVaultProjector({ log, config })
  await projector.start()
  host.skills.watch()
  return {
    ...port,
    shutdown: async () => {
      await projector.close()
      await hub.close()
      await host.shutdown()
      await port.shutdown()
    },
  }
```

- [ ] **Step 6: Give `buildProgram` the `EventLog` (needed for the vault command)**

The `vault` command builds a projector, which needs the `EventLog`. Extend the `plugin` param object with `log` FIRST, so the command below can use `needPlugin().log` directly. In `packages/cli/src/main.ts` change the signature and import:

```ts
import { EventLog, Kernel, grantTrust, loadConfig, taskUsage, type OrcConfig, type PluginHost } from '@orc/kernel'
// ...
export function buildProgram(
  kernel: Kernel,
  portFactory?: () => Promise<ExecutionPort>,
  plugin?: { host: PluginHost; hub: McpHub; config: OrcConfig; log: EventLog },
): Command {
```

In `packages/cli/src/bin.ts`, pass `log` (already in scope from `openKernel`'s `{ kernel, log }`) into the plugin object:

```ts
  await buildProgram(
    kernel,
    async () => (runtime.port ??= await buildRuntime({ ...plugins, config, log })),
    { host: plugins.host, hub: plugins.hub, config, log },
  ).parseAsync(process.argv)
```

Update the three CLI test call sites (`main.test.ts`, `exec-commands.test.ts`, `plugin-commands.test.ts`) that call `buildProgram` with a plugin object to include `log` (each already has the `EventLog` via `openKernel`'s returned `{ kernel, log }`).

- [ ] **Step 7: Add `orc vault render` and `orc edit --from-vault`**

In `packages/cli/src/main.ts`, add the import and extend `resolveDraft` to read the vault plan file:

```ts
import { parsePlanFile, createVaultProjector } from '@orc/vault-projector'
// add readdirSync to the existing `node:fs` import: import { readdirSync, readFileSync } from 'node:fs'
// ...
function resolveDraft(task: { title: string; spec: string }, opts: { file?: string; model: string; fromVault?: boolean }, taskId: string, config?: OrcConfig): PlanDraft {
  if (opts.fromVault) {
    if (!config) throw new Error('--from-vault is unavailable in this context')
    const dir = path.join(config.vaultDir, 'tasks', taskId)
    const files = readdirSync(dir).filter(f => /^plan-v\d+\.md$/.test(f)).sort()
    const latest = files.at(-1)
    if (!latest) throw new Error(`no plan file in ${dir} — run 'orc vault render ${taskId}' first`)
    return parsePlanFile(readFileSync(path.join(dir, latest), 'utf8'))
  }
  return opts.file ? PlanDraft.parse(JSON.parse(readFileSync(opts.file, 'utf8'))) : singleStepDraft(task, opts.model)
}
```

The `edit` command's action calls `resolveDraft(task, opts, taskId, plugin?.config)` (thread `taskId` and `plugin?.config` through the existing `planAction` closure). Add the `--from-vault` option and the `vault` command:

```ts
// on the existing `edit` command:
    .option('--from-vault', 'read the edited plan markdown from the vault')

  program
    .command('vault')
    .argument('[taskId]', 'render one task (default: all)')
    .description('render the OKF vault from the event log')
    .action(async (taskId?: string) => {
      const { config, log } = needPlugin()
      const projector = createVaultProjector({ log, config })
      if (taskId) await projector.renderTask(taskId)
      else await projector.renderAll()
      await projector.close()
      console.log(`vault rendered → ${config.vaultDir}`)
    })
```

- [ ] **Step 8: Add a CLI test for `orc vault render`**

```ts
// add to packages/cli/src/plugin-commands.test.ts (or a new vault-commands.test.ts)
it('orc vault render writes the task tree', async () => {
  const t = await kernel.createTask({ title: 'demo', spec: 'do it' })
  await run('vault', t.id)
  // config.vaultDir points inside the test project dir
  const idx = path.join(config.vaultDir, 'tasks', t.id, 'index.md')
  expect(existsSync(idx)).toBe(true)
})
```

- [ ] **Step 9: Run tests + typecheck**

Run: `bun test packages/vault-projector packages/cli && bun run typecheck`
Expected: PASS across projector + CLI.

- [ ] **Step 10: Commit**

```bash
git add packages/vault-projector/src/index.ts packages/vault-projector/src/index.test.ts packages/cli bun.lock
git commit -m "feat: wire vault projector into runtime and CLI"
```

---

### Task 8: Integration — full run projects a live vault

**Files:**
- Test: `packages/kernel/src/execution/vault-run.test.ts` (new; mirrors `mcp-run.test.ts` harness)

**Interfaces:**
- Consumes: everything above; the fake-provider run harness from `test-helpers` / existing port tests.

- [ ] **Step 1: Write the integration test**

```ts
// packages/kernel/src/execution/vault-run.test.ts
import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createTestDb } from '../test-helpers'
import { EventLog } from '../eventlog'
import { Kernel } from '../kernel'
import { createVaultProjector } from '@orc/vault-projector'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'

const dbs: Array<{ drop: () => Promise<void> }> = []
const dirs: string[] = []
afterEach(async () => { for (const d of dbs.splice(0)) await d.drop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe('vault projection over a run', () => {
  it('renders task/plan/log/sessions after approving and folding a run log', async () => {
    const db = await createTestDb(); dbs.push(db)
    const vaultDir = mkdtempSync(path.join(tmpdir(), 'orc-vrun-')); dirs.push(vaultDir)
    const log = await EventLog.open(db.url)
    const kernel = new Kernel(log)
    const t = await kernel.createTask({ title: 'demo', spec: 'do it' })
    await kernel.proposePlan(t.id, draftFixture([stepFixture({ id: 's1', modelRef: 'fake/m' })]))
    await kernel.approvePlan(t.id)

    const projector = createVaultProjector({ log, config: { vaultDir } })
    await projector.renderAll()
    await projector.close()

    expect(readFileSync(path.join(vaultDir, `tasks/${t.id}/index.md`), 'utf8')).toContain('graph TD')
    expect(existsSync(path.join(vaultDir, `tasks/${t.id}/plan-v1.md`))).toBe(true)
    expect(readFileSync(path.join(vaultDir, `tasks/${t.id}/log.md`), 'utf8')).toContain('plan_approved')
    await log.close()
  })
})
```

- [ ] **Step 2: Run + verify**

Run: `bun test packages/kernel/src/execution/vault-run.test.ts`
Expected: PASS.

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test && bun run typecheck`
Expected: all pass (existing suites unaffected: new event stream is additive; no new event kinds; replay identity holds).

- [ ] **Step 4: Commit**

```bash
git add packages/kernel/src/execution/vault-run.test.ts
git commit -m "test: vault projection over a full task log"
```

---

## Self-Review

**Spec coverage:**
- §4.1 event stream → Task 1 (subscribe + notify), Task 2 (CLI consumer).
- D1 pure renderer / EventRecord input → Task 5.
- D2 commit-only, seq-ordered, catch-up → Task 1 tests.
- D3 one seam → subscribe is the only new interface.
- D4 vaultDir/skillsDir → Task 3.
- D5 two graphs / trace-only ownership → Task 6 writes only under `tasks/` + `index.md`; write-once plan.
- D6 mermaid working graph + active runs → Task 5.
- D7 no broker → LISTEN/NOTIFY only (Task 1).
- §7 plan round-trip → Task 4.
- §8 hand-edit detection → Task 6.
- §10 tests → Tasks 1,4,5,6,7,8.
- §11 order → tasks are in that order.
- RQ1–RQ6 → RQ1/RQ3 (Tasks 5,7), RQ2 history (whole plan), RQ4 stream (Tasks 1,2), RQ5 (Tasks 4,7), RQ6 deferred (M4b, noted).

**Placeholder scan:** none. Task 7 extends `buildProgram` with `log` (Step 6) before the `vault` command uses it (Step 7), so there is no transient placeholder; every code step shows complete code.

**Type consistency:** `VaultFiles`, `renderTaskFiles`, `renderRootIndex`, `renderPlanFile`, `parsePlanFile`, `writeVaultFiles`, `createVaultProjector`, `EventLog.subscribe`, `Kernel.subscribe` are used with identical signatures across tasks. `STEP_RUN_STATUS`/`EVENT_KIND` const maps used (no string literals for matched values).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-17-m4a-event-stream-vault-projector.md`.
