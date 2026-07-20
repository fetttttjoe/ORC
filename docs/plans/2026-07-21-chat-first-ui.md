# Plan: chat-first UX — project chats, copilot with action power, diagrams, graph dock

Redesign of the web UI around a conversation: **each chat is a project** (renameable,
ChatGPT-style list), the center stage is the project's conversation — user ↔ copilot messages
interleaved with structured system cards (plan diagrams, todo waves, questions, artifacts) —
and the live graph docks right, expandable to near-fullscreen with only a minimal nav strip.
The copilot is a real agent (Vercel AI SDK `ai@7`, already in-repo) with **action power**: its
tools are the same `OrcActions` + read APIs the UI uses, so it can create, propose, approve,
run, reply, refine — every tool call rendered visibly in the chat.

Grounded facts (verified):
- `ai@7` `streamText` supports `tools` + `stopWhen: stepCountIs(n)` multi-step loops.
- `@orc/vault-projector` exports `mermaidDag(plan, steps)` and the `mermaidLabel` escaper —
  server-side mermaid text generation exists; agent-written titles are already
  injection-escaped there.
- `packages/cli/src/runtime.ts` `seedRegistries(config)` returns the provider map — the CLI
  can hand the graph server a `resolveModel(ref)`; the anthropic provider brings prompt
  caching + OAuth for copilot calls automatically.
- Current UI (screenshot-confirmed) keeps: primitives (`ui/`), SSE envelope, all `/api/*`
  endpoints, `OrcActions`, renderer. The redesign replaces the shell, not the organs.

Design rules:
- The copilot NEVER bypasses the action layer: its mutating tools call `OrcActions` — same
  audit trail, same events, same CSRF-guarded server process.
- Every copilot tool call renders as a card (name + input + result) — no invisible actions.
- Mermaid renders client-side with `securityLevel: 'strict'`; all diagram text is generated
  server-side from typed data through `mermaidLabel` — never from raw agent prose.
- Conversation persistence v1 is `localStorage` per project (the copilot re-grounds itself
  from live state each message, so history is presentational). `ponytail:` move transcripts
  into the event log when they become load-bearing.
- Project names: the cwd project keeps its config name; renames write a `ui-project-name`
  memory note (scope `project`) — event-sourced, rebuild-safe, no schema changes. Names of
  never-opened projects show as short ids. `ponytail:` name resolution opens the project's
  session lazily; a dedicated name registry event if project counts grow.
- Cost: copilot calls are explicit (send button), capped (`stopWhen: stepCountIs(8)`), priced
  through the existing usage pipeline, and the reply footer shows tokens + cost per exchange.

Layout spec:
```
┌──┬──────────────────────────────────────┬─────────────────────┐
│nav│  PROJECT CHAT (center)              │  GRAPH DOCK         │
│▪ │  ┌ system card: request created ┐    │  (sigma, live)      │
│▪ │  ┌ copilot: here's the plan ────┐    │                     │
│▪ │  │  [mermaid diagram]           │    │  click node →       │
│+ │  │  [todo waves w/ parallel]    │    │  inspector overlay  │
│  │  │  [approve] [revise]          │    │                     │
│  │  └──────────────────────────────┘    │  ⤢ graph-max mode:  │
│  │  ┌ user: looks good, approve ───┐    │  dock → fullscreen, │
│  │  [ input row ........... send ]      │  chat → nav strip   │
└──┴──────────────────────────────────────┴─────────────────────┘
```
Three view modes, hash-persisted (`&view=chat|split|graph`): chat-focus (dock collapsed),
split (default), graph-max (nav strip + graph only — the "almost fullscreen" ask).

---

### Phase 1 — copilot backend (agent over OrcActions, streamed)

1. **Step 1.1 — RESEARCH GATE: streaming wire + mock model**
   Read `plugins/executor-api-loop/src/loop.test.ts`'s `scriptModel` fixture and
   `node_modules/ai/dist` for `streamText().textStream` / `fullStream` part shapes (text delta,
   tool-call, tool-result part types). Decide: forward `fullStream` parts 1:1 as SSE messages
   (`data: {type, ...}`) — the client renders text deltas and tool cards from the same stream.
   If `fullStream` part names differ from expectation, adapt the SSE mapping — the client
   contract below stays.

2. **Step 1.2 — copilot core in ui-core**
   - **Files:** `packages/ui-core/src/copilot.ts`
     - `buildCopilotTools(deps: { sessions: ProjectSessions; actions: OrcActions | null; projectId: string })`
       → `ToolSet` (ai `tool()` + zod), read tools always: `project_status` (tasks + statuses
       + your-move summary), `task_plan`, `task_transcript`, `plan_notes`, `graph_summary`
       (counts + recent notes); mutating tools only when `actions` present: `new_request`,
       `propose`, `approve`, `run`, `reply`, `retry`, `cancel`, `annotate`, `revise` — each a
       thin zod-typed wrapper over the `OrcActions` method.
     - `copilotSystemPrompt(projectName)` — the guide persona: helps formulate requests,
       explains decompositions in plain language, proposes next moves, asks before destructive
       actions (cancel), never invents task ids (must read state first).
   - **Files:** `packages/ui-core/src/copilot.test.ts` — with a scripted model (executor
     fixture style): a "create a request" conversation calls the `new_request` tool with the
     stub actions and the tool result flows back; read tools work without actions; mutating
     tools absent when `actions` is null.
   - **Verify:** `bun test packages/ui-core` green.

3. **Step 1.3 — endpoint + model resolution**
   - **Files:** `packages/graph-ui/src/server.ts` — `POST /api/copilot` (token-guarded like
     actions): body `{ projectId, modelRef?, messages: [{role, content}] }` (zod), requires
     `opts.copilot` — else 501. Runs `streamText({ model: resolveModel(ref), system, messages,
     tools, stopWhen: stepCountIs(8) })`, forwards the stream as SSE, final message carries
     usage `{inputTokens, outputTokens, costUSD?}` priced via the provider cost table.
   - **Files:** `packages/cli/src/main.ts` graph command — pass
     `copilot: { resolveModel: ref => the seedRegistries provider lookup used by buildRuntime, defaultModelRef: 'anthropic/claude-haiku-4-5' }`
     (extract the existing `provider/model` ref-splitting helper if one exists in runtime).
   - **Files:** server test — stub `resolveModel` returning the scripted model; POST yields
     SSE containing the scripted text and a tool-call part; 403 without token; 501 without copilot.
   - **Verify:** `bun test packages/graph-ui` green.

### Phase 2 — shell v2: nav strip, project chats, graph dock, view modes

4. **Step 4.1 — layout + view modes**
   - **Files:** `page/app.ts` + `ui/theme.css` — new shell: `nav | chat | dock`. Nav strip
     (56px collapsed / 240px expanded): project chats (dot + name + unread badge), `+ new
     chat`, view-mode toggle. `&view=` in the hash via `nav.ts` (`Selection` gains
     `view: 'chat' | 'split' | 'graph'`); graph-max hides chat, expands dock to `1fr`,
     nav collapses. The old right-panel tabs become the **inspector**: an overlay panel inside
     the dock, opened by node click (Detail/Log content reuse as-is; Request/Chat tabs retire —
     their content now lives in the conversation).
   - **Verify:** manual — three modes switch and persist in the hash; node click opens the
     inspector overlay; existing deep links still resolve.

5. **Step 4.2 — project chat management**
   - **Files:** `packages/ui-core/src/actions.ts` + `packages/cli/src/actions.ts`:
     `renameProject(name)` (writes the `ui-project-name` note via the memory store) and
     `newProject(dir, name)` (wraps kernel `initializeProject`; validates the directory
     exists). Server routes + zod. `sessions.projects()` resolves names: cwd config name →
     `ui-project-name` note (for open sessions) → short id.
   - **Files:** page — nav strip: rename inline (pencil → input), `+ new chat` dialog (name +
     directory, defaults to `session.defaultCwd`'s parent).
   - **Verify:** rename survives reload; new project appears and opens; `orc graph` from that
     directory shows the same name (note-sourced).

### Phase 3 — the conversation: messages, cards, diagrams, todos

6. **Step 6.1 — chat view + copilot client**
   - **Files:** `page/conversation.ts` — the center view: message list (user right-aligned,
     copilot left, system cards full-width), input row (textarea, send, model badge),
     streaming render from the `/api/copilot` SSE (text deltas append; tool parts become
     cards: `⚙ approve {taskId} → {version: 1}`), usage footer per exchange. History in
     `localStorage[chat:<projectId>]`, sent back as `messages` context (last N=20).
   - **Verify:** manual — ask the copilot "what's the state of this project?" (read tools),
     then "create a request that does X" (new_request tool card appears, task lands in the
     graph live).

7. **Step 6.2 — system cards from the event stream**
   - **Files:** `page/conversation.ts` + `page/cards.ts` — the SSE envelope already delivers
     every event summary: render conversation-worthy ones as system cards inline (task
     created, plan proposed, approved, step started/completed/failed, question asked → inline
     reply box, artifact produced, notes written). Filter noise (`operation_*`, `agent_call`)
     into the inspector's Log only.
   - **Verify:** manual — run a task: the conversation narrates it live without any copilot
     tokens spent.

8. **Step 6.3 — diagrams + todo waves**
   - **Files:** `packages/ui-core/src/diagram.ts` — `planMermaid(plan, stepStates)` (reuse
     `mermaidDag`/`mermaidLabel` from `@orc/vault-projector`) and
     `decompositionMermaid(planNotes)` (`decomposes_into` tree + `depends_on` edges);
     `todoWaves(plan, stepStates)` — Kahn layering: `[{ wave: 1, parallel: true, steps: [{id,
     title, status}] }]`. Server: include diagram + waves in the plan-proposed system card
     payload (new `GET /api/plan-visual?project&task` or embed in `/api/plans` — decide at
     implementation, prefer embedding).
   - **Files:** page — `mermaid` npm dep (bundled by Bun; RESEARCH GATE: confirm mermaid ESM
     initializes under the bundler, else fall back to its prebundled `mermaid.min.mjs`);
     `cards.ts` renders the diagram SVG + a todo checklist card (waves grouped, `parallel`
     badge, live status checkmarks re-rendered from SSE).
   - **Verify:** unit: `todoWaves` on a diamond-shaped plan yields 3 waves with the middle two
     parallel; manual: plan-proposed card shows the diagram; checkboxes tick as steps complete.

8b. **Step 6.4 — intuitive plan editing (the PlanEditor)**
   - **Editing rules (from the durability design, surfaced in the UI):** template plans are
     editable while `draft`/`awaiting_approval` — approved plans are frozen data (read-only
     view + "changes go through a new version"); grounded decompositions stay agent-mediated
     (the editor shows annotate/revise controls instead of direct field edits, keeping the
     approval hash honest).
   - **Library decision (researched, corrected):** **`@joint/core` 4.3** (+
     `@joint/layout-directed-graph` for dagre auto-layout). Actively maintained (2026-07),
     zero runtime deps, vanilla-first, MPL-2.0 (fine as an unmodified dependency). Rejected:
     drawflow (dormant), rete (React/Vue/Svelte render plugins only), litegraph
     (canvas-hostile to forms), `@xyflow/system` (lower-level — more build). Note: the shiny
     jointjs.com demos are the paid JointJS+ widgets — we use core only and bring our own
     inspector from the existing `ui/` primitives.
   - **Editor pattern: canvas for structure, inspector for fields.** The JointJS paper renders
     steps as nodes (title + role/model badges + status tint) with `dependsOn` as directed
     links; drag to rearrange, draw a link = add a dependency (cycle-guard validates on
     connect — reject with a toast), delete link/node via selection + keyboard or a small ×
     tool; add-step button drops a new node. Clicking a node opens the **step inspector**
     (our Card form: title, instructions textarea, model, role, maxIterations, skills).
     Auto-layout button = directed-graph layout (left→right). Mermaid stays for read-only
     chat cards; JointJS lives only inside the editor.
   - **Files:** `packages/ui-core/src/actions.ts` + `packages/cli/src/actions.ts`:
     `edit(taskId, draft: PlanDraft)` → `kernel.editPlan` (new version, same as `orc edit`).
     Server route: parse the body with the `PlanDraft` contract schema itself (it IS zod — no
     hand-rolled duplicate).
   - **Files:** `packages/graph-ui/page/plan-editor.ts` — `PlanEditor(draft, { onSave, readOnly })`:
     builds the JointJS graph from the draft (node per step, link per dependsOn), wires
     paper events (link:connect → cycle-guard via the topo walk, element:pointerclick →
     inspector, blank:pointerdblclick → add step), syncs canvas ↔ draft object both ways
     (delete cleans dangling dependsOn); **save proposes a new version** (`edit` action) and
     the conversation gets the plan-proposed card; discard restores. `@joint/core` +
     `@joint/layout-directed-graph` added to graph-ui deps (bundled by Bun; RESEARCH GATE at
     implementation: confirm the ESM build initializes under Bun's bundler — core is
     dependency-free so this should be clean).
   - Entry points: the plan card's **edit** button (only when status allows), and the copilot
     can open it ("let me adjust step 2" → tool `open_plan_editor`? no — keep v1 human-only:
     the copilot edits via its own `propose` tool with a full draft; the button is for humans).
   - **Verify:** unit — cycle-guard rejects a→b→a; manual — edit a draft plan, save, v2
     appears with the diagram updating; approved plan shows read-only + revise path; CLI
     `orc plan <id>` shows the web-edited version.

### Phase 4 — polish + docs

9. **Step 9.1** — retire dead code (old tab wiring left unused), README rewrite of the
   `orc graph` bullet (chat-first, copilot, graph dock), full matrix run.

## Verification matrix

| Test | Expected result |
|---|---|
| `bun run typecheck` + `bun test` | clean / green (new: copilot core + endpoint + waves tests) |
| POST /api/copilot without token / without copilot opts | 403 / 501 |
| Copilot: "what's running?" | read-tool cards, correct answer, no mutations |
| Copilot: "create and run a request to do X" | new_request → propose → approve → run tool cards; graph + conversation update live |
| Conversation during a manual `orc run` | system cards narrate; zero copilot tokens |
| Plan card | mermaid diagram renders; todo waves show parallelism; ticks live |
| Rename chat + reload; new chat with directory | name persists (note-sourced); project initializes and opens |
| Plan editor: drag steps, draw a dependsOn link, edit fields in the inspector, save | new version proposed, diagram + todo waves update, CLI sees it; cycle-guard rejects circular links on connect |
| Plan editor auto-layout | dagre left→right layout untangles the DAG |
| Plan editor on an approved plan | read-only; grounded plans route to annotate/revise instead of field edits |
| View modes | chat/split/graph-max switch, hash-persisted; graph-max = dock fullscreen + nav strip |
| Cost footer | per-exchange tokens + cost shown, matches `orc status`-style pricing |

## Files touched

- `packages/ui-core/src/copilot.ts` + test, `diagram.ts` + test, `actions.ts` (rename/newProject), `sessions.ts` (name resolution), `index.ts`
- `packages/cli/src/actions.ts` (rename/newProject impl), `main.ts` (copilot wiring)
- `packages/graph-ui/src/server.ts` + test (`/api/copilot`, project routes), `package.json` (`mermaid`, `ai`)
- `packages/graph-ui/page/`: `app.ts` (shell v2), `nav.ts` (view modes), `conversation.ts` (new), `cards.ts` (new), `plan-editor.ts` (new), `theme.css`; retired: request-tab wiring
- `README.md`

Ready to execute when you say go.
