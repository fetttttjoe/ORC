# M2 Execution — Design Specification

**Date:** 2026-07-17
**Status:** Approved design, pre-implementation
**Parent spec:** `2026-07-16-orchestrator-design.md` (this document amends ADR-004, §2, §7 — plus §5.2 `ExecutionPort` and §8.4/ADR-003 Ollama attachment, noted inline there)

---

## 1. Goal & Scope

M2 makes approved plans execute: a frozen plan DAG runs across real models (cloud and local) with full event-log traceability, durable crash recovery, typed completion signals, and cost accounting.

**In scope:** docker-compose Postgres infra; event log migration SQLite → Postgres; `ExecutionPort` implemented on DBOS Transact; durable run/step workflows (DAG interpreter); `api-loop` executor on Vercel AI SDK v7; plugin-style providers (Anthropic, OpenAI, Ollama); typed signals with per-run tokens; built-in tools (signal + scoped file R/W); usage/cost accounting; CLI `run`/`retry`/`cancel`/`status`; failure taxonomy; kill‑9 resume test.

**Out of scope (deliberate cuts, with return dates):**

| Cut | Returns |
|---|---|
| Mid-run approval gates via `DBOS.send`/`recv` (M2 has no mid-run gate: approval strictly precedes `run`) | M5, with recursion — send/recv is the intended mechanism |
| Streaming text deltas (M2 events carry whole assistant turns) | with UI/vault rendering |
| `orc signal` helper CLI for external agent CLIs | M5, claude-code adapter |
| Google provider | later registry entry, config not code |
| MCP tools / plugin host | M3 |
| Vault projection | M4 |
| Recursion, strategies, zones enforcement, worktree/docker isolation | M5 |
| `fold()` snapshots/caching | when it measurably slows |

## 2. Evidence (validated 2026-07-16/17)

- **Spike (hands-on):** DBOS 4.23.6 on Bun 1.3.13 is clean — install, import, `DBOS.launch()`, workflow execution, and a kill‑9 mid-`DBOS.sleep` recovery all verified against `postgres:16-alpine`. Zero Bun-specific errors, no flags, no polyfills (`pg` is pure JS).
- **DBOS system DB is Postgres-only in TS** (driver: `pg`; `sqlite://` URLs rejected at config validation). SQLite exists in the Python/Go SDKs; TS support is an open unmerged PR (dbos-transact-ts #1288). This invalidates the parent spec's "DBOS is SQLite-shaped" premise and motivated decision D1.
- **DBOS on Bun is unofficial but real:** maintainers fixed a Bun-specific crash naming "bun users" (PR #1127); docs forbid bundling DBOS with any bundler — the one known Bun crash context was `bun build --compile`. Run unbundled via `bun run`.
- **DBOS recovery semantics:** workflow functions must be deterministic; all side effects live in steps; steps checkpoint to the system DB and execute at-least-once; recovery is keyed to an application version (override: `DBOS__APPVERSION`). Queues support global `concurrency`, `workerConcurrency`, rate limits, `deduplicationID`.
- **Vercel AI SDK is at v7** (`ai@7.x`, ESM-only, Node ≥ 22 / Bun officially supported). `maxSteps` is gone; loop control is `stopWhen`/`prepareStep`, and manual per-turn loop control is explicitly supported. `result.steps[]` carries per-step usage.
- **Ollama:** no official provider. `ai-sdk-ollama` (native API, `ai@^7` peer) is the robust choice — reliable streamed tool calls and usage mapping. Ollama's OpenAI-compat `/v1` endpoint drops streamed tool calls for some models and can omit usage: ruled out.
- **`dbos-inc/agent-skills`:** SKILL.md-format docs teaching coding agents idiomatic DBOS; install during M2 implementation so implementing agents write correct DBOS patterns.

## 3. Decisions

- **D1 — DBOS on compose Postgres; canonical state consolidates into the same Postgres** *(user decision 2026-07-16; amends ADR-004, §2 constraint "local-first: SQLite", §7 deployment)*. A repo-root `docker-compose.yml` runs a single `postgres:16-alpine` service. DBOS is an in-process library inside `orc` — compose runs only Postgres. The kernel event log moves from `bun:sqlite` to the same server (Drizzle driver swap — the seam ADR-004 built). `.orc/state.db` and all SQLite code are deleted; no data migration (pre-release). Consequence, stated plainly: **every `orc` command and all tests require `docker compose up -d` first.** The CLI emits a clear "is the stack up?" error when Postgres is unreachable.
- **D2 — `ExecutionPort` stays the seam.** `{ startRun, retry, cancelRun }` plus the per-step `checkpoint` capability handed to executors (§5) — this shape supersedes the parent §5.2 sketch `{runStep, waitForSignal, enqueue, sleep}` (declared amendment; `checkpoint` is `runStep`'s descendant, `waitForSignal` returns in M5 with mid-run gates; `runStatus` was dropped in review — nothing consumed it, and its `dbosStatus` field leaked the backend into the neutral contract). DBOS APIs and types never leak above the port; kernel and CLI depend only on it.
- **D3 — Interpreter = durable run-workflow.** The frozen plan is pure data, so walking it is deterministic — exactly DBOS's workflow requirement. One DBOS workflow per run; steps are queued child workflows. Package home: the pure ready-set function and the DBOS port implementation both live in `packages/kernel/src/execution/` — DBOS becomes a kernel dependency, confined to the port module (parent §5.1 already places the DAG interpreter in the kernel).
- **D4 — Providers are plugin-style** *(user decision 2026-07-16)*: each provider is a self-contained package behind the `ModelProvider` contract, resolved via a registry. M2 ships Anthropic + OpenAI + Ollama; the architecture accommodates all of R3's list. Becomes true runtime plugins when M3's host lands, with no contract change.
- **D5 — M2 tool surface: `signal` + scoped file R/W.** No bash before isolation tiers exist (M5).
- **D6 — Conductor / admin API are opt-in ops tooling, wired to nothing by default** (hosted Conductor sends workflow metadata off-machine — off by default for a local-first tool).
- **D7 — DBOS is never bundled.** `bun run` unbundled, always; documented in the README.

## 4. Infrastructure & Storage

`docker-compose.yml` (repo root): service `postgres:16-alpine` (spike-validated version), named volume, healthcheck, host port **5433** (avoids collisions with a default local Postgres). One server, two databases:

- `orc` — canonical event log, Drizzle-managed, migrations via drizzle-kit (committed).
- `orc_dbos_sys` — DBOS system DB, auto-created by `DBOS.launch()`; we set `systemDatabaseUrl` explicitly to the same server.

Connection: `ORC_DATABASE_URL`, default `postgresql://postgres:orc@localhost:5433/orc`.

**Schema (Postgres):** `events` becomes `seq bigint generated always as identity primary key`, `payload jsonb`, `ts timestamptz default now()`, new nullable `usage jsonb` column (parent spec §8.1 — queryable cost aggregation), existing task index kept.

**The async ripple (M1 refactor, lands first):** `pg` is async where `bun:sqlite` was sync, so `EventLog`, `Kernel`, and CLI actions become `async` — and one part is a real design change, not a sweep. Under node-postgres, a transaction is scoped to the client Drizzle hands the callback; M1's `Kernel` reads and appends through the shared handle inside `log.transaction(() => …)`, which ported naively would run those inner queries on other pool connections *outside* the transaction — silently dropping M1's read-then-append atomicity (plan versioning, approval). The port therefore threads the transaction handle: `EventLog.transaction(async tx => …)` hands a tx-scoped accessor that all reads/appends inside the callback must use. Tests updated in the same change.

**App-version pinning:** DBOS keys crash recovery to an application version (default: a hash of the workflow code), so crash → upgrade → restart would strand PENDING workflows. `DBOS__APPVERSION` is pinned to the orc package version, and the upgrade policy is documented: finish or `orc cancel` active runs before upgrading across versions (M2 policy).

## 5. Contracts (additions to `@orc/contracts`)

- **`UnifiedEvent`** — discriminated union `text | tool_call | tool_result | usage | signal | error | done`, each variant with `raw` passthrough (parent §5.2).
- **`Signal`** — `{ stepId, runToken, outcome, summary }` with `SIGNAL_OUTCOME = { success, failure }` const map. A signal is valid only if its `runToken` matches the step's active run (ADR-008 hardening).
- **`Usage`** — `{ inputTokens, outputTokens, costUSD?, estimated: boolean }`. Summed defensively — missing provider counts produce `estimated: true`, never `NaN`.
- **`ModelProvider`** — `{ costs: Record<modelId, {inPerMTok, outPerMTok}>, languageModel(modelId) }` (AI SDK `LanguageModel`); each provider package exports `createProvider(config)`. `modelRef` stays `"provider/model"`. *(Amended in review: the fuller `ModelProviderManifest` — id/providerKind/baseUrl/contextWindow — was write-only in M2; the parent §5.2 manifest returns when a consumer exists.)*
- **`AgentExecutor`** — `{ id, startTurn(ctx): AsyncIterable<UnifiedEvent> }` (api-loop is M2's only implementation; `getCapabilities()` was dropped in review — no caller branched on it, it returns with the parent capability matrix when M5 adds a second runtime). M2 ships this subset of the parent §5.2 surface; `resume`/`abort`/`loadTranscript` are added (additively) in M5 with the claude-code adapter. `ctx` carries the step's plan data, assembled context, resolved `LanguageModel`, tool implementations, `runToken`, **and a `checkpoint<T>(name, fn)` capability** provided by the `ExecutionPort` — under DBOS it wraps `fn` as a durable step; in unit tests it's the identity. The executor wraps every model call and every tool-execution batch in `checkpoint()`; it never imports DBOS. The step workflow consumes the yielded `UnifiedEvent`s and is the only component that appends events to the `EventLog` — the executor stays log-agnostic.
- **`ExecutionPort`** — see D2.
- **Event kinds added:** `run_started, step_started, agent_call, tool_call, tool_result, signal_received, step_completed, step_failed`. `run_started` carries `{ taskId, planVersion, retryIndex, workflowId }` — it is the single derivation source for `orc run`/`retry`/`cancel`/`status`: the current run workflowID is the latest `run_started`'s, and the next retry index K is the count of prior `run_started` events for that plan version (no DBOS lookup above the port). Task status still flows through `task_status_changed`. `agent_call` payload: `{ stepId, runToken, iteration, request, response }` + the `usage` column — full inputs/outputs per R9. `fold()` dedups crash-boundary duplicates on `(runToken, iteration, kind)`, extended with the AI SDK `toolCallId` for `tool_call`/`tool_result` (one iteration can carry several tool calls).

## 6. Execution Architecture

### 6.1 Run workflow

`workflowID = run:<taskId>:v<planVersion>` — `orc run` twice attaches to the existing workflow instead of duplicating. Preconditions checked in the CLI/kernel: task `approved` (else a clear "approve first" error). The workflow:

1. First durable step: loads the frozen approved plan and appends `run_started` + `task_status_changed → running` (every event append in M2 happens *inside* a durable step — see §6.2 for why).
2. Walks the DAG in waves: enqueue every ready step (deps all succeeded, i.e. ended in `step_completed`) onto DBOS queue `agents` (global `concurrency` from config, default 3) as child workflows; await handles; add successes to the done-set; repeat.
3. Steps downstream of a failure stay unscheduled; independent branches keep running.
4. Terminal (a durable step appending the status event): all steps succeeded → `done`; any failed → `blocked` (human decides: `orc retry`, or plan edit in a later milestone). Determinism holds because the plan is frozen data and child results are checkpointed.

**Cancel semantics:** `cancelRun` resolves the current run workflowID from the latest `run_started`, cancels it, **and explicitly cascades to its enqueued/running child step workflows** — DBOS cancel does not cascade on its own. `cancelled` is terminal in M2: a cancelled task cannot be re-run (resurrection via plan re-versioning arrives with M5's lifecycle work).

### 6.2 Step workflow

`workflowID = step:<taskId>:<stepId>:a<attempt>` (attempt = count of prior failed attempts for the step + 1, so retries get fresh IDs). The `runToken` **is** the step workflowID — deterministic and unique per attempt; nothing is minted inside the workflow body (a body-minted random token would violate DBOS determinism, and a step-minted one could change across a crash boundary, breaking dedup and signal validation).

**Append-inside-checkpoint rule:** DBOS recovery re-executes the workflow function from the top — checkpointed steps replay their recorded results without re-running, but naked code in the body runs again. An `EventLog.append` in the body would therefore duplicate the step's entire event history on every recovery. So in M2, *every* event append happens inside the durable step that produced the event; the only remaining duplicate source is a crash inside one step after its append but before its checkpoint commits.

The workflow appends `step_started` (its own durable step), then loops up to `maxIterations`. Each iteration is **two durable steps**:

1. **Model call step** — one `generateText` with tools declared but *without* `execute` (the SDK returns tool calls; it never loops internally); appends `agent_call` (full request/response + usage) within the same step. A checkpointed model call is never re-executed or re-billed after a crash.
2. **Tool execution step** — runs the returned tool calls ourselves; appends `tool_call`/`tool_result` events (one pair per call, keyed by the SDK's `toolCallId`) within the same step.

A `signal` tool call ends the loop: `outcome: success` → `signal_received` + `step_completed`; `outcome: failure` → `signal_received` + `step_failed(agent_error)` — agent-declared failure flows through the same accounting as every other failure (done-set, attempt counting, `orc retry`). Iterations exhausted → `step_failed(agent_error)`. Budget is checked between iterations via a checkpointed read of the task's cost sum (see §9). Crash-boundary duplicates are deduped in `fold()` by `(runToken, iteration, kind)` + `toolCallId` for tool events.

**Context assembly (M2-minimal):** system prompt from step `role`/`instructions`; user message = task spec + labeled outputs (final text) of dependency steps. Slots/topologies are M5.

### 6.3 Built-in tools

- `signal` — `{ outcome: 'success'|'failure', summary }`; ends the step; validated against `runToken`.
- `fs_read` / `fs_write` / `fs_list` — scoped to the step's workspace: default `.orc/workspaces/<taskId>/<stepId>/` (per-step, so concurrent siblings cannot clobber each other — zone enforcement proper is M5); `orc run --cwd <dir>` deliberately shares one directory across all steps (the user's explicit choice, collision caveat documented). **Trust boundary:** every path is resolved (symlinks included) and must stay inside the workspace root; violations return a tool error to the model and append a `tool_result` marked as denied — never an exception that kills the step.

Tools are defined with zod `inputSchema` (AI SDK v7 `tool()` shape). Malformed tool arguments from the model count as an `agent_error` iteration, not a crash.

## 7. Providers

Packages: `plugins/provider-anthropic` (`@ai-sdk/anthropic`), `plugins/provider-openai` (`@ai-sdk/openai`), `plugins/provider-ollama` (`ai-sdk-ollama`, native API). All pinned to `ai@^7` peers. A static registry in kernel config maps provider id → package; M3 turns these into loadable plugins without contract changes.

Config: env-first — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL` (default `http://localhost:11434`). Optional `.orc/config.json` for non-secret overrides (concurrency, workspace root, model cost overrides). Secrets never touch the DB, events, or vault; provider adapters redact keys from `raw` passthrough.

Cost tables live in the provider packages (per-MTok in/out per model); unknown model or missing counts → `costUSD` estimated or null with `estimated: true`.

## 8. CLI

- `orc run <taskId> [--cwd <dir>]` — foreground: starts or re-attaches (idempotent workflowID), tails new events to stdout (500 ms poll on the events table), exits with the run outcome (0 done / 1 blocked/failed). On startup it launches DBOS, which auto-recovers any PENDING workflows from a previous crash — resume is just `orc run` again.
- `orc retry <taskId>` — starts a fresh run workflow `run:<taskId>:v<N>:r<K>` (K = count of prior `run_started` events for this plan version; a completed workflowID would otherwise just return its cached result). The new run seeds its done-set from the event log (a checkpointed read at workflow start), skips steps that ended in `step_completed`, and re-executes failed steps as new attempts.
- `orc cancel <taskId>` — cancels via the port (run workflow + cascaded child step workflows, §6.1) + `task_status_changed(cancelled)`; terminal in M2.
- `orc status <taskId>` — per-step state + token/cost totals, derived from `fold()`.
- Existing M1 commands unchanged in behavior, now async, and fail with a clear message when Postgres is down.

## 9. Failure Handling (parent §6.2 mapped)

| Class | Detection | Handling |
|---|---|---|
| `provider_error` (transient) | 429 / 5xx / network / timeout | DBOS step retry with backoff + retry predicate (transient classes only); exhausted retries → `step_failed(provider_error)` |
| `provider_error` (terminal) | auth, 400-class | immediate `step_failed(provider_error)` |
| `agent_error` | malformed tool args, never signals, or agent-declared failure via `signal(outcome: failure)` | counts against `maxIterations` (declared failure ends the attempt immediately); → `step_failed(agent_error)` → task `blocked` |
| `budget_exceeded` | Σ `costUSD` vs task `budgetUSD`, checkpointed read between iterations | `step_failed(budget_exceeded)`, task `blocked`. Concurrent steps snapshot the sum independently — worst-case overshoot ≤ concurrency × one iteration's cost, accepted for M2 |
| `human_abort` | `orc cancel` | DBOS cancel + `cancelled` status |
| kill ‑9 | next `orc run` | DBOS recovers PENDING workflows from checkpoints (spike-verified); a harness crash is never billed as an agent iteration |

## 10. Testing

- **Unit (no infra):** DAG wave/ready-set logic (pure function over plan + done-set), `fold()` with new kinds + crash-boundary dedup, signal token validation, fs path-scoping guard (incl. symlink escape), provider registry resolution, usage summing with missing counts.
- **Integration (requires compose Postgres):** each test file creates and drops an ephemeral database (`orc_test_<random>`) via an admin connection. Agent loop runs against a scripted fake provider (AI SDK's mock language model from `ai/test`; exact export name verified at implementation) — deterministic multi-step runs with tool calls, signals, failures. DBOS launched per suite against the ephemeral DB.
- **Crown jewel — resume test:** spawn `orc run` as a subprocess against a plan whose fake provider stalls, `kill -9` mid-step, restart, assert the run completes, no step re-billed (event log shows each iteration exactly once post-fold), and replay identity holds (extends M1's guarantee to execution events).
- **Live smoke (env-gated, manual):** `ORC_LIVE_SMOKE=1` runs one real Ollama step and one real Anthropic step end-to-end.

## 11. Quality Scenarios (extends parent §10)

| Quality | Scenario | Target |
|---|---|---|
| Robustness | kill ‑9 mid-run, then `orc run` | run resumes from checkpoints; completed model calls not re-executed; event log consistent after fold-dedup |
| Traceability | "why did step X do Y?" | `agent_call` events carry full request/response; `orc status`/`orc log` reconstruct the step story |
| Determinism | replay over a finished run's log | identical state (golden-replay extended to execution kinds) |
| Extensibility | add Google provider | one new package + registry entry; zero kernel changes |
| Cost | any provider interaction | normalized `usage` on the event, `estimated` flagged when counts are missing |

## 12. Risks & Mitigations

1. **DBOS-on-Bun is unofficial** — pinned DBOS version; unbundled execution (D7); the resume integration test doubles as a compatibility canary on every upgrade.
2. **Postgres now required for everything** — one compose file, healthcheck, explicit CLI error when down; accepted trade (user decision) for buying recovery/queues/retries instead of building them.
3. **AI SDK major-version churn (V2→V3→V4 provider spec in 3 majors)** — pin `ai@^7` and provider majors; the provider seam contains any migration.
4. **Duplicate events at crash boundaries (at-least-once steps)** — `(runToken, iteration, kind)` dedup in `fold()`; covered by the resume test.
5. **Community Ollama provider maintenance** — `ai-sdk-ollama` is active today; the `ModelProvider` seam makes a swap one package.
6. **DBOS TS SQLite (PR #1288) could land later** — irrelevant to correctness; if a zero-infra mode ever matters again, the `ExecutionPort` + Drizzle seams keep that door open.

---

*Evidence provenance: 3-agent workflow 2026-07-16 (DBOS-on-Bun spike in scratchpad, DBOS docs/issues research, AI SDK v7 research) + Conductor/agent-skills follow-up 2026-07-17. Key sources: dbos-transact-ts #1226/#1288/#1126/#1127, docs.dbos.dev configuration/workflow/queue/recovery docs, ai-sdk.dev v6/v7 migration guides + ToolLoopAgent/loop-control docs, github.com/jagreehal/ai-sdk-ollama, github.com/dbos-inc/agent-skills.*
