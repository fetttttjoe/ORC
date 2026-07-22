# orc-sim — Architecture Summary

> A synthesis of the verified knowledge map (arch-overview + area-* notes) against the
> codebase. Every claim traces to an area note and a source path; see the coverage
> footer for the mapping. Reflects source revision `37d80b1152c5…`.

## 1. What it is

**orc** ("orchestrator") is a generic, recursive multi-agent orchestrator: it splits a task
into a plan of steps, gets the plan approved by a human, dispatches each step to an agent
backed by any of several model providers, and lets an agent recursively split its own
sub-tasks — all while every action is recorded as an event. It is a TypeScript / Bun
monorepo, **plugin-first** (providers, executor, MCP tool sources, and the memory model are
all replaceable plugins) and **event-sourced** to its core. The codebase divides into
`packages/*` (the policy-free core and first-party runtime tiers) and `plugins/*`
(replaceable behavior). *(arch-overview; `docs/ARCHITECTURE.md`, `packages/`, `plugins/`)*

## 2. The governing invariant — the event log is the only truth

Everything else in the architecture is a consequence of one rule:

> **The Postgres event log is the only source of truth. All state is `fold(events)`.
> Every other store is either a rebuildable index over the log or a disposable projection
> of it.**

`packages/kernel/src/projections.ts` is the literal realization: `fold(events) → State`
(tasks, plans, steps, runs, splits, operations), with `applyOperationEvent` shared by the
live journal and rebuild-from-log so both agree. The operations journal, the SurrealDB
knowledge graph, the vault markdown, the live UI graph, and even DBOS's own system DB are
all downstream of the log — none of them holds truth, and each can be reconstructed by
replaying events. This is why a rebuild is always possible, why replay/audit is exact, and
why "projections never hold truth" is enforceable rather than aspirational.
*(arch-overview; area-storage; area-kernel — `projections.ts`)*

The invariant is protected at the write boundary. Every append is **one atomic, locked,
redacted, notified transaction**: jsonb-shape → redact → validate → insert → `pg_notify`,
serialized by a per-project advisory lock (`packages/kernel/src/storage/event-log.ts`,
`postgres.ts`). Redaction happens exactly once here (`packages/kernel/src/redact.ts`), so
every projection downstream only ever sees already-redacted data. *(area-storage)*

## 3. The three-tier dependency rule

Business logic **never touches a database directly** — every read/write crosses a
data-access service:

- **App / entrypoints** (cli, ui) call kernel + plugins; they never open a pool.
- **Data-access services** are the only DB boundary: `openStorage → Storage{events,
  operations}` for Postgres, `openKnowledge → Knowledge` for Surreal.
- **Stores** (Postgres, Surreal, vault files, DBOS system DB) sit behind those services.

Layered on top is the import/ownership rule:

- **contracts import nothing** — they are the dependency root (§4).
- **kernel imports contracts** and *receives* plugins (via `createDbosPort` /
  `createPluginHost`); **the kernel never imports a plugin**.
- **plugins import contracts only** — never kernel internals — so any plugin is swappable.

The one store not behind an orc data-access service is the DBOS SDK's own system database
(same Postgres cluster, but the SDK owns it). *(arch-overview; area-storage; area-kernel;
area-contracts)*

## 4. Subsystem tour

### contracts — `packages/contracts`
The typed seam every package agrees on: Zod schemas, the `EventKind` enum with per-kind
payload schemas (`events.ts`), the operation journal spec (`operations.ts`), the
executor/port/store interfaces (`execution.ts`: `ExecutorContext`, `ExecutionPort`,
`AgentExecutor`, `UnifiedEvent`, `SplitResult`), the memory store interface (`memory.ts`),
and the workspace containment guard (`workspace.ts`/`guards.ts`:
`resolveInWorkspace`/`validateOutputPaths`, shared by executor pre-flight and runtime
verification so they cannot drift). **Imports nothing** — changing an interface here is the
seam-level change that ripples to kernel and plugins. *(area-contracts)*

### storage — `packages/kernel/src/storage`
The single Postgres read/write boundary. `openStorage → Storage{events: EventLog,
operations: OperationJournal}`. `PostgresStore` is the sole pool owner (advisory lock,
redaction wiring, `assertMigrated` — which verifies but never migrates at open). `EventLog`
does the atomic append + idempotency keys + lossless `subscribe` with reconnect over
LISTEN/NOTIFY + project-scoped queries. `OperationJournal` writes durable before/after
nodes *through* the EventLog inside the same lock, so the durable node and history can never
disagree. Migrations are committed SQL under `packages/kernel/drizzle/` (drizzle-kit is
deliberately not installed). *(area-storage)*

### kernel — `packages/kernel/src`
The policy-free, DB-agnostic business core. `kernel.ts` owns the atomic task/plan lifecycle
(new/propose/plan/approve), the feedback outbox, and **plan-hash-bound human approval**:
`finalize-plan-tool.ts` recomputes the canonical plan-note-graph SHA-256 and accepts only a
matching `approve` from the same run token. `projections.ts` is the fold. `plugins/`
provides the host (propose-time ref validation), fingerprint-based **trust** grants (written
atomically, `0600`, never committed), and the SKILL.md index. `config.ts` derives project
identity from `.orc/config.json`. The kernel takes an `EventLog`, not a pool, and receives
plugins — it never imports them. *(area-kernel)*

### execution — `packages/kernel/src/execution`
The durability engine. `createDbosPort` wraps run and step in two registered DBOS
workflows (`orcRun`, `orcStep`) with deterministic ids. Key mechanics:

- **`ctx.operation`** (the journal checkpoint): commits a *before-record* BEFORE any
  external effect; on recovery a completed node short-circuits with its stored redacted
  value so the effect is never re-run. Terminal errors are not retried; others get 4
  attempts with 2× backoff.
- **`ctx.checkpoint`**: a `DBOS.runStep` that also appends drafted events under
  deterministic idempotency keys in one `log.transaction`. Both paths run
  `redactStepResult` before DBOS persists to its `operation_outputs` table (the one place
  raw model/tool payloads leave a step and are scrubbed).
- **Wave scheduler** (`interpreter.ts`): `readySteps(plan, done, failed, started)` launches
  ready steps **in plan order**, awaits the whole wave, recomputes. Order must be
  deterministic because DBOS binds child workflows *positionally* — non-deterministic order
  caused handle-swap deadlocks. A fast step knowingly waits for its wave. Depth-partitioned
  queues (`agents:<d>`/`runs:<d>`) keep a gate-waiting parent from starving its children.
- **Success path**: `verifyArtifacts` (`artifacts.ts`, SHA-256 receipts) is committed WITH
  `step_completed` in one transaction; re-verify is skipped if completion is already
  committed (crash-safe).
- **`cancelRun`** walks the subtree children-first and cancels each non-completed step
  workflow, then the run — DBOS cancel does not cascade on its own.
- **`priceDraft`**: usage drafts get `costUSD` filled from `provider.costs` at the port —
  pricing lives at the port, token-counting at the executor, cost table at the provider.

**Signal router** (`signal-router.ts`) delivers recursion and feedback. It subscribes to the
log and runs three idempotent routes: (1) a terminal child → resolve its pending split:
append `split_resolved` then `DBOS.send` the thin `SplitResult` on topic `split:<id>`;
(2) an approved child with a pending split → `startChildRun`; (3) `feedback_provided` →
`sendFeedback` on topic `feedback:<topic>`. An exhaustive `ROUTER_KINDS` record excludes
high-volume trace events (so the router never scans the whole log) and forces a routing
decision whenever a new event kind is added. A startup catch-up sweep re-resolves and
re-sends everything missed while the router was down, then resumes the pump. *(area-execution)*

### executor-api-loop — `plugins/executor-api-loop`
The default agent executor (`id: 'api-loop'`). `startTurn` is an async generator the DBOS
port drives; it never touches durability itself — it wraps every effect in
`ctx.operation`/`ctx.checkpoint` and yields `UnifiedEvent`s. `buildPrompt` assembles the
task spec, step title/role/instructions, force-loaded skills, upstream dep outputs, the
knowledge-protocol block, and an iteration-budget note. Each iteration wraps **a single
non-streaming `generateText({ model, messages, tools })`** call (Vercel AI SDK v7) — there
is no `streamText` anywhere in the system. It persists only the message delta since the last
call (avoids O(iterations²) bytes) and classifies errors transient (retry) vs terminal (no
retry). Built-in tools (`fs_read/write/list`, `signal`, `join_splits`, `ask_human`) merge
with `ctx.extraTools`; each external tool effect is its own `ctx.operation`. **Exactly one
suspension per turn**: `join_splits` yields a `gate`, `ask_human` yields a `feedback`, and
`signal(success)` pre-flights declared outputs with the same `validateOutputPaths` guard the
runtime later verifies with, then checkpoints `signal_received`. *(area-executor)*

### providers + mcp-client — `plugins/provider-*`, `plugins/mcp-client`
Providers are the **model-call seam** and are deliberately thin. `ModelProvider<LM>` =
`{ costs, languageModel(id) → AI-SDK model, listModels? }` — the entire model surface a
provider exposes is: bind an AI-SDK model handle + carry a cost table + optional live model
discovery (which must resolve, never reject). All streaming, tool-call, prompt, retry, and
usage logic lives in the executor loop, not the provider — which is why swapping providers is
trivial and streaming is absent everywhere. `provider-anthropic` is the richest (verified
cost table with cache rates; dual API-key/OAuth auth via an `oauthFetch ∘ cachingFetch`
custom-fetch chain); `provider-openai` and `provider-ollama` are minimal (openai has no
cost table → estimated; ollama defaults to local = free). `resolveModel(providers,
'provider/model')` is the one modelRef parse shared by plan-validation and the port.
*(area-providers)*

The executor is also **tool-source-agnostic**: it only sees `ResolvedTool[]` in
`ctx.extraTools`. MCP resolution happens *upstream in the port* — `tools.resolve(step.toolRefs)`
runs in the step-workflow body, then results are appended to `extraTools`.
`plugins/mcp-client` (`createMcpHub`) implements the `ToolSource` contract over the MCP SDK:
lazy per-server stdio spawn, tool cache invalidated by `ToolListChanged`, **trust
re-evaluated at spawn time** (a predicate, not a startup snapshot), names mangled to
`mcp__<server>__<tool>`, `$NAME` env resolution to keep secrets out of committed config,
child stderr ignored, and transport death returning `isError` + dropping the client for
lazy respawn. *(area-executor; area-providers)*

### memory — `plugins/memory`
An **event-first, disposable** SurrealDB knowledge graph. `store.ts` is the single writer:
it validates the note, stamps the runtime's git revision (agents cannot supply it), then
appends `memory_written`/`memory_deleted`/`memory_accessed` to the Postgres log — the access
counter is event-sourced too, so **nothing but the projector ever touches Surreal**. Writes
are fire-and-forget. `surreal.ts applyEvent` commits note + edges + cursor in one Surreal
transaction, gated on `seq <= cursor` (redelivery is a no-op) and stamping `retrievedAt`
from the canonical event `ts` (deterministic replay). Degraded-mode tolerance is real: a
bounded 5s connect timeout (the Surreal driver's `connect()` never rejects on an unreachable
endpoint — the root of every degraded path), a single bounded connection-shaped retry then
one `warn`, and a HEALTH signal that excludes the lagging access counter. `rank.ts` is a
bounded best-score graph-distance relaxation over bidirectional edges
(`weight × confidence × decay^depth`). `sweep.ts` is the **only** sweep today: deterministic
cancel-time GC that removes orphaned notes via a `memory_deleted` event (content stays in
the log for audit) — **not** agent/time decay. *(area-memory)*

### vault-projector — `packages/vault-projector`
A pure, deterministic markdown/mermaid projection of the log. `render.ts` computes
`state = fold(events)` and derives every file (task index DAG, `execution.md` with an
`unresolved` dashed class for the honest crash gap, `lineage.md` with SHA-256 output
receipts, per-step session narratives, plan files, root index) with **no business logic and
no DB access** — input is events, output is strings. It is LISTEN/NOTIFY-driven with 50 ms
per-task coalescing, subscribing before the initial render so no event vanishes. `write.ts`
writes atomically, skips unchanged files, is **write-once for plan files** (protecting human
edits), and warns-then-overwrites hand-edited projection files. `mermaidLabel` is the sole
guard preventing an agent-authored title from escaping a mermaid label. *(area-vault)*

### cli — `packages/cli`
Entrypoint and wiring only — commander command bodies contain no business logic and open no
DB directly. `openKernel` is the one `env → .orc/config.json → default` resolution, so every
command lands on the same project-bound database. Every mutating verb calls
**`buildOrcActions`** — the one shared implementation the web adapter also calls, so CLI and
web cannot drift. All state changes are event-first (kernel methods / `log.append`); no
command writes a projection store directly (memory/vault/graph verbs drive their
projectors). The live tail (`tailUntilDone`) is stream-driven via LISTEN/NOTIFY — **no
polling**. Read-only verbs (`tasks`/`log`/`replay`/`status`) fold via the kernel; `replay`
is explicitly read-only audit at a seq. *(area-cli)*

### ui — `packages/ui-core`, `packages/graph-ui`
`ui-core` is the transport-free live store (`ProjectSessions`): it does
`openStorage → fold → buildGraph → subscribe` and **tails the log read-only** — refolding
and diffing on each event, and **never appending**. `buildGraph`/`diffGraphs` are the one
pure `events → graph` projection, so no consumer can see a graph a fresh load would not
produce. `graph-ui/server.ts` is a thin JSON+SSE web adapter bound to `127.0.0.1`: GET
routes are read-only folds, `/api/stream` is a catch-up-then-live SSE tail, and **all
mutations dispatch through the same `OrcActions` object the CLI uses** (no bespoke logic),
guarded by a per-boot CSRF token and fenced to the single project the server booted in.
*(area-ui)*

## 5. Data flow — one durable step, end to end

1. `orc run` (via `buildOrcActions`) starts a DBOS **run workflow** (`orcRun`). *(area-cli,
   area-execution)*
2. The run **wave-schedules** ready steps in deterministic plan order; each launches a
   **step workflow** (`orcStep`). *(area-execution — `interpreter.ts`)*
3. The step workflow resolves the step's tool refs (`tools.resolve` → `ctx.extraTools`,
   including MCP), builds an `ExecutorContext`, and drives the api-loop generator.
   *(area-executor)*
4. The executor calls the model and tools through `ctx.operation` — **before-node committed
   BEFORE the effect, completion after, in one transaction** — so a crash leaves an explicit
   unresolved node and at-least-once retry re-runs only the interrupted call.
   *(area-execution, area-executor)*
5. On `signal(success)` the port **verifies declared outputs** (`verifyArtifacts`, SHA-256)
   and commits `artifact_produced` + `step_completed` **atomically**. *(area-execution)*
6. Every committed event tails live over LISTEN/NOTIFY to the CLI tail, the vault projector,
   the memory projector, and the UI. *(area-storage, area-vault, area-ui)*

**Recursion.** When an agent calls the split tool, child tasks are proposed; when the agent
calls `join_splits`, the executor yields a `gate` and the port resolves the target splits
(own-splits ∩ requested ids) and parks on `DBOS.recv<SplitResult>('split:<id>', 3600)` —
looping forever on a 3600 s long poll with cancellation as the only escape. As each child
run reaches a terminal state, the **signal-router** appends `split_resolved` and
`DBOS.send`s the thin `SplitResult` (`outcome`, `summary`, subtree-authored memory note ids)
to the waiting parent, which resumes. Human `ask_human` works the same way over
`feedback:<topic>`, resumed by the CLI `reply` verb via `dbosSend` (so the kernel never
imports the DBOS SDK). *(area-execution, area-executor)*

## 6. Cross-cutting guarantees

- **Project identity** — `.orc/config.json`'s `projectId` scopes every row and derived DB
  name; the advisory lock and system-DB name derive from it. *(area-kernel, area-storage)*
- **Audit replay** — `fold` at any seq is a read-only reconstruction that never mutates;
  `orc replay` is explicitly read-only audit. *(area-kernel, area-cli)*
- **Operation journal** — before-node committed before every external effect ⇒ a crash is an
  explicit unresolved node, and recovery short-circuits completed nodes with their stored
  redacted value (at-least-once, effect never re-run). *(area-execution, area-storage)*
- **Grounded approval** — human approval is bound to a SHA-256 of the canonical plan-note
  graph and the same run token; only a matching `approve` is accepted. *(area-kernel)*
- **Output receipts** — declared outputs are SHA-256-verified and committed *with*
  `step_completed` in one transaction; `lineage.md` renders the receipts. *(area-execution,
  area-vault)*
- **Redaction** — NUL-strip + secret redaction applied exactly once at the storage boundary,
  so every projection only ever sees redacted data (plus DBOS step outputs scrubbed via
  `redactStepResult`). *(area-storage, area-execution)*
- **Degraded-memory tolerance** — Surreal down ⇒ one bounded connect timeout + one retry +
  one warning; the log, runs, CLI, and vault all keep working, and the lagging access
  counter is excluded from HEALTH. *(area-memory)*
- **Sourced research notes** — `research` is the one memory kind that must carry a bounded,
  credential-free http(s) citation. *(area-memory)*

**Trust ladder & privileged tier.** Third-party extension goes through a trust ladder —
**T0** skills (SKILL.md, no code, force-loaded), **T1** MCP servers (declare + `orc mcp
trust`), **T2** extensions (`orc ext trust` binding entry + dependency closure + `bun.lock`
fingerprint) — with grants fingerprinted and enforced at point of use. Above that ladder,
the **memory and vault projectors are a privileged first-party runtime tier**: they may
append events and drive projectors directly, whereas an ordinary extension only gets
`api.on('event_appended', …)`. *(target-memory-lifecycle, area-kernel)*

**Deliberately deferred.** A full memory *lifecycle* (time/usage decay, archive, restore) is
designed but **not implemented** — gated on note `hits` showing a hot/cold split (the
neuron-memory spec). Today's only sweep is the deterministic cancel-time GC above; orc has no
decay today. *(target-memory-lifecycle, area-memory)*

## 7. Coverage & confidence

Confidence: **high**. Every section is backed by a verified `architecture_current` area note
whose findings were read line-by-line against source (runtime paths closed by
close-gaps-runtime; periphery closed by close-gaps-periphery). Directory structure
(`packages/{cli,contracts,graph-ui,kernel,ui-core,vault-projector}`,
`plugins/{executor-api-loop,mcp-client,memory,provider-anthropic,provider-ollama,provider-openai}`)
and cited execution/storage source files were re-verified in-workspace during synthesis.

| Section | Backing notes | Key source paths |
|---|---|---|
| 1 What it is | arch-overview | `docs/ARCHITECTURE.md`, `packages/`, `plugins/` |
| 2 Event-log invariant | arch-overview, area-storage, area-kernel | `packages/kernel/src/projections.ts`, `storage/event-log.ts`, `storage/postgres.ts`, `redact.ts` |
| 3 Three-tier rule | arch-overview, area-storage, area-kernel, area-contracts | `packages/kernel/src/storage`, `packages/contracts` |
| 4 contracts | area-contracts | `packages/contracts/src/{events,execution,operations,workspace,memory}.ts` |
| 4 storage | area-storage | `packages/kernel/src/storage/*`, `packages/kernel/drizzle` |
| 4 kernel | area-kernel | `packages/kernel/src/{kernel,projections,config}.ts`, `execution/finalize-plan-tool.ts`, `plugins/` |
| 4 execution | area-execution | `packages/kernel/src/execution/{dbos-port,signal-router,interpreter,artifacts}.ts` |
| 4 executor | area-executor | `plugins/executor-api-loop/src/{loop,tools}.ts` |
| 4 providers/mcp | area-providers, area-executor | `plugins/provider-*/src/index.ts`, `plugins/mcp-client/src/index.ts` |
| 4 memory | area-memory | `plugins/memory/src/{store,surreal,projector,rank,sweep}.ts` |
| 4 vault | area-vault | `packages/vault-projector/src/{render,index,write}.ts` |
| 4 cli | area-cli | `packages/cli/src/{main,actions,runtime}.ts` |
| 4 ui | area-ui | `packages/ui-core/src/{sessions,graph}.ts`, `packages/graph-ui/src/server.ts` |
| 5 Data flow | area-execution, area-executor, area-cli | `execution/dbos-port.ts`, `signal-router.ts`, `loop.ts` |
| 6 Guarantees | area-storage, area-execution, area-kernel, area-memory | as above |
| 6 Trust tiers / deferred lifecycle | target-memory-lifecycle, area-kernel, area-memory | `docs/EXTENDING.md`, `docs/plans/INDEX.md`, `plugins/memory/src/sweep.ts` |

**Residual gaps** (inherited from upstream, non-blocking): anthropic `oauth.ts`/`cache.ts`
internals and mcp-client `web-mcp.ts` were verified only via callsites, not line-by-line;
the deferred memory lifecycle is documented intent (`architecture_target`), not observed
behavior, and is labeled as such throughout.
