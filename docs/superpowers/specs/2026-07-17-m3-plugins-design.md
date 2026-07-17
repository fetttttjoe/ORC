# M3 Plugins — Design Specification

**Date:** 2026-07-17
**Status:** Approved design, pre-implementation
**Parent spec:** `2026-07-16-orchestrator-design.md` (this document amends §5.2 `PlanStep`/`ExtensionManifest`, §8.3, §8.7 — noted inline there)

---

## 1. Goal & Scope

M3 makes the plugin ecosystem real: skills as hot-indexed SKILL.md files force-loaded into steps (T0), MCP servers as spawn-on-demand tool providers with an explicit trust gate (T1), and in-process TypeScript extensions that register providers/executors and observe every event (T2) — all behind the contracts seam, with plan-time validation of every ref a step declares.

**In scope:** `SkillManifest` + skill index with fs-watch hot reload; skill force-loading into step context with `skill_loaded` events; `plugins/mcp-client` package on the official MCP TS SDK (stdio, lazy spawn, deferred schemas, `listChanged`); `PlanStep.toolRefs` + MCP tools surfaced to the api-loop executor; trust store (`.orc/trust.json`) gating MCP servers and extensions; T2 extension loader (dynamic import, cache-busted reload, `activate(api)` registration); hook bus (`session_start`, `session_shutdown`, `event_appended`); plan-time ref validation (`validation_error`); CLI `orc skills`, `orc mcp list/tools/trust`, `orc ext list/trust`.

**Out of scope (deliberate cuts, with return dates):**

| Cut | Returns |
|---|---|
| Vault projection proper — `vault/skills/` is created as a plain watched directory | M4 |
| User-level config + user-level trust (`trust: 'user'`) | M4, with user config |
| Model-side skill browsing / on-demand skill activation (M3 force-loads `skillRefs` only) | M5 |
| Veto/mutating hooks (M3 hooks are observe-only) | M5, if approval-policy work demands it |
| `allowed-tools` skill frontmatter *enforcement* (parsed + stored, not enforced) | M5, with zones/permissions |
| Tool-existence check at approve time (M3 checks server id + trust at propose; tool names fail fast at step init, before any model call) | M5, if it bites |
| MCP HTTP/SSE transports, resources/prompts/sampling (stdio + tools only) | when a consumer exists |
| Unicode/i18n skill names (ASCII lowercase subset of the open spec) | if anyone asks |
| WASM plugin substrate | post-v1 (parent §8.3) |

## 2. Evidence (validated 2026-07-17, 4-agent workflow; spike code in session scratchpad)

- **MCP TS SDK on Bun (hands-on spike):** `@modelcontextprotocol/sdk@1.29.0` + zod 4 on Bun 1.3.13 is clean end-to-end. `StdioClientTransport` (node:child_process-based) spawns/pipes/kills correctly under Bun; `client.close()` kills the child (<300 ms, no zombies; SIGKILLed parent → child dies on stdin EOF within 1.5 s). `listTools()` returns JSON-Schema `inputSchema` per tool; `callTool` reports tool-level failures via `result.isError` (never throws for them); crash-on-startup surfaces as `McpError -32000` (capture `stderr: 'pipe'` for the real reason); missing executable → `ENOENT`. `notifications/tools/list_changed` works end-to-end via `client.setNotificationHandler(ToolListChangedNotificationSchema, …)`.
- **SKILL.md open spec (agentskills.io, reference validator `skills-ref`):** allowed frontmatter fields are exactly `{name, description, license, allowed-tools, metadata, compatibility}` — any other top-level key is an error. `name`: ≤64 chars, lowercase alnum + hyphen, no leading/trailing/double hyphen, **must equal the parent directory name**. `description`: non-empty, ≤1024 chars. `compatibility` ≤500 chars. No top-level version field — versioning is a `metadata` convention. Layout: `<skill-name>/SKILL.md` (+ optional `scripts/`, `references/`, `assets/`). Progressive disclosure is three-tier: catalog = name+description (~50–100 tokens/skill), body on activation (<5000 tokens recommended), resources on demand. Host guidance: strict validation is the right pre-activation gate for agent-authored skills.
- **T2 reload (hands-on spike):** Bun transpiles TS on dynamic `import()` of an absolute path — no build step, local TS deps work. Plain re-import returns the cached module; `delete require.cache[absPath]` evicts the ESM entry too (facade over the same registry) and a plain re-import re-reads disk — **no registry growth** (query-string busting grows `Loader.registry` by one entry per reload, forever). **Transitive footgun confirmed:** evicting only the entry file leaves its local deps cached and re-binds the fresh parent to stale deps — the loader must evict every cache key under the extension's directory prefix, then re-import.
- **fs.watch on Bun/Linux (hands-on spike): partial — rejected for T0.** Recursive `fs.watch` works for pre-existing subtrees (0–2 ms latency; atomic write-tmp-then-rename fires exactly one event for the target) **but files inside a directory created after the watch started NEVER fire events on Bun 1.3.13** — one `rename` for the new dir itself, then permanent silence; that blind spot *is* the create-a-skill-at-runtime case. Additionally: renaming/deleting a watched dir silently poisons later watches on that path for the process lifetime; dotfiles are silently filtered; rename events carry the destination name only. Meanwhile a full `readdir`+`stat` rescan of 200 skill dirs measures **0.89 ms**. Conclusion: polling rescan (§5.1), not fs.watch. No Bun-native watcher API exists (`Bun.*` has none; `--watch/--hot` are process-reload flags).

## 3. Decisions

- **D1 — Plugin host is a kernel module; MCP stays a plugin package behind a neutral seam.** `packages/kernel/src/plugins/` hosts the T0 skill index, T2 extension loader, hook bus, and `createPluginHost(config, seed)` composition (parent §5.3 places the PluginHost in the kernel). The MCP SDK never enters the kernel: `@orc/contracts` gains a `ToolSource` interface, `plugins/mcp-client` implements it, and the CLI wires it into the port — same injection pattern as providers/executors in M2.
- **D2 — Registries stay in-memory Maps; extensions extend them.** First-party providers (anthropic/openai/ollama) and the api-loop executor are seeded statically by the CLI exactly as in M2; T2 `activate(api)` calls `registerProvider`/`registerExecutor` to add more. This is how M2-D4's "providers become true runtime plugins" lands with zero contract change — no dynamic package-name resolution machinery (an extension file that imports and registers a package is the resolution mechanism).
- **D3 — Trust is a separate, never-committed file.** `.orc/config.json` *declares* MCP servers and extensions (shareable, committable); `.orc/trust.json` *grants* them (`{ mcp: string[], extensions: string[] }`), written only by `orc mcp trust <id>` / `orc ext trust <path>`. A cloned repo therefore cannot auto-execute servers or extension code: declared-but-untrusted entries are skipped with a loud warning and fail plan validation if referenced. This hardens parent §8.7 ("consent on first load") into an explicit local grant.
- **D4 — `PlanStep.toolRefs` (new field, default `[]`) freezes each step's MCP tool surface at plan time.** Ref format `<serverId>/<toolName>`, mirroring `modelRef`. Model-facing names are mangled `mcp__<server>__<tool>` (provider-safe charset, Claude Code convention); events record the mangled name in the existing `tool_call`/`tool_result` kinds. Deferred schema loading: schemas are fetched at step init, only for the refs the step declares — never at index or propose time.
- **D5 — Plan-time ref validation via an injected validator.** `Kernel` gains an optional `refValidator: (plan: Plan) => Promise<string[]>`; propose/edit fail with `plan_validation_failed` listing unknown `executorRef`/`modelRef`-provider/`skillRefs`/`toolRefs`-server-or-untrusted errors. The CLI builds the validator from the plugin host (registries + skill index + declared/trusted MCP config). `FailureClass` gains `validation_error` for runtime ref failures (skill deleted after approval, tool vanished from server): step init fails fast — before any model call, so no tokens are burned.
- **D6 — Hooks are observe-only and event-shaped.** Three hooks: `session_start`, `session_shutdown`, `event_appended(EventRecord)`. Every parent-spec seam (`plan_proposed`, `step_starting`, `agent_event`, `step_completed`, …) already *is* an event kind, so one `event_appended` hook with kind filtering covers them all. Wiring: `EventLog` gains one optional observer, set by the runtime; handler errors are caught and logged, never fail the append. Under DBOS at-least-once steps a hook can fire twice across a crash boundary — documented; handlers must tolerate replays.
- **D7 — Extension manifest is function-shaped** *(amends parent §5.2's data sketch)*: an extension file default-exports `{ id, activate(api), deactivate?() }`. Hooks and registrations happen as `activate()` calls (`api.on`, `api.registerProvider`, `api.registerExecutor`) — functions don't zod, and the VS Code/pi-proven shape needs no registration DSL. `session_start` ≙ activate, `session_shutdown` ≙ deactivate. Reload = evict cache keys under the extension dir prefix + re-import + re-activate (spike-validated); exposed as `host.reloadExtensions()`, used at session boundaries only in M3 (no mid-run reload — determinism).
- **D8 — Skills live in `vault/skills/<name>/SKILL.md`** (parent §8.2 layout; the directory is created on demand — vault projection proper is M4). Config `skillsDir` overrides. Strict open-spec validation before activation (agent-authored skills are the threat model); invalid skills stay visible in the index as invalid-with-errors and fail plan validation if referenced. Force-loading appends one `skill_loaded` event per skill (payload `{stepId, runToken, name, hash}`) inside the step-init checkpoint — the event log records exactly which skill *content* (body sha256) influenced the step (R9).
- **D9 — MCP lifecycle: lazy spawn, cached client, invalidate on `listChanged`, kill on shutdown.** A server process starts on first tool resolution (or explicit `orc mcp tools <id>`), not at CLI startup. `tools/list_changed` invalidates the cached tool list. `callTool` `isError` maps to the existing tool-result `isError` (an MCP tool failure is a tool error the model sees, never a step crash — same trust-boundary stance as M2's fs tools).

## 4. Contracts (additions to `@orc/contracts`)

- **`SkillManifest`** — zod: `{ name (≤64, /^[a-z0-9]+(-[a-z0-9]+)*$/), description (1–1024), license?, compatibility? (≤500), allowedTools? (string), metadata? (Record<string,string>) }` parsed from frontmatter (`allowed-tools` → `allowedTools`). **`SkillIndexEntry`** — `{ name, dir, valid: boolean, errors: string[], manifest: SkillManifest | null }` (invalid entries keep the dir name + errors). **`LoadedSkill`** — `{ name, body, hash }`.
- **`ResolvedTool`** (interface) — `{ ref, name, description, inputSchema: Record<string, unknown> /* JSON Schema */, execute(input: unknown): Promise<{ output: unknown; isError: boolean }> }`.
- **`ToolSource`** (interface) — `{ resolve(refs: string[]): Promise<ResolvedTool[]>; close(): Promise<void> }`. `resolve` throws with a clear message on unknown server/tool or untrusted server → step init catches → `step_failed(validation_error)`.
- **`ExtensionManifest`** (interface) — `{ id, activate(api: ExtensionApi): void | Promise<void>, deactivate?(): void | Promise<void> }`. **`ExtensionApi`** — `{ registerProvider(id, p: ModelProvider<unknown>), registerExecutor(id, e: AgentExecutor<unknown>), on<H extends HookName>(hook: H, handler: HookHandlers[H]) }`.
- **`HookName`/`HOOK_NAME`** — `session_start | session_shutdown | event_appended`; `HookHandlers` maps each to its handler signature (`event_appended: (e: EventRecord) => void | Promise<void>`).
- **`PlanStep.toolRefs`** — `z.array(z.string().regex(/^[a-z0-9-]+\/.+$/)).default([])`.
- **`FailureClass`** — add `validation_error`.
- **`EventKind`** — add `skill_loaded`; payload `{ stepId, runToken, name, hash }`. `crashDedupKey` gains the payload `name` as a fourth discriminator (two skills loaded in one step-init must not dedup each other; the pinned formula test updates deliberately).
- **`ExecutorContext`** — add `skills: LoadedSkill[]` and `extraTools: ResolvedTool[]`.
- **`McpServerConfig`** — zod: `{ command: string, args?: string[], env?: Record<string,string> }`, id key pattern `/^[a-z0-9-]+$/` (ids flow into tool-name mangling).

## 5. Plugin Host Architecture

### 5.1 T0 — Skill index (`packages/kernel/src/plugins/skills.ts`)

`SkillIndex.open(skillsDir)` scans `<skillsDir>/*/SKILL.md`: parse frontmatter (hand-rolled `key: value` + `---` fence parser — the six-field flat schema needs no YAML dependency; a quoted-string/plain-scalar subset is documented), validate strictly (unknown top-level frontmatter keys are errors, per the reference validator; name must equal the directory name), build `SkillIndexEntry[]`. Progressive disclosure: the index holds frontmatter only; `load(name)` reads the body on demand and returns `LoadedSkill` with `hash = sha256(body)`.

`watch()` is a **polling rescan, not fs.watch** *(evidence-driven deviation from parent §8.3's "file watch" wording — the mechanism changes, the behavior contract doesn't)*: a 500 ms interval runs `readdir`+`stat` over `<skillsDir>/*/SKILL.md` (spike-measured 0.89 ms for 200 skills), re-parses frontmatter only for entries whose `(mtimeMs, size)` changed, and drops entries whose file vanished. Rationale (spike, §2): Bun 1.3.13's recursive `fs.watch` never reports files inside directories created after the watch started — the exact new-skill-at-runtime path — and has watcher-poisoning bugs on dir rename/delete; a sub-millisecond poll is simpler, platform-neutral, immune to all of it, and meets the <1 s index target with margin. `close()` clears the interval. Long-lived processes (`orc run`) watch; one-shot commands just scan. *(fs.watch can return as a low-latency trigger if Bun ever closes the recursive gap.)*

### 5.2 T1 — MCP client (`plugins/mcp-client`)

`createMcpHub(servers: Record<id, McpServerConfig>, trusted: Set<string>): ToolSource & { listTools(id): Promise<…>, }` on `@modelcontextprotocol/sdk` ^1.29:

- `resolve(refs)`: group refs by server; reject any server not declared or not trusted (throw — this is the runtime half of the trust gate); lazily `connect()` one cached client per server (`StdioClientTransport`, `stderr: 'pipe'` retained for error surfacing); `listTools()` cached per server, invalidated by a `ToolListChangedNotificationSchema` handler; unknown tool name → throw. Returns `ResolvedTool[]` with mangled names and `execute` = `callTool` (SDK `isError` → tool-result `isError`; transport-level throw → `{ output: { error }, isError: true }` after one reconnect attempt — a dead server is a tool error the model can react to, not a step crash).
- Spawn env: `{ ...getDefaultEnvironment(), ...cfg.env }` — the SDK's sanitized default (PATH/HOME/…), never the full `process.env` (which would hand `ANTHROPIC_API_KEY` etc. to every server binary); a server that needs a secret gets it via an explicit `env` entry in its config.
- `close()`: `client.close()` per live server (spike: child dies <300 ms).

### 5.3 T2 — Extension loader (`packages/kernel/src/plugins/extensions.ts`)

`loadExtensions(paths, trusted, api)`: for each config-declared path — skip + warn if not in the trust store; `import(abs)`; validate the default export shape (`id` + `activate` function, else loud skip); `await activate(api)`. `reloadExtensions()`: `deactivate?()` all, evict every `require.cache` key under each extension file's directory prefix (spike: transitive deps must be evicted; dir-prefix eviction covers local imports, node_modules stays cached), re-import, re-activate. Registrations land in the same Maps the port consumes; re-registration overwrites by id (last write wins, warn on shadowing a seeded id).

### 5.4 Hook bus (`packages/kernel/src/plugins/hooks.ts`)

`HookBus` — `on(hook, handler)` / `emit(hook, payload)`; emit awaits handlers sequentially, catches + `console.warn`s per-handler errors. Runtime wiring: `EventLog.onAppend = e => bus.emit(HOOK_NAME.event_appended, e)` (one optional observer field on `EventLog`, invoked post-append, both direct and in-transaction); `session_start` fired after host build, `session_shutdown` before port shutdown.

### 5.5 Composition (`packages/kernel/src/plugins/host.ts`)

`createPluginHost(config, seed: { providers, executors })` → `{ providers, executors, skills: SkillIndex, hooks: HookBus, trust, refValidator, reloadExtensions, shutdown }`. Order: build bus → seed registries → load trust store → load extensions (they may register into the maps and subscribe hooks) → open skill index. `refValidator(plan)`: for each step — `executorRef` in executors; `modelRef` provider-id in providers; each `skillRefs` name in the index *and valid*; each `toolRefs` server declared in `config.mcpServers` *and trusted*. Returns error strings (kernel joins them into `plan_validation_failed`). The CLI's `openKernel` builds a host (no DBOS, no MCP spawn — cheap) so propose/edit validate everywhere, not just under `orc run`.

## 6. Execution Integration

Step-init (dbos-port) additions, all inside the existing `init` checkpoint: resolve `step.skillRefs` → `skills.load()` each (invalid/missing → throw `validation_error` before any model call) and emit one `skill_loaded` event per skill alongside `step_started`; resolve `step.toolRefs` via the injected `ToolSource` (same failure path). `createDbosPort` opts gain `tools?: ToolSource` and `skills?: SkillIndex`. `ExecutorContext` carries `skills` + `extraTools`; api-loop merges: `buildPrompt` renders `# Skill: <name>` sections after the step instructions (force-loaded, never model-elective — parent §8.3); `toolSet()` gains the extra tools via `tool({ description, inputSchema: jsonSchema(t.inputSchema) })`; the execute router tries builtin names first, then `extraTools` by mangled name. MCP tool calls flow through the existing `tools:<iteration>` checkpoint and `tool_call`/`tool_result` events unchanged — full R9 traceability for free.

Failure taxonomy addition: `validation_error` rows in the §9 table of the M2 spec — detection: unknown/invalid skill or tool ref at step init; handling: immediate `step_failed(validation_error)`, task → `blocked`, zero model calls.

## 7. CLI

- `orc skills` — index listing: name, ✓/✗(errors), description (truncated ~80 chars).
- `orc mcp list` — declared servers + trusted/untrusted.
- `orc mcp tools <id>` — spawns the (trusted) server, lists tool names + descriptions + a one-line vetting warning (parent §11 risk 4); explicit spawn — `list` never spawns.
- `orc mcp trust <id>` / `orc ext trust <path>` — append to `.orc/trust.json` (created 0600-ish default perms; documented: never commit; add to `.gitignore`).
- `orc ext list` — declared extensions + trusted/untrusted + loaded id.
- Existing commands: propose/edit now validate refs (host-backed); run wires skills/tools/hooks through the port.

## 8. Config

`.orc/config.json` additions (all optional): `skillsDir` (default `<cwd>/vault/skills`), `mcpServers: Record<id, McpServerConfig>`, `extensions: string[]` (paths relative to the config's directory). `.orc/trust.json` (never committed): `{ mcp: string[], extensions: string[] }` — absent file = nothing trusted.

## 9. Testing

- **Unit (no infra):** SkillManifest validation table (name/dir mismatch, bad charset, >64, empty/long description, unknown frontmatter key, missing fence); index scan with mixed valid/invalid skills; frontmatter parser edge cases (quoted values, colons in values, CRLF); `watch()` hot-index via polling (<1 s assertion for a skill dir created *after* watch start — the case fs.watch can't do — plus modify and delete); extension loader trust refusal + activate registration + reload-evicts-closure (edit dep file, assert fresh value); hook bus error containment; refValidator error strings for each ref class; crashDedupKey with skill names; tool-name mangling round-trip; `toolRefs` schema default.
- **Integration (compose Postgres + fixture MCP server):** an in-repo SDK-based fixture server (echo/add + a late-registered tool for `listChanged`); mcp-client resolve/execute/isError/lazy-spawn/close-kills-child/untrusted-throw; full DBOS run where the scripted fake provider calls an MCP tool and a skill is force-loaded — assert `skill_loaded` + `tool_call`/`tool_result` events, replay identity, and the skill body present in the model's prompt (fake provider captures it).
- **CLI:** `orc skills` / `orc mcp list|tools|trust` / `orc ext trust` against temp dirs (trust file created, refusal before, success after).

## 10. Quality Scenarios (extends parent §10)

| Quality | Scenario | Target |
|---|---|---|
| Extensibility | write `vault/skills/foo/SKILL.md` while `orc run` is live | indexed within 1 s, no restart (parent scenario, now testable) |
| Extensibility | third-party provider | one extension file calling `registerProvider`; zero kernel changes |
| Security | cloned repo declares MCP servers + extensions | nothing spawns or imports until `orc mcp trust`/`orc ext trust`; referencing plans fail validation |
| Determinism | step's tool surface | frozen in the approved plan (`toolRefs`); schemas fetched at step init only |
| Traceability | "which skill influenced step X?" | `skill_loaded` events with content hash; MCP calls in `tool_call`/`tool_result` |
| Cost/context | 50 indexed skills | index holds frontmatter only (~50–100 tokens each *if* rendered); step context carries only force-loaded bodies; MCP schemas only for declared refs |

## 11. Risks & Mitigations

1. **MCP supply chain** (parent §11 risk 4) — trust store + explicit `orc mcp trust`, spawn-on-demand only, vetting warning on `orc mcp tools`, version-pinned SDK. Server binaries themselves are the user's choice; we gate *whether*, not *what*.
2. **T2 extensions are full-access in-process code** — that is their documented contract (parent §8.3); the trust store keeps repo-declared extensions inert until locally granted; loud warnings on skipped/invalid entries.
3. **Polling rescan is a per-500 ms cost forever** — measured at ~1 ms per tick for 200 skills, mtime-gated parsing bounds the work; if skill counts ever make it measurable, the interval is one config knob away. Choosing polling *avoids* the real fs.watch risks the spike found (permanent recursive blind spot, watcher poisoning) rather than mitigating them.
4. **Hook handlers under at-least-once steps** — observe-only + error containment bounds the blast radius to a duplicate observation; documented.
5. **Frontmatter parser is a YAML subset** — strict-on-write matches the reference validator's strictness; exotic-but-legal YAML a third party ships may be rejected — acceptable (clear error in `orc skills`), full YAML lib only if real skills hit it.
6. **`require.cache` eviction is Node-compat surface over Bun internals** — spike-validated on the pinned Bun; the reload test doubles as a canary on Bun upgrades (same pattern as the M2 DBOS resume canary).

---

*Evidence provenance: 4-agent workflow 2026-07-17 — MCP-SDK-on-Bun spike, fs.watch spike, dynamic-import reload spike (code in session scratchpad), agentskills.io spec research (agentskills.io/specification, skills-ref validator source, client-implementation guide). Parent-spec amendments noted inline in `2026-07-16-orchestrator-design.md`.*
