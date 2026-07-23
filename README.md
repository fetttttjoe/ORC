# orchestrator

A generic multi-agent orchestrator: recursive task splitting, human plan
approval, multi-provider agent dispatch, plugin-first. Design spec:
`docs/superpowers/specs/2026-07-16-orchestrator-design.md`. Adding anything
(provider, executor, skill, tool, event kind, …): `docs/EXTENDING.md`.

## Status

M4c + M5a + foundation hardening — recursion (task_split/join), committed
project identity, project-scoped infrastructure, a durable model/tool operation
journal with honest audit replay, verified output receipts, and a typed
agent-maintained knowledge graph with current/target architecture views. The
memory graph carries typed, confidence-weighted links (`RELATE` edges) with a
graph-distance ranker and a `memory_neighbors` traverse tool, so a recursive
agent can pull a bounded context slice instead of re-holding everything.
Startup is degraded-memory tolerant. Findings pulled off the web land as
cited `research` notes rather than pasted pages, and what memory actually gets
read is event-sourced rather than guessed at. Every task is auditable,
resumable, project-isolated, and visible through separate execution, lineage,
and knowledge graphs.

## Architecture & Documentation

Start here to navigate the codebase and understand the architectural foundations.

### Quick Navigation

| Topic | Purpose | Where to Find |
|---|---|---|
| **Architecture overview** | System map, data flow, seams, invariants | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modules, tiers, storage service, execution flow |
| **Extension points** | How to add providers, executors, tools, skills, events | [`docs/EXTENDING.md`](docs/EXTENDING.md) — seam map with invariants |
| **Decisions & roadmap** | 18+ plans and architectural decision records | [`docs/plans/INDEX.md`](docs/plans/INDEX.md) — approval status, purpose, dependencies |
| **Seams reference** | Component interactions, call paths, debugging | [`docs/seams-reference.md`](docs/seams-reference.md) — 5 scenarios, troubleshooting workflows |
| **Glossary** | Key terms with definitions and links | [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — 80+ architectural terms |
| **Ideas & backlog** | Deferred features with triggers | [`docs/IDEAS.md`](docs/IDEAS.md) (spec) and [`docs/IDEAS-MEMORY-INDEX.md`](docs/IDEAS-MEMORY-INDEX.md) (memory-indexed) — future optimizations with conditions to ship |

### Component Areas

- **Event log** — canonical Postgres append-only history; foldable, auditable, never partial
- **Execution** — durable workflows via DBOS Transact; operation journal before/after nodes; at-least-once recovery
- **Plugins** — replaceable executor, model providers, MCP servers, extension system; zero-trust (declare + consent + fingerprint)
- **Memory system** — event-first SurrealDB knowledge graph; typed edges; degraded-mode tolerant; web research carries citations
- **Vault** — deterministic markdown projections of tasks, lineage, artifacts, and knowledge (disposable, rebuilt on restart)

### Visual Navigation

- `orc graph [--port 7749]` — live WebGL graph of tasks, steps, artifacts, and memory notes (read-only, localhost only)
- `vault/` — filesystem projections: `index.md` (task tree + status), `tasks/<id>/execution.md` (steps + operations), `tasks/<id>/lineage.md` (artifact receipts), `memory/index.md` (knowledge graph)

### Troubleshooting

- **Degraded memory** — SurrealDB down? ⇒ one warning, explicit `memory unavailable` tool results, everything else keeps working
- **Crash recovery** — resumable at any step via DBOS journal; see `orc status <task>` for unresolved operations
- **Audit trail** — `orc log <task> --json` for full redacted event record; `orc replay <task> --at <seq>` to freeze-frame any moment
- See also: [Seams reference guide](docs/seams-reference.md) — detailed debugging strategies

## Stack

TypeScript end-to-end on Bun (package manager, runtime, test runner).
Postgres via docker compose (canonical event log + operations journal + DBOS
system DB, all project-scoped). Drizzle ORM over node-postgres (committed SQL
migrations; the generator is not installed — see Operational notes). DBOS
Transact for durable execution. SurrealDB (via the Surqlize ORM) as the
disposable knowledge read model. Vercel AI SDK v7 (+ ai-sdk-ollama) for
models. Zod contracts. Commander CLI.

## Quickstart

```bash
docker compose up -d --wait     # Postgres :5433 + SurrealDB :8000, loopback-only
bun install && bun test

(cd packages/cli && bun link)          # installs a global `orc` (Bun shim); alias works too
export ANTHROPIC_API_KEY=...    # and/or run a local Ollama

orc db migrate                  # explicit schema setup; works before project initialization
orc init --name my-project      # identity + first-party skills; run once, commit .orc/config.json
orc new "write release notes" --spec "summarize changes since v1.2; declare the notes file as an output"
orc propose <task-id> --model anthropic/claude-sonnet-5   # or ollama/<model>
orc plan <task-id>              # review it
orc approve <task-id>           # the human gate
orc run <task-id> --cwd .       # durable execution against this working tree, with live event tail
orc status <task-id>            # project, memory health, steps, operations, receipts, cost
orc replay <task-id> --at <seq> # read-only audit replay at any event sequence
orc log <task-id> --json        # full redacted event records
orc skills                      # indexed SKILL.md skills (vault/skills/<name>/SKILL.md)
orc mcp trust <id>              # local consent, bound to the server's declaration fingerprint
orc mcp serve [--autonomy full] # serve THIS project to external agents over stdio (door #2)
orc ext trust <path>            # local consent, bound to extension dependency closure + bun.lock
orc retry <task-id>             # re-run failed steps after a block
```

### Documentation from the knowledge graph

Documentation is an ordinary orchestrated task — no extra runner. `orc init`
seeds the project-local `documentation` skill (plus grounded-planning skills)
without overwriting project edits:

```bash
task_id=$(orc new "generate architecture docs" --spec "Write docs/architecture.md from current/target memory; declare it as an output")
orc propose "$task_id" --model anthropic/claude-sonnet-5 --skill documentation
orc approve "$task_id"
orc run "$task_id" --cwd .
```

### Rebuilding the knowledge graph in parallel

`docs/kb-build-parallel.plan.json` is a committed plan draft: ten area scouts map the
codebase concurrently (wave 1), one assembler writes the hub + cross-cuts and verifies
connectivity (wave 2). Use after a purge or a large refactor:

```bash
task_id=$(orc new "Rebuild the knowledge graph" --spec "map every area, then assemble the hub")
orc propose "$task_id" --file docs/kb-build-parallel.plan.json
orc approve "$task_id" && orc run "$task_id" --cwd .
```

### Driving orc from another agent (door #2, MCP)

orc is usable from two doors: humans work the web UI (`orc graph`); external agents —
Claude Code, any MCP client — drive the same substrate over stdio:

```bash
claude mcp add orc -- bun /path/to/orchestrator/packages/cli/src/bin.ts mcp serve
# or fully autonomous (approve included, attributed as approvedBy: mcp):
claude mcp add orc -- … mcp serve --autonomy full
```

Tools served (project-bound, same `OrcActions` validation as the web):

| Kind | Tools |
|---|---|
| Read | `project_status`, `task_plan`, `task_transcript`, `plan_notes`, `recent_activity` |
| Knowledge (degraded-tolerant) | `memory_search`, `memory_read`, `memory_neighbors` |
| Mutate | `new_request` (quick/grounded), `propose`, `run`, `reply`, `retry`, `cancel`, `annotate`, `revise` |
| The gate | `approve` — refuses under the default `--autonomy gated` (the human approves in the UI or `orc approve`); approves under `--autonomy full`, recorded as `approvedBy: mcp` |

stdout carries ONLY protocol frames: boot diagnostics are rebound to stderr, and the
transport owns the real stdout — DBOS's logger cannot corrupt the channel. Trust grants and
`orc init` are never exposed over MCP. Memory writing stays with the agents running inside
plans — the external driver reads knowledge, it does not author it.

### Sourced web research

No bundled web provider and no hard-coded tool names: research runs on whatever
search/fetch MCP server the project declares and trusts, and the step opts in
through ordinary `toolRefs`. `orc init` seeds the tool-agnostic `web-research`
skill alongside the others.

```bash
orc mcp trust search             # after declaring a "search" server in .orc/config.json
task_id=$(orc new "compare pgvector vs qdrant for our recall path" --spec "cite every claim")
orc propose "$task_id" --file research-plan.json   # toolRefs live in the plan draft
orc approve "$task_id" && orc run "$task_id" --cwd .
orc memory ls --tag research     # hits column shows what later steps actually pulled back
```

```jsonc
// research-plan.json — refs are validated at propose time, so a missing skill
// or an untrusted server fails here rather than mid-run
{
  "strategyRef": "template:single", "costEstimateUSD": 0,
  "steps": [{
    "id": "research", "role": "scout", "title": "Compare pgvector and qdrant",
    "instructions": "Answer the task spec. Cite every claim.",
    "executorRef": "api-loop", "modelRef": "anthropic/claude-sonnet-5",
    "skillRefs": ["web-research"],
    "toolRefs": ["search/web_search", "search/fetch"],  // <server-id>/<tool-name>
    "isolation": "local", "zone": [], "maxIterations": 12, "dependsOn": []
  }]
}
```

Fetched page text is untrusted **evidence, never instructions**. The raw
response stays in the redacted audit trail; what reaches the knowledge graph is
one distilled `research` note per finding — the one note kind that must carry a
citation. Retrieval time is stamped by the system from the event, not supplied
by the agent.

## Guarantees, stated precisely

- **Project identity.** `orc init` writes `projectId`/`projectName` into the
  committable `.orc/config.json`. Every event, journal row, DBOS system
  database, and SurrealDB database is bound to that identity — two projects
  sharing one deployment cannot read, project, recover, or render each
  other's state.
- **Audit replay.** History is an append-only, redacted, idempotent event log.
  Folding it reconstructs task, execution, and lineage state at any sequence
  (`orc replay`). Replay never mutates history.
- **Operation journal.** Every first-party model/tool effect records a durable
  `started` node *before* the external call and its completion/failure after.
  A crash leaves an explicit unresolved node — never a blind gap.
- **Resume.** Completed operations are reused from the journal; failed ones
  follow retry policy; a node still `started` after a crash is retried as an
  explicitly **at-least-once** attempt (attempts are counted, both start
  transitions stay visible). Exact-once for a remote effect exists only where
  that provider/tool honors a deterministic idempotency key — orc records the
  ambiguity instead of claiming it away.
- **Workflow recovery** (DBOS) is the continuation mechanism underneath —
  it is not the definition of replay.
- **Durable human feedback.** `feedback_provided` events are an idempotent
  outbox: live/startup routing retries committed replies. Grounded `approve`
  replies carry a plan-graph SHA-256; `finalize_plan` accepts only a matching
  approval from the same run, so edits require reapproval.
- **Output lineage.** A success signal may declare workspace-relative
  `outputs`; the runtime verifies each file, computes its SHA-256 receipt, and
  commits `artifact_produced` atomically with `step_completed`.
- **Secrets** are redacted once at the storage boundary (sensitive keys +
  configured env values; add names via `redactEnv` in config). Projections
  and vault files only ever see redacted data.
- **Degraded memory.** SurrealDB down ⇒ one warning, explicit
  `memory unavailable` tool results, and everything else — history,
  execution, cancellation, vault trace — keeps working.
- **Sourced knowledge.** A `research` note requires at least one bounded,
  credential-free http(s) citation, and its `retrievedAt` is stamped by the
  projector from the canonical event — writers cannot supply one, and replay
  reproduces it exactly. Raw fetched text stays in the redacted audit trail;
  only the distilled note reaches the knowledge graph.
- **Observed use, not assumed use.** `memory_accessed` events make
  `hits`/`lastAccessedAt` canonical, so they survive a read-model rebuild
  instead of being silently zeroed by it. Agent reads are task-bound in the
  envelope (per-task pull counts in the UI). Nothing ranks or expires on the
  counter — it is measurement, so a later decay policy can be tuned against
  data rather than guessed.
- **The human gate is structural.** The copilot has no approve tool; over MCP,
  `approve` exists only behind the launch-time `--autonomy full` dial and every
  such approval is recorded as `approvedBy: mcp`. An agent can never widen its
  own autonomy mid-session.
- **Copilot conversations are events.** Each web-chat exchange is journaled as a
  `copilot_exchange` event (user text, assistant text, tool summaries, priced
  usage); the chat pane rebuilds from the log after reload — the browser is a
  cache, never the record.
- **Zone write-fences.** A step declaring `zone` globs can only write inside
  them (`fs_write` refuses with a named fence); reads stay free, empty zone =
  unrestricted. Deterministic env errors (`EACCES`/`ENOENT`/…) fail a step on
  attempt 1 instead of burning retries.
- **Degradation is visible.** `orc graph` polls `/api/health` (backed by
  `probeMemory`) and shows a red badge with the projector lag when the memory
  read model is stale or unreachable — within one 15s poll interval.

## Vault views

- `vault/index.md` — recursive task-expansion graph + live status
- `vault/tasks/<id>/execution.md` — plan steps + operation nodes (attempts, unresolved/completed/failed)
- `vault/tasks/<id>/lineage.md` — producing step → verified output receipts
- `vault/memory/index.md` — authored knowledge as one graph: current architecture, target
  architecture, decisions/facts, and research, grouped as subgraphs with every typed link between
  them drawn (a summary and the research note it was `derived_from` are in different groups, and
  that edge is the point)

## Operational notes

- `ORC_DATABASE_URL` overrides the default `postgresql://postgres:orc@localhost:5433/orc`.
- `maxIterations` in `.orc/config.json` (or `ORC_MAX_ITERATIONS`) sets the default agent-loop
  budget for authored steps (single-step template, grounded analyze) — default 30. Applies at
  plan-authoring time only; approved plans keep the budgets they were approved with.
- `orc graph [--port 7749]` serves a live WebGL graph of tasks, steps, artifacts, and memory
  notes for any project in the event log, with per-task chat transcripts, a live event log,
  deep-linkable navigation (`#p=…&n=…&tab=…`), and the Request view: create (quick or
  grounded) → review the decomposition → refine/approve → run → watch the knowledge graph grow
  (focus mode dims everything else). Mutations are available only when launched inside a
  project (CSRF-token guarded, 127.0.0.1 only); trust/init stay CLI-only. Logic lives in
  `@orc/ui-core`; the web server and browser renderer are adapters — a TUI can reuse the core
  directly.
- Plugins: `.orc/config.json` *declares* (`mcpServers`, `extensions`, `skillsDir`);
  `.orc/trust.json` *grants* — created only by `orc mcp trust` / `orc ext trust`,
  written atomically with mode 0600, never commit it. Grants bind to a
  fingerprint: MCP to (command, args, env *names*), extensions to the entry
  file plus literal local import/dynamic-import/require closure and project
  `bun.lock`. Change any covered input and the grant is invalid until re-trusted.
  MCP servers still run with this user's full permissions — vet before trusting.
- `env` values in `mcpServers` starting with `$` pull from orc's own environment
  at spawn — secrets never go in the config file (and env *values* never enter
  trust fingerprints).
- Schema changes: migrations are committed SQL under `packages/kernel/drizzle/`;
  apply them explicitly with `orc db migrate`. `drizzle-kit` is deliberately
  not installed (its loader chain is vulnerable);
  generate with a pinned one-shot `bunx drizzle-kit@latest generate` + audit
  the output, or write a reviewed SQL migration by hand.
- Resetting development state: `docker compose down -v && docker compose up -d --wait && orc db migrate`
  drops and recreates Postgres (events, journal, DBOS) and SurrealDB; the vault re-renders
  and memory rebuilds from events on next use. Old pre-identity projects run
  `orc init` once; old string-only trust grants fail closed and must be granted again.
- Never bundle the CLI (`bun build`): DBOS must run unbundled via `bun run`.
- Upgrading orc: finish or `orc cancel` active runs first — DBOS recovery is
  keyed to the app version (`DBOS__APPVERSION`).

## License

orc is dual-licensed:

- **Noncommercial use — free.** Use it, modify it, share it (with your
  changes) under the [PolyForm Noncommercial License 1.0.0](LICENSE.md) —
  personal projects, research, study, education, and noncommercial
  organizations. Keep the license and the Required Notice with every copy.
- **Commercial / monetized use — by agreement.** Selling it, hosting it as a
  service, building it into a paid product, or using it inside a for-profit
  business requires a commercial license with two standing terms: a fair
  share of the value it helps create, and visible attribution. See
  [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) — 30-day free evaluation for
  commercial entities included.
