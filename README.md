# orchestrator

A generic multi-agent orchestrator: recursive task splitting, human plan
approval, multi-provider agent dispatch, plugin-first. Design spec:
`docs/superpowers/specs/2026-07-16-orchestrator-design.md`.

## Status

M1 (foundation) — event-sourced kernel + CLI. Execution (M2), plugins (M3),
vault (M4), recursion/strategies (M5) follow the roadmap in
`docs/superpowers/plans/`.

## Stack

TypeScript end-to-end on Bun (package manager, runtime, test runner).
Drizzle ORM over `bun:sqlite`. Zod contracts. Commander CLI.

## Quickstart

```bash
bun install && bun test

alias orc="bun $PWD/packages/cli/src/bin.ts"
orc new "write release notes" --spec "summarize changes since v1.2"
orc propose <task-id>        # single-step template plan
orc plan <task-id>           # review it
orc approve <task-id>        # the human gate
orc log <task-id>            # the full event trail
```

Every state change is an append-only event in `.orc/state.db`; all state is
a pure fold over that log — replay and audit come for free.
