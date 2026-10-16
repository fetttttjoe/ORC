# How MCP works in this repo

The repo does MCP in **both directions**. `orc mcp serve` (an MCP client such as Claude Code connects to it over stdio) exposes the orchestrator itself as a stdio MCP server with up to **23 tools** — everything reads/writes one append-only Postgres event log. Separately, `plugins/mcp-client` lets agents running *inside* plans call out to external MCP servers declared in `.orc/config.json`.

## Direction 1: `orc` as an MCP server ("door #2")

A Claude Code session reaches this server through the plugin in `plugin/`: its manifest declares the
server inline, and the wrapper `plugin/bin/orc-mcp` changes into the session's project directory
(`CLAUDE_PROJECT_DIR`) before running `orc mcp serve`, which is what binds the server to the right
project. The same plugin's `SessionStart` hook prints `orc brief` into the session, and its three
skills (`/orc:request`, `/orc:adr`, `/orc:workspace`) teach the tools listed here. Any other MCP
client registers `orc mcp serve` as a plain stdio server.

```mermaid
flowchart TB
    CC["Claude Code / any MCP client<br/>connects over stdio → bun cli mcp serve"]
    CC <-->|"JSON-RPC over stdio<br/>(stdout hardened twice: console → stderr in bin.ts,<br/>process.stdout.write → stderr in mcp-serve.ts)"| SRV

    subgraph serve["orc mcp serve — packages/cli/src/mcp-serve.ts"]
        SRV["MCP Server 'orc'<br/>capabilities: tools only"]
        SRV --> REG["buildServeTools()"]
        REG --> COP["copilot tools<br/>ui-core buildCopilotTools<br/>6 read + 11 mutate"]
        REG --> MEM["memory read slice<br/>MEMORY_READ_TOOLS: 5 tools"]
        REG --> APPR["approve<br/>--autonomy gated: refuses<br/>--autonomy full: approvedBy=mcp"]
    end

    COP -->|reads| SESS["createProjectSessions<br/>fold(events) → State + Graph,<br/>live refold on every new event"]
    COP -.->|"mutations (null → server is read-only)"| ACT["OrcActions"]
    APPR -.-> ACT
    ACT --> KERNEL["Kernel — appends events,<br/>DBOS boots lazily on run/retry/cancel"]

    SESS --> LOG[("Postgres event log<br/>append-only, pg LISTEN/NOTIFY")]
    KERNEL --> LOG

    MEM -->|search/read/neighbors| SUR[("SurrealDB projection<br/>note / meta / link tables")]
    LOG -->|"async memory projector"| SUR
    LOG -->|projector| VAULT["vault/ — markdown note files + index.md"]
```

How a call flows: the client sends `tools/call` over stdio → the handler looks the tool up in a `Map` → the tool either reads a **fold of the event log** (via `createProjectSessions`, which replays all events into State + Graph and refolds live) or appends new events through `OrcActions`/the kernel. Nothing reads domain tables directly — the event log is the single source of truth; SurrealDB and the vault markdown are downstream projections.

## The tools it exposes (23 max)

| Group | Tool | What it does |
|---|---|---|
| **Read** (always) | `available_models` | Every usable model ref, fetched live from the providers — call it before choosing one |
| | `project_status` | Every task + status, the workspaces (checkouts) they are worked in with each one's health, graph node counts, memory read-model health |
| | `task_plan` | Plan versions, steps, which version is approved |
| | `task_transcript` | Last 30 items of a task's agent conversation |
| | `plan_notes` | Grounded decomposition notes (subplans, uncertainty, links) |
| | `recent_activity` | Latest project events, one line each |
| **Memory read** (always; error-stubs if memory is down) | `memory_search` | Hybrid search over knowledge notes (vector ⊕ keyword, fused by reciprocal rank; degrades to keyword-only with no embedder configured) |
| | `memory_read` | One full note by id, token-budgeted |
| | `memory_neighbors` | Typed-link graph walk from a seed note, ranked by weight × confidence × depth-decay |
| | `memory_topics` | Derived topics over project knowledge; list them, or pass a topicKey to read its claims |
| | `memory_recheck` | The authoritative corpus drift verdict: exact counts plus the drifted/unknown note lists — the heal-sweep worklist |
| **Mutate** (only when actions ≠ null) | `new_request` | Create a task; `grounded` triggers repo analysis + decomposition; `workspaceId` picks the checkout, defaulting to the one this server runs in |
| | `propose` | Propose a single-step plan for a draft task |
| | `run` | Start the approved plan in the task's workspace, or in an explicit `cwd` |
| | `reply` | Answer a task's open feedback question |
| | `retry` / `cancel` | Re-run a blocked task's incomplete steps (refused when a verdict blocked it) / terminally cancel |
| | `annotate` / `revise` | Feedback on one plan-note / wake the plan agent to revise scoped notes |
| | `workspace_list` | The project's active workspaces, each with its health (state `dangling`/`waiting`/`active`/`idle`/`merged`, last activity, task counts, notes still pending a merge), attention-first — read-only, but served only with the mutating door |
| | `workspace_new` | A git worktree + branch for ONE request under `.orc/worktrees`, recorded as a workspace, with the request as its first task |
| | `record_decision` | Record an ADR-shaped decision note (status accepted unless proposed; `supersedes` flips the old one); attributed `mcp` |
| **Gate** | `approve` | The one tool the two doors differ on — see below |

Key behaviors:

- **Autonomy is launch-time, never the agent's choice.** Under the default `--autonomy gated`, `approve` is still *listed* but always refuses at call time, pointing to the orc UI or `orc approve <taskId>`. Only `--autonomy full` approves, and every approval is attributed `approvedBy: mcp` in the event log. There is deliberately no approve tool in the copilot set itself — the human gate is structural.
- **Read-only degradation is one mechanism, three triggers**: no port factory (CLI), and on the UI door, out-of-project or foreign-project chats — all just pass `actions: null` into the same `buildCopilotTools`.
- **`available_models` is served on the MCP door too** — `mcp-serve.ts` wires `listModels` to the projected model catalog (the latest `models_discovered` event per provider), so an MCP client can discover a valid `modelRef` before `propose`/grounded `new_request`.
- **Memory degrades, never blocks**: if SurrealDB is unreachable, the 5 read tools stay listed but each call returns `memory unavailable: <reason>` instead of the tools silently vanishing.
- `memory_write` exists in the plugin but is not served — authoring stays with the agents running inside plans. `record_decision` is the single authoring tool this door serves; the test pins that exact set.

## Direction 2: orc as an MCP client (tools *for* agents)

```mermaid
flowchart LR
    subgraph plan["Running plan step"]
        AGENT["agent (executor-api-loop)"]
        AGENT -->|"calls mcp__serverId__toolName"| XT["ctx.extraTools"]
    end

    XT --> HUB["createMcpHub — plugins/mcp-client<br/>stdio only, lazy spawn per server,<br/>respawn on transport death"]

    CFG[".orc/config.json → mcpServers<br/>{command, args, env}<br/>$VARS resolved from orc's env at spawn"] --> HUB
    TRUST[".orc/trust.json<br/>sha256 fingerprint of command+args+env decl,<br/>written by 'orc mcp trust id'"] -->|"trust re-checked at every spawn"| HUB

    STEP["plan step declares toolRefs:<br/>'server-id/tool-name'"] -->|"validated at plan approval:<br/>undeclared or untrusted → rejected"| XT

    HUB --> S1["external MCP server A"]
    HUB --> S2["external MCP server B"]
```

Plan steps declare `toolRefs` like `"server-id/tool-name"`; plan validation rejects undeclared or untrusted servers **at approval time**, and at step start the hub resolves them into the agent's tool set under mangled names (`mcp__<server>__<tool>`). Trust is a fingerprint granted once with `orc mcp trust <id>` and re-verified on every spawn; secrets go in as `$VAR` references so they never land in committed config, and child servers never inherit the full env. The plugin also ships two stdio servers of its own: `web-mcp.ts` (Wikipedia `search` + SSRF-guarded `fetch`, used in simulations) and `fixture-server.ts` (`echo`/`fail`/`grow` test fixtures).

## Tool count

The server Claude Code connects to: **11 tools read-only, 23 with actions wired** (6 copilot read + 11 mutate + 5 memory read + `approve`).
