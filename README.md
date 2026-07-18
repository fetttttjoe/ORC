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
Startup is degraded-memory tolerant. Every task is auditable, resumable,
project-isolated, and visible through separate execution, lineage, and
knowledge graphs.

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

alias orc="bun $PWD/packages/cli/src/bin.ts"
export ANTHROPIC_API_KEY=...    # and/or run a local Ollama

orc init --name my-project      # committed identity in .orc/config.json — run once, commit it
orc new "write release notes" --spec "summarize changes since v1.2; declare the notes file as an output"
orc propose <task-id> --model anthropic/claude-sonnet-5   # or ollama/<model>
orc plan <task-id>              # review it
orc approve <task-id>           # the human gate
orc run <task-id>               # durable execution with live event tail
orc status <task-id>            # project, memory health, steps, operations, receipts, cost
orc replay <task-id> --at <seq> # read-only audit replay at any event sequence
orc log <task-id> --json        # full redacted event records
orc skills                      # indexed SKILL.md skills (vault/skills/<name>/SKILL.md)
orc mcp trust <id>              # local consent, bound to the server's declaration fingerprint
orc ext trust <path>            # local consent, bound to the extension's content hash
orc retry <task-id>             # re-run failed steps after a block
```

### Documentation from the knowledge graph

Documentation is an ordinary orchestrated task — no extra runner. Skills are
per-project: copy `vault/skills/documentation/` from this repo into your
project's `vault/skills/` first (propose fails loudly on an unknown skill):

```bash
task_id=$(orc new "generate architecture docs" --spec "Write docs/architecture.md from current/target memory; declare it as an output")
orc propose "$task_id" --model anthropic/claude-sonnet-5 --skill documentation
orc approve "$task_id"
orc run "$task_id" --cwd .
```

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
- **Output lineage.** A success signal may declare workspace-relative
  `outputs`; the runtime verifies each file, computes its SHA-256 receipt, and
  commits `artifact_produced` atomically with `step_completed`.
- **Secrets** are redacted once at the storage boundary (sensitive keys +
  configured env values; add names via `redactEnv` in config). Projections
  and vault files only ever see redacted data.
- **Degraded memory.** SurrealDB down ⇒ one warning, explicit
  `memory unavailable` tool results, and everything else — history,
  execution, cancellation, vault trace — keeps working.

## Vault views

- `vault/index.md` — recursive task-expansion graph + live status
- `vault/tasks/<id>/execution.md` — plan steps + operation nodes (attempts, unresolved/completed/failed)
- `vault/tasks/<id>/lineage.md` — producing step → verified output receipts
- `vault/memory/index.md` — authored knowledge: current architecture, target architecture, decisions

## Operational notes

- `ORC_DATABASE_URL` overrides the default `postgresql://postgres:orc@localhost:5433/orc`.
- Plugins: `.orc/config.json` *declares* (`mcpServers`, `extensions`, `skillsDir`);
  `.orc/trust.json` *grants* — created only by `orc mcp trust` / `orc ext trust`,
  written atomically with mode 0600, never commit it. Grants bind to a
  fingerprint: MCP to (command, args, env *names*), extensions to the entry
  file's content hash. Change either and the grant is invalid until re-trusted.
  MCP servers still run with this user's full permissions — vet before trusting.
- `env` values in `mcpServers` starting with `$` pull from orc's own environment
  at spawn — secrets never go in the config file (and env *values* never enter
  trust fingerprints).
- Schema changes: migrations are committed SQL under `packages/kernel/drizzle/`.
  `drizzle-kit` is deliberately not installed (its loader chain is vulnerable);
  generate with a pinned one-shot `bunx drizzle-kit@latest generate` + audit
  the output, or write a reviewed SQL migration by hand.
- Resetting development state: `docker compose down -v && docker compose up -d --wait`
  drops Postgres (events, journal, DBOS) and SurrealDB; the vault re-renders
  and memory rebuilds from events on next use. Old pre-identity projects run
  `orc init` once; old string-only trust grants fail closed and must be granted again.
- Never bundle the CLI (`bun build`): DBOS must run unbundled via `bun run`.
- Upgrading orc: finish or `orc cancel` active runs first — DBOS recovery is
  keyed to the app version (`DBOS__APPVERSION`).
