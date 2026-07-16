# Generic Multi-Agent Orchestrator — Design Specification

**Date:** 2026-07-16
**Status:** Approved design, pre-implementation
**Structure:** arc42-aligned (ISAQB), ADRs in §9

---

## 1. Introduction & Goals

A local-first orchestrator that takes a task, splits it into a recursive tree of subtasks, freezes the split into a human-reviewed plan, and executes that plan across agents from different providers (Anthropic, OpenAI, Google, local/self-hosted) — with full traceability of what every agent did and why.

### 1.1 Core requirements

| # | Requirement |
|---|---|
| R1 | Task in → recursive decomposition into a subtask tree; any node can be split again |
| R2 | Human review gate: plans are reviewed/edited/approved **before** execution; gate policy configurable per depth/cost/type (default: every split gates) |
| R3 | Dispatch subtasks to agents from different providers — configured or routed — including external agent CLIs (Claude Code, codex, pi) and API-level loops (incl. Ollama/vLLM local models) |
| R4 | User-configurable coordination strategies (declarative topologies) |
| R5 | Plugin ecosystem from day one: skills loadable/unloadable/creatable at runtime |
| R6 | Strong per-agent memory separation; shared memory is explicit opt-in |
| R7 | Optional isolation tiers per step: local → git worktree → Docker container |
| R8 | Generic core with strong typed contracts; provider shapes never leak above the seam |
| R9 | Traceability: Claude Code-transcript-style session logs; every agent call recorded (full inputs/outputs); any run replayable and inspectable step by step |
| R10 | Obsidian support from day one: human-readable markdown vault, OKF-compatible |

### 1.2 Quality goals (priority order)

1. **Traceability/Auditability** — the event log is complete; the vault renders it human-readable; replay reproduces state exactly.
2. **Extensibility** — the plugin system is the product; first-party features ship as plugins so third-party ones are peers.
3. **Determinism** — approved plans are frozen data; execution follows them exactly; routing decisions are resolved before approval, never silently at runtime.
4. **Isolation** — memory scopes and workspace sandboxes prevent agents from interfering with each other.
5. **Simplicity of the kernel** — the kernel is policy-free and small; complexity lives in replaceable plugins.

### 1.3 Stakeholders

Single user (developer) now; contracts designed so a small-team/server mode can be added without rewriting the core (multi-user, auth, and remote execution are explicitly out of v1 scope but must not be structurally precluded).

---

## 2. Constraints

- **TypeScript/Node** core (ADR-002); pnpm workspaces monorepo.
- Local-first: state in SQLite + a markdown vault on disk; no server infrastructure required.
- Open protocols at the edges: **MCP** for tools/capability plugins, **SKILL.md (agentskills.io)** for skills, **OKF** for the vault format, **A2A** reserved for future remote-agent interop.
- LLM output is inherently non-deterministic; determinism guarantees apply to plan freezing, routing resolution, execution order, and replay — not to model output (user-confirmed).
- External agent CLIs expose only what they expose; the capability matrix (§8.4) makes gaps explicit rather than papering over them.

---

## 3. Context & Scope

```
                       ┌──────────────────────────────┐
 human (CLI/Obsidian) ─┤                              ├─ Anthropic API / OpenAI /
                       │        ORCHESTRATOR          │  Google / Ollama / vLLM …
 vault on disk ────────┤  (kernel + plugins, local)   ├─ agent CLIs (Claude Code,
                       │                              │  codex, pi) as subprocesses
 MCP servers ──────────┤                              ├─ git worktrees / Docker
                       └──────────────────────────────┘
```

**In scope (v1):** kernel, event log, recursive task tree, plan lifecycle with approval gates, DAG interpreter, two executor adapters (`api-loop`, `claude-code`), T0 skills + T1 MCP client + T2 extensions, worktree isolation, OKF vault projection, CLI (`orc`), replay.

**Out of scope (v1, contracts in place):** Docker isolation tier implementation, web UI, Obsidian Canvas rendering, A2A adapter, WASM plugin substrate, multi-user/server mode, best-option smart routing (plugin slot exists; v1 routes by config).

---

## 4. Solution Strategy

**Minimal policy-free kernel + everything-is-a-plugin** (pi's philosophy applied to orchestration). The kernel: task tree, plan state machine, DAG interpreter over an append-only event log, plugin host with a hook bus. Everything else — planners, coordination strategies, executor adapters, memory backends, vault projector, approval policies, sandbox providers — is a plugin behind a zod-schema'd contract.

Because an approved plan is **data** (a DAG), execution needs no coroutine-replay machinery: a stateless interpreter walks the DAG, and every side effect is an event. Durable execution (retries, queues, gates that survive process death) comes from DBOS Transact behind a port (ADR-004).

Key sources for the design (verified 2026-07): bottega (harness contract, plan gate, signals), pi (plugin tiers, progressive disclosure, tool contract), claude-obsidian (vault substrate, memory-as-directories, single-writer lesson), RecursiveMAS (declarative topologies, slots, bounded rounds — **note:** despite its name it contains no recursive task decomposition; R1 is original design).

---

## 5. Building Block View

### 5.1 Level 1 — packages

```
packages/
├── contracts/    # types + zod schemas ONLY, zero runtime deps. The future-proof surface.
├── kernel/       # task tree, plan state machine, DAG interpreter, event log,
│                 # plugin host, hook bus, single-writer vault gateway
├── cli/          # thin `orc` CLI over the kernel API
plugins/          # first-party plugins — ordinary packages, no special access
├── planner-llm/          # LLM-assisted splitter (propose → validate → version)
├── strategy-presets/     # sequential, star-hub, deliberation, implement-review
├── executor-api-loop/    # orchestrator-owned agent loop on Vercel AI SDK
├── executor-claude-code/ # Claude Code CLI adapter
├── memory-vault/         # scoped MemoryStore over vault directories
├── vault-projector/      # event log → OKF markdown projection + plan-edit parser
├── sandbox-worktree/     # git worktree per step
└── mcp-client/           # T1 plugin host: spawn/kill MCP servers, deferred schemas
```

### 5.2 Level 2 — contracts (`packages/contracts`)

All contracts are zod schemas; types are inferred. This package is the API of the ecosystem.

- **TaskNode** `{id, parentId, type, title, spec, status, zone: string[], budget, depth}` — the recursive tree. Statuses: `draft | awaiting_approval | approved | running | blocked | done | failed | cancelled`.
- **Plan** `{taskId, version, steps: PlanStep[], edges: TypedEdge[], strategyRef, costEstimate, approvedBy?, frozenAt?}` — versioned, immutable once approved. **PlanStep** `{id, role, executorRef, modelRef (pre-resolved), skillRefs (force-loaded), isolation: 'local'|'worktree'|'docker', zone, maxIterations, slots}`.
- **CoordinationStrategy** (declarative data) `{roles, edges: TypedEdge[], feedbackEdge?, maxRounds}` — RecursiveMAS-style topology. **TypedEdge** carries a payload schema, validated fail-fast at plan-load time. Upstream output enters downstream prompts only at named **slots**.
- **AgentExecutor** `{id, getCapabilities(): CapabilityMatrix, startTurn, resume, abort, loadTranscript}` — returns an async stream of **UnifiedEvent** (discriminated union: `text | tool_call | tool_result | usage | signal | error | done`, each with `raw` passthrough). Capability matrix has mandatory guards — calling an unsupported capability is a typed error, not a runtime surprise.
- **ModelProvider** — Layer 1: a Vercel AI SDK `LanguageModel` plus registry metadata `{id, providerKind, baseUrl?, costs, contextWindow}`.
- **MemoryStore** `{scope, read, write, index, summary}` — scope = `private(runId) | shared(name)`; shared writes go through the kernel gateway.
- **SkillManifest** — SKILL.md frontmatter (agentskills.io) + validation status.
- **ExtensionManifest** — T2: `{id, hooks, registrations, trust: 'project'|'user'}` with `session_start/session_shutdown` lifecycle.
- **SandboxProvider** `{tier, acquire(step) → Workspace, release}`.
- **ApprovalPolicy** — `{default: 'manual'|'auto', rules: [{when: expr(depth, estCost, type), then}]}` evaluated deterministically.
- **ExecutionPort** — the seam in front of DBOS: `{runStep, waitForSignal, enqueue, sleep}` (ADR-004 hedge).
- **Event** — see §8.1.
- **Signal** — out-of-band typed completion flags, scoped by per-run token (ADR-008).

### 5.3 Kernel components

- **PlanLifecycle** — the state machine; all transitions transactional; approval gates are durable waits.
- **DagInterpreter** — stateless; walks the frozen plan; emits events; respects deps, iteration caps, depth/budget caps.
- **PluginHost** — T0 file watcher + index, T1 MCP process manager, T2 jiti loader with trust gate; hook bus at every seam (`plan_proposed`, `step_starting`, `agent_event`, `step_completed`, …).
- **VaultGateway** — the **single writer** for all shared vault files; agents never write shared files directly (claude-obsidian corruption lesson). Agents may write freely only inside their private scope/zone.

---

## 6. Runtime View

### 6.1 Main flow (v1 success scenario)

1. `orc new "task…"` → `task_created`; planner plugin proposes a split → `plan_proposed` (LLM-assisted; output validated against Plan schema, normalized, versioned).
2. Vault projector renders `tasks/<id>/plan-v1.md`; task → `awaiting_approval` (durable wait).
3. Human reviews: `orc review` in terminal, or edits the plan markdown in Obsidian. Edits are parsed, schema-validated → `plan_edited` (v2…). `orc approve` (or frontmatter flip) → `plan_approved`; plan frozen.
4. DagInterpreter runs ready steps concurrently (zones are disjoint by construction). Each step: acquire sandbox → assemble context (three-tier read: hot summary → index → full docs; force-load `skillRefs`) → executor adapter runs the turn → every `UnifiedEvent` appended as an event → typed signal ends the step.
5. A step may propose a **child split** (recursion): creates child TaskNodes + child plan → ApprovalPolicy decides gate vs auto → same lifecycle, `depth+1`, budget inherited.
6. Results aggregate per the strategy topology; task → `done`; vault `log.md` and `sessions/<step>.md` are complete; `orc replay <task>` re-interprets the event log.

### 6.2 Failure runtime

Typed classification on every failure event: `provider_error` (transient → DBOS retry w/ backoff) · `agent_error` (counts against `maxIterations`, then step → `blocked`, transcript linked in vault; human retries / reassigns provider / edits plan → new version → re-gate) · `validation_error` (plugin/plan rejected before execution) · `budget_exceeded` (subtree parks) · `human_abort`. Kernel crash: restart → replay event log → orphan sweep re-parks `running` steps. A harness crash is never billed as an agent iteration.

---

## 7. Deployment View

Single machine, `npm install -g` (or pnpm) delivers `orc`. State: one SQLite file + one vault directory per project (`.orc/state.db`, `vault/`). Long-running execution happens in a foreground `orc run` process (daemon mode later); durable waits mean the process can exit and resume at gates. Local models via the user's Ollama/vLLM endpoint. Small-team path (later): the kernel API is already process-internal RPC-shaped; a server wrapper + auth is additive.

---

## 8. Cross-cutting Concepts

### 8.1 Event sourcing & traceability (R9)

Append-only `events` table: `{seq, taskId, stepId?, runToken?, kind, payload, usage?, ts}`. Kinds: `task_created, plan_proposed, plan_edited, plan_approved, step_started, agent_call, tool_call, tool_result, signal_received, step_completed, step_failed, memory_written, skill_loaded, …`. `agent_call` records **full inputs and outputs**. Normalized **usage** `{inputTokens, outputTokens, costUSD?}` on every provider interaction (providers report inconsistently; the adapter normalizes best-effort and flags estimates). Replay = re-interpret the log; golden-replay tests enforce identity.

### 8.2 Vault (R10) — OKF-compatible projection

Truth = SQLite; vault = continuously rendered **OKF bundle** (markdown + YAML frontmatter, required `type`, path = identity, markdown links = graph, `index.md` progressive disclosure, `log.md` change history) — Obsidian-ready day one.

```
vault/
├── index.md
├── tasks/<task-id>/
│   ├── index.md            # type: task
│   ├── plan-v<N>.md        # type: plan (editable during awaiting_approval)
│   ├── log.md              # type: log — append-only, newest-first
│   └── sessions/<step>.md  # type: session — rendered transcript: actions, tools, reasoning
├── memory/shared/… · memory/agents/<role>/…
└── skills/                 # SKILL.md files (T0), hot-loaded via watcher
```

Bidirectional edit surface is **only** the plan file during `awaiting_approval` (parsed → validated → new version) and skill files (validated before activation). Everything else is projection-only; hand edits there are detected and flagged, not silently absorbed.

### 8.3 Plugins (R5)

| Tier | Substrate | Load/unload | Trust |
|---|---|---|---|
| T0 skills | SKILL.md markdown in vault | file watch; progressive disclosure (name+description in index; body on demand); unload = deindex | sandbox-safe by construction; agent-authored skills strictly validated before activation |
| T1 capabilities | MCP servers over stdio | spawn = load, kill = unload; `tools/listChanged` | manifest permission gate; deferred schema loading (never preload; ~300-500 tokens/tool); vetting warning surface |
| T2 extensions | in-process TS via jiti | lifecycle hooks; live registration; cache-busted reload (no true ESM unload — accepted) | explicit project/user trust gate; documented as full-access |

Deterministic steps **force-load** `skillRefs` — never rely on the model electing to read a skill. WASM (Extism/Wassette) deferred; it slots in behind the MCP boundary later with zero API change.

### 8.4 Provider seam (R3, R8)

Two layers. **Layer 1**: Vercel AI SDK, direct `@ai-sdk/*` packages (not the Gateway default); local models via OpenAI-compatible `baseUrl`. **Layer 2**: `AgentExecutor` (§5.2) for "run this subtask turn to completion" — where whole agent runtimes plug in. Provider/SDK shapes live below the seam; `raw` passthrough exists for debugging, never for routing. Routing = pure function of config + task metadata, resolved into the plan pre-approval; "best-option" routing is a future plugin whose output is still frozen at approval.

### 8.5 Memory (R6)

Separation is directory + scope, not architecture: private scope per run (vault folder + context assembly), shared scopes explicit and plan-visible. Single-writer gateway for shared files. Three-tier read discipline for context cost.

### 8.6 Isolation & zones (R7)

Per-step tier: `local → worktree (default for code) → docker (v1.x)`. Splitter assigns sibling steps **disjoint zones** (path sets); the gateway enforces them. MCP servers containerize under the same Docker option.

### 8.7 Security & trust

Per-run scoped signal tokens (an agent cannot flip another run's flags). MCP permission manifests + user consent on first load. T2 extensions install only from explicit trust. Agent-generated artifacts (skills, plans) validated before activation. Secrets (API keys) via env/keychain, never in vault or event payloads (redaction at the adapter seam).

---

## 9. Architecture Decisions (ADRs)

**ADR-001 — Own thin core; no orchestration framework.** No surveyed framework (LangGraph, CrewAI, AutoGen/MS-AF, OpenAI Agents SDK, Claude Agent SDK, Mastra) provides pre-execution plan approval, runtime-loadable skills, or opt-in-only shared memory; the fight-the-framework tax exceeds the adapter tax. Open protocols at the edges instead (MCP, SKILL.md, OKF, A2A-later).

**ADR-002 — TypeScript/Node.** Scored 71 vs Python 64 / Go 60 / Rust 55 on plugin mechanics, SDK availability, MCP maturity, contracts, UI story. Only language where core, hot-loadable plugins (jiti, pi's proven model), reference MCP SDK, all provider SDKs, zod→JSON-schema contracts, and future UI are one language. Bottega and pi mechanics port near-verbatim. Weakness (no true ESM unload) is moot: subprocess-per-agent gives real unload where it matters.

**ADR-003 — Two-layer provider seam.** Layer 1 Vercel AI SDK (formal provider spec; local models ≈ free via `baseUrl`); Layer 2 our own bottega-shaped `AgentExecutor`. One layer can't serve both "call a model" and "run Claude Code to completion". OpenRouter = one provider, not an abstraction. LiteLLM Proxy noted as escape hatch for containerized polyglot runners.

**ADR-004 — DBOS Transact behind `ExecutionPort`; canonical state in our own SQLite schema.** Only durable-execution option shaped like a local-first tool (MIT, in-process library, SQLite). Provides retries/backoff, queues, concurrency limits, durable gate-waits. Rejected: Temporal (server cluster; dev-only single binary), Restate (BSL + extra process), Inngest (SSPL + inverted shape). Hedge: plan-is-data means a ~1-2 KLoC event-log fallback stays realistic; the port keeps DBOS swappable.

**ADR-005 — Three-tier plugin system** (SKILL.md / MCP / jiti extensions). A bespoke subprocess-RPC protocol is strictly dominated by MCP (same mechanism, spec + SDKs + registry + universal client support already paid for). Skills as plain markdown cover the majority of "plugins" with zero loading machinery.

**ADR-006 — Vault = OKF-compatible projection; SQLite canonical.** Obsidian support from day one (user requirement) without inheriting plain-file concurrency failure modes (claude-obsidian's corruption history). OKF (Google, 2026-06) matches our shape natively: markdown + frontmatter `type`, path-identity, link graph, `index.md`/`log.md` conventions. Bidirectional editing limited to plan-under-review and skills.

**ADR-007 — Coordination strategies as declarative data** (roles + typed edges + slots + bounded rounds; from RecursiveMAS). Presets as first-party plugins; imperative strategies possible as T2 extensions (escape hatch). Fail-fast edge validation at plan load.

**ADR-008 — Out-of-band typed completion signals** (from bottega), hardened with per-run scoped tokens. The orchestrator never parses model prose for control flow. Transport: a native tool exposed by the `api-loop` executor; a small `orc signal` helper CLI on PATH for external agent CLIs — both emit the same typed `Signal` event.

**ADR-009 — Configurable approval policy; default gates every split.** Deterministically evaluated rules over `{depth, estCost, type}` may auto-approve. Recursion is therefore safe-by-default and cheap-to-relax.

**ADR-010 — Recursion is original design.** RecursiveMAS (the naming inspiration) contains no recursive decomposition — it's a latent-vector research harness requiring white-box models. We take its vocabulary (topologies, slots, bounded rounds), not its mechanism. `parentId` + per-node plans + gate policy is our own construction.

---

## 10. Quality Requirements (scenarios)

| Quality | Scenario | Target |
|---|---|---|
| Traceability | User asks "why did step X do Y?" | `sessions/<step>.md` shows the action, tool calls, and inputs; `orc replay` reproduces state from the log alone |
| Determinism | Re-run interpreter over an approved plan's log | Identical state (golden-replay test suite) |
| Extensibility | Add a new provider adapter | Zero kernel changes; passes the shared contract test suite |
| Extensibility | Create a skill at runtime | Write SKILL.md into `vault/skills/` → indexed within 1s, no restart |
| Isolation | Two sibling steps run concurrently | Disjoint zones enforced; no shared-file write bypasses the gateway |
| Robustness | Kill -9 during execution | Restart resumes at last event; gates still held; no double-billed iterations |
| Interop | Open vault in Obsidian / OKF consumer | Renders as graph + notes with valid frontmatter, no plugin required |

---

## 11. Risks & Mitigations

1. **Deterministic splitting of arbitrary tasks is impossible** — accepted (user-confirmed): LLM proposes, validator normalizes, human gates, plan freezes. Templates give full determinism for structured task types later.
2. **DBOS dependency risk** — ExecutionPort + own canonical schema keep the hand-rolled fallback at ~1-2 KLoC.
3. **Vault scale/concurrency** — single-writer gateway is a day-one invariant, not a retrofit; projection (not truth) keeps files disposable/re-renderable.
4. **MCP supply chain** (43% of audited public servers had vulns) — permission manifests, consent gate, deferred schema loading, version pinning.
5. **Capability gaps across agent CLIs** — capability matrix with mandatory guards; gaps surface at plan validation, not mid-run.
6. **Cost blowout in recursion** — budget caps inherited down the tree; depth cap; bounded feedback rounds; normalized usage accounting on every event.
7. **OKF is v0.1** — we depend only on its trivially-stable subset (frontmatter `type`, path identity, md links); worst case the vault is "just" clean markdown.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| Kernel | Policy-free core: task tree, plan lifecycle, DAG interpreter, event log, plugin host |
| Plan | Versioned immutable split of a task; the only thing the interpreter executes |
| Gate | Durable `awaiting_approval` wait; resolved by human action or ApprovalPolicy rule |
| Zone | Disjoint file-path set owned by a step |
| Slot | Named injection point where upstream output enters a downstream prompt |
| Signal | Typed out-of-band completion flag, scoped by run token |
| T0/T1/T2 | Plugin tiers: skills (markdown) / MCP servers / in-process extensions |
| Vault | OKF-compatible markdown projection of the event log; Obsidian-ready |
| OKF | Open Knowledge Format (Google, 2026): markdown+frontmatter knowledge bundles |
| ExecutionPort | Seam isolating DBOS Transact from the kernel |

---

*Research provenance: 10-agent research workflow, 2026-07-16 — inspiration repos (RecursiveMAS, bottega, claude-obsidian, pi) and landscape scans (frameworks, provider layers, languages, durable execution, plugin substrates). Full brief in session scratchpad.*
