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
  instead of being silently zeroed by it. Nothing ranks or expires on the
  counter — it is measurement, so a later decay policy can be tuned against
  data rather than guessed.

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
