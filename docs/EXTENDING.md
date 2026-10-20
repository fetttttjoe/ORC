# Extending orc: the seam map

The kernel is policy-free; every improvement lands through a seam. Before adding code to the kernel, find the row
that fits. If none fits, the first step is adding a seam to `packages/contracts`, not code to the kernel.

## Where a change goes

| You want to… | Seam | What you touch |
|---|---|---|
| Add a model provider | `ModelProvider<LM>` | a new `plugins/provider-<x>/` plus one line in `seedRegistries` (`packages/cli/src/runtime.ts`), or zero-fork via a T2 extension calling `registerProvider` |
| Add an agent executor | `AgentExecutor` | a new `plugins/executor-<x>/` plus `seedRegistries`, or `registerExecutor` from a T2 extension |
| Add agent knowledge or a procedure | SKILL.md | `vault/skills/<name>/SKILL.md`: no code, hot-indexed, force-loaded via `skillRefs`; add it to `SHIPPED_SKILLS` (`packages/cli/src/shipped-skills.ts`) only to seed it on `orc init`, which never overwrites project edits |
| Add external tools | MCP server | declare it in `.orc/config.json` `mcpServers`, arm it with `orc mcp trust`: no code, steps opt in via `toolRefs`. Skills name *capabilities*, never server or tool names, so a procedure like `web-research` runs on whatever the project trusts |
| Observe or integrate (metrics, notifications) | T2 extension | a `.ts` file default-exporting `{ id, activate(api) }`; `api.on('event_appended', …)`; declare it in config, arm it with `orc ext trust` (a fingerprint of the entry, its literal local dependency closure and `bun.lock`) |
| Record new durable state | event kind | the kind goes in `EventKind` (`packages/contracts/src/event-kinds.ts`, a LEAF module, so a payload schema and the kind naming it can be defined in either order), its schema in `PAYLOAD_SCHEMAS` (`packages/contracts/src/events.ts`), then a `fold` case in `packages/kernel/src/projections.ts`, a routing decision in `ROUTER_RELEVANT` (`packages/kernel/src/execution/signal-router.ts`) and a display line in `packages/ui-core/src/summarize.ts`: all three are exhaustive, and the compiler demands each. Check `crashDedupKey` if the event is step-scoped. A kind with a `taskId` re-renders that task's vault files with no further change |
| Store knowledge somewhere else | `KnowledgeBackend` | a `KnowledgePlugin` (`{ id, create(options, host) }`, `packages/contracts/src/knowledge.ts`) added to `KNOWLEDGE_PLUGINS` (`packages/cli/src/knowledge-open.ts`) and selected with `knowledge.plugin` in `.orc/config.json`. It must pass `describeKnowledgeBackend` (`packages/knowledge-core/src/contract-suite.ts`), the suite the git-files and in-memory backends pass. It reads and writes; the port records the evidence, so it never appends an event |
| Anchor symbols in another language | `StructureProvider` | an outline (`Outline`: a digest, named symbol spans, a `partial` flag) for the file type; the shipped provider is `plugins/structure-treesitter`, whose `grammars.ts` maps extensions to grammars, and the CLI hands it to the backend as `KnowledgeHost.structure` |
| Add a CLI verb | commander | a command in the module of its group (`task-commands.ts`, `exec-commands.ts`, `project-commands.ts`, `serve-commands.ts`, `plugin-commands.ts`, or a `<group>-commands.ts` of its own) taking the `Pick<ProgramDeps, …>` it needs (`packages/cli/src/program-deps.ts`); `buildProgram` in `packages/cli/src/main.ts` adds it |
| Add a setting | config schema | `settingsSchema` in `packages/kernel/src/config.ts`: the default in `.default()`, an env override in `envOverrides` |
| Add a failure semantic | `FailureClass` | `packages/contracts/src/execution.ts`, then throw `classifiedError(cls, msg)` |
| Change orchestration policy (routing, strategies, gates) | plan data | plans are frozen data: policy belongs in whatever *writes* the plan (planner plugins), never in the interpreter |

## Invariants: the rules that keep changes cheap

1. **State is `fold(events)`.** Never store derived state; add an event kind and a fold case. Replay and audit
   stay free only while this holds. (The Postgres `operations` table is a rebuildable index over operation
   transition events, `rebuildOperations()` reproduces it from the log, not an exception.) What is true about
   the code is the other source of truth and lives in git, as [knowledge files](knowledge-files.md): the log
   records their deliveries, writes and checks as evidence, never their content as truth.
2. **Every external model or tool effect lives in a `ctx.operation`**: the journal records its `before` before
   the call and completion or failure after, keyed by a deterministic operation id. Other side effects live in
   `ctx.checkpoint`; both append their events transactionally under deterministic idempotency keys. Throw
   `terminalError()` for don't-retry failures, `classifiedError()` when the failure class matters.
3. **Contracts stay runtime-dependency-free** (zod only). Plugins import contracts, never the kernel. The kernel
   never imports plugins: it receives them (see `createDbosPort(opts)`, `createPluginHost(config, seed)`).
   `knowledge-core` imports contracts alone, so a backend depends on it and on contracts, never on the kernel.
4. **Declare vs grant.** `.orc/config.json` declares, `.orc/trust.json` arms, and a grant binds to a fingerprint
   of what was consented to (MCP: command, args, env key names; extension: entry plus recursively resolved literal
   local imports, dynamic imports and requires, plus the project's `bun.lock`). Enforce trust at the point of use
   and again on extension reload, not only at plan validation. The knowledge backend and the vault projector are
   privileged first-party runtime packages wired directly into the CLI runtime; ordinary observation and
   integration go through T0 (skills), T1 (MCP) or T2 (extensions).
5. **Refs are validated at propose time.** A new ref type (skill, tool, executor, provider) gets a check in
   `refValidator` (`packages/kernel/src/plugins/host.ts`) so bad plans die before approval, not mid-run.
6. **No scattered string literals** for matched values: always the named vocabulary (`TASK_STATUS`,
   `EVENT_KIND`, `IsolationTier`, `FailureClass`, `ClaimClass`, `ClaimState`, `DeliveryMode`, `KnowledgeToolName`,
   …): a TS `enum` parsed with `z.enum(Enum)`, or an array paired with its `.enum` accessor. A new vocabulary ships
   its accessor in the same commit; a bare literal union without one guarantees literals scattered at the call
   sites within a release.
7. **One writer per concern.** The kernel writes task, plan, run and workspace events; the knowledge port writes
   knowledge events and never touches a file; a knowledge backend writes files and never appends. A new store
   gets one writer, behind one data-access service.
8. **Deliberate ceilings carry a one-line `ponytail:` comment** naming the ceiling and the upgrade path. A
   shortcut without its comment is a bug report waiting.
9. **A new seam ships with three things:** its contract in `packages/contracts`, its propose-time validation, and
   a test that fails without it. Async observation hooks are detached from event transactions, tracked by
   `HookBus`, and drained before extension deactivation.

## When to promote

- `seedRegistries` grows past a handful of lines → load first-party providers and executors as default-trusted T2
  extensions instead (the API already supports it; don't do it before the friction is real).
- A `ponytail:` ceiling is measurably hit → the comment names the upgrade; do that, and delete the comment.
