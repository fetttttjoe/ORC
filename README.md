# orchestrator

A generic multi-agent orchestrator: recursive task splitting, human plan
approval, multi-provider agent dispatch, plugin-first. Design spec:
`docs/superpowers/specs/2026-07-16-orchestrator-design.md`.

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
