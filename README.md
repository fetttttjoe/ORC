# orchestrator

A generic multi-agent orchestrator: recursive task splitting, human plan
approval, multi-provider agent dispatch, plugin-first. Design spec:
`docs/superpowers/specs/2026-07-16-orchestrator-design.md`.

## Status

M3 (plugins) — the plugin host is live: SKILL.md skills are hot-indexed from
`vault/skills/` and force-loaded into steps, MCP servers plug in as
trust-gated tool providers, and in-process TypeScript extensions can register
providers/executors and observe every event. Vault (M4) and
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
orc skills                      # indexed SKILL.md skills (vault/skills/<name>/SKILL.md)
orc mcp list                    # declared MCP servers + trust state
orc mcp trust <id>              # local consent (writes .orc/trust.json — never commit it)
orc mcp tools <id>              # spawn a trusted server, list its tools
orc ext list                    # declared T2 extensions + trust state
orc retry <task-id>             # re-run failed steps after a block
```

Every state change is an append-only event in Postgres; all state is a pure
fold over that log — replay and audit come for free. Kill the process
mid-run and `orc run` again: DBOS resumes from the last checkpoint and no
completed model call is ever re-billed.

## Operational notes

- `ORC_DATABASE_URL` overrides the default `postgresql://postgres:orc@localhost:5433/orc`.
- Plugins: `.orc/config.json` *declares* (`mcpServers`, `extensions`, `skillsDir`);
  `.orc/trust.json` *grants* — created only by `orc mcp trust` / `orc ext trust`,
  never commit it. Steps opt into tools/skills via `toolRefs` / `skillRefs`;
  plans referencing unknown or untrusted refs fail at propose time.
- `env` values in `mcpServers` starting with `$` pull from orc's own environment
  at spawn — secrets never go in the config file.
- Never bundle the CLI (`bun build`): DBOS must run unbundled via `bun run`.
- Upgrading orc: finish or `orc cancel` active runs first — DBOS recovery is
  keyed to the app version (`DBOS__APPVERSION`).
- Optional ops tooling: DBOS Conductor / admin API can inspect workflow state;
  nothing is wired to it by default (local-first).
