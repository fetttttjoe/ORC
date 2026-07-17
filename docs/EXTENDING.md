# Extending orc — the seam map

The kernel is policy-free; every improvement lands through a seam. Before
adding code to the kernel, find the row that fits — if none fits, the first
step is adding a seam to `packages/contracts`, not code to the kernel.

## Where a change goes

| You want to… | Seam | What you touch |
|---|---|---|
| Add a model provider | `ModelProvider<LM>` | new `plugins/provider-<x>/` + one line in `seedRegistries` (`packages/cli/src/runtime.ts`) — or zero-fork via a T2 extension calling `registerProvider` |
| Add an agent executor | `AgentExecutor` | new `plugins/executor-<x>/` + `seedRegistries` — or `registerExecutor` from a T2 extension |
| Add agent knowledge / procedure | SKILL.md | `vault/skills/<name>/SKILL.md` — no code, hot-indexed, force-loaded via `skillRefs` |
| Add external tools | MCP server | declare in `.orc/config.json` `mcpServers`, arm with `orc mcp trust` — no code, steps opt in via `toolRefs` |
| Observe / integrate (metrics, vault projection, notifications) | T2 extension | a `.ts` file default-exporting `{ id, activate(api) }`; `api.on('event_appended', …)`; declare in config, arm with `orc ext trust` |
| Record new durable state | event kind | `EventKind` + `PAYLOAD_SCHEMAS` in `packages/contracts/src/events.ts`, then a `fold` case in `packages/kernel/src/projections.ts` (the exhaustive `switch` makes the compiler demand it); check `crashDedupKey` if the event is step-scoped |
| Add a CLI verb | commander | `buildProgram` in `packages/cli/src/main.ts` |
| Add a setting | config schema | `settingsSchema` in `packages/kernel/src/config.ts` — default in `.default()`, env override in `envOverrides` |
| Add a failure semantic | `FailureClass` | `packages/contracts/src/execution.ts` + throw `classifiedError(cls, msg)` |
| Change orchestration policy (routing, strategies, gates) | plan data | plans are frozen data — policy belongs in whatever *writes* the plan (planner plugins, M5), never in the interpreter |

## Invariants — the rules that keep changes cheap

1. **State is `fold(events)`.** Never store derived state; add an event kind
   and a fold case. Replay and audit stay free only while this holds.
2. **Every side effect lives in a `checkpoint`,** and its events are appended
   inside the durable step. Throw `terminalError()` for don't-retry failures,
   `classifiedError()` when the failure class matters.
3. **Contracts stay runtime-dependency-free** (zod only). Plugins import
   contracts, never the kernel. The kernel never imports plugins — it receives
   them (see `createDbosPort(opts)`, `createPluginHost(config, seed)`).
4. **Declare vs grant.** `.orc/config.json` declares, `.orc/trust.json` arms.
   Enforce trust at the point of use (as `McpHub.ensureClient` does), not only
   at plan validation.
5. **Refs are validated at propose time.** A new ref type (skill, tool,
   executor, provider) gets a check in `refValidator`
   (`packages/kernel/src/plugins/host.ts`) so bad plans die before approval,
   not mid-run.
6. **No scattered string literals** for matched values — always the const maps
   (`TASK_STATUS`, `EVENT_KIND`, `ISOLATION_TIER`, `FAILURE_CLASS`, …).
7. **Deliberate ceilings carry a `ponytail:` comment** naming the ceiling and
   the upgrade path (existing examples: global advisory lock, refold-per-call,
   500 ms polling). A shortcut without its comment is a bug report waiting.
8. **A new seam ships with three things:** its contract in
   `packages/contracts`, its propose-time validation, and a test that fails
   without it.

## When to promote

- `seedRegistries` grows past a handful of lines → load first-party
  providers/executors as default-trusted T2 extensions instead (the API
  already supports it; don't do it before the friction is real).
- A `ponytail:` ceiling is measurably hit → the comment names the upgrade;
  do that, delete the comment.
