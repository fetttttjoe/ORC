# Plan: chats, plans, live log, and full interlinking in the graph UI

Builds on the shipped graph UI (`docs/plans/2026-07-20-graph-ui.md`). Adds to the right panel a
tab strip — **Detail · Chat · Plan · Log** — a resizable/maximizable panel for reading, a task
tree in the sidebar, and ONE navigation model where every id anywhere is a clickable link:
graph node ↔ sidebar ↔ detail cross-refs ↔ plan step chips ↔ log rows ↔ chat. Selection lives
in the URL hash, so every view is deep-linkable and refresh-safe.

All new logic lands in `@orc/ui-core` (transport-free, TUI-reusable); the web server gains three
read endpoints and an enriched SSE envelope; the page gains views composed from the existing
`ui/` primitives.

Data reality (no new storage, everything folds from the log):
- **Chat** = `agent_call` (response text + toolCalls), `tool_call`/`tool_result` (paired by
  toolCallId), `feedback_requested`/`provided`, `signal_received` — per task/step.
- **Plan** = `state.plans` (all versions + approvedVersion) — already in the fold.
- **Log** = the event stream itself, summarized one line per event (the `debug-tail.ts`
  rendering, moved into ui-core so web and TUI share it).
- Gap to close: chat/log events diff to empty graph patches, and today both ui-core notify and
  the SSE skip them. The subscriber contract changes to "every event", with the patch possibly
  empty — adapters filter.

Design rules:
- Navigation is one function: `navigate({project?, node?, tab?})` → writes the hash
  (`#p=…&n=…&tab=…`); a `hashchange` listener is the only place that renders selection. Every
  link everywhere calls `navigate` — no component navigates by itself.
- Collapsible tool calls use native `<details>/<summary>` — no JS accordion.
- Note bodies, transcripts, log payloads stay `textContent` — never `innerHTML`.
- `ponytail:` chat view refetches the transcript on relevant events (O(transcript), fine
  locally); switch to incremental append when a transcript gets huge. Log view keeps the last
  500 rows client-side.

Deferred: `OrcActions` (the Chat tab's feedback question card is where the reply box will land),
text-search in log, transcript virtualization, `CosmosRenderer`, TUI adapter (gains
`foldTranscript`/`summarizeEvent` for free from this plan).

---

### Phase 1 — ui-core: transcript, log summaries, plans, richer subscribe

1. **Step 1.1 — `foldTranscript` (pure) + tests**
   - **Why:** the chat view and the future TUI need the same event→conversation fold.
   - **Files:** `packages/ui-core/src/transcript.ts`
     ```ts
     import { EVENT_KIND, type EventRecord } from '@orc/contracts'

     export type TranscriptItem =
       | { kind: 'message'; iteration: number; stepId: string; text: string }
       | { kind: 'tool'; iteration: number; stepId: string; toolName: string; input: unknown; output: unknown; isError: boolean }
       | { kind: 'question'; stepId: string; question: string; answer: string | null }
       | { kind: 'signal'; stepId: string; outcome: string; summary: string }

     // Ordered conversation for a task (optionally one step). Tool calls pair with their
     // results by toolCallId; a dangling call (crash window) renders with output null.
     export function foldTranscript(events: EventRecord[], taskId: string, stepId?: string): TranscriptItem[]
     ```
     Implementation: filter `e.taskId === taskId` (+ stepId when given); walk in seq order:
     - `agent_call` → payload `{iteration, response: {text, toolCalls}}`: push `message` when
       `response.text` non-empty (iteration from payload).
     - `tool_call` → stash `{toolName, input}` by `toolCallId`; `tool_result` → pop stash, push
       `tool` with `{output, isError}`; flush dangling stashes at the end with `output: null`.
     - `feedback_requested` → push `question` (payload `.question`), remember index by topic;
       `feedback_provided` → set `answer` (payload `.text`) on the matching open question.
     - `signal_received` → push `signal` from payload `.signal.outcome/.summary`.
     All payload reads via `.safeParse` against small local zod views (copy the lenient-View
     pattern from `packages/kernel/src/projections.ts`) — a malformed event skips, never throws.
     Check the real payload field names against `packages/contracts/src/events.ts`
     (`PAYLOAD_SCHEMAS`) before coding the views.
   - **Files:** `packages/ui-core/src/transcript.test.ts` — pure fixtures (hand-built
     `EventRecord`s via `eventFixture` from `@orc/contracts/fixtures`): a 2-iteration
     conversation (text → tool pair → question+answer → signal) asserts item order and pairing;
     a dangling tool_call yields `output: null`; a foreign-task event never leaks in.
   - **Verify:** `bun test packages/ui-core/src/transcript.test.ts` green.

2. **Step 1.2 — `summarizeEvent` (the shared one-line log renderer) + tests**
   - **Why:** log view and TUI need one summary function; `debug-tail.ts` already has the
     mapping — move it, don't duplicate it.
   - **Files:** `packages/ui-core/src/summarize.ts` — port `summarize()` +`snip()` from
     `packages/cli/src/debug-tail.ts` verbatim as
     `summarizeEvent(e: EventRecord): { kind: string; line: string; taskId: string | null; stepId: string | null; seq: number; ts: string }`.
     `packages/cli/src/debug-tail.ts` — replace its local `summarize` with an import from
     `@orc/ui-core` (delete the duplicate; cli already depends on ui-core transitively — add
     the explicit dep to `packages/cli/package.json`).
   - **Files:** `packages/ui-core/src/summarize.test.ts` — three cases: `agent_call` line
     contains iteration + tool names; `memory_written` line contains note id; unknown kind
     falls back to snipped payload.
   - **Verify:** `bun test packages/ui-core/src/summarize.test.ts` green; `bunx tsc --noEmit -p packages/cli` clean.

3. **Step 1.3 — sessions API: transcript/plans/log/backlinks + always-notify subscribe**
   - **Why:** adapters need read APIs; the SSE needs every event, not only graph-changing ones.
   - **Files:** `packages/ui-core/src/sessions.ts`
     - `SessionUpdate` gains `summary: ReturnType<typeof summarizeEvent> | null` (null only for
       the synthetic catch-up update from `since()`).
     - The internal log subscription now notifies subscribers on EVERY event:
       `cb({ seq, patch, event: e, summary: summarizeEvent(e) })` — `patch` may be empty;
       adapters filter. (`since()` still returns only the cumulative patch.)
     - New methods on `ProjectSessions`:
       ```ts
       transcript(projectId: string, taskId: string, stepId?: string): Promise<TranscriptItem[]>   // foldTranscript over cached events
       taskPlans(projectId: string, taskId: string): Promise<{ versions: Plan[]; approvedVersion: number | null } | null>
       log(projectId: string, opts?: { taskId?: string; limit?: number }): Promise<Array<ReturnType<typeof summarizeEvent>>> // last N (default 200), task-filtered when asked; memory events (taskId null) are project-wide and always included
       ```
     - `nodeDetail` note branch additionally returns
       `backlinks: Array<{ id: string; scope: string; title: string; kind: string }>` — scan the
       live-notes map for notes whose links target this note (same-scope semantics).
   - **Files:** `packages/ui-core/src/sessions.test.ts` — extend: a `task_status_changed`-only
     append (empty patch) still notifies with `summary.kind`; `transcript` returns the seeded
     message; `log({taskId})` filters; note backlinks appear after a second note links to the
     first.
   - **Files:** `packages/ui-core/src/index.ts` — export `foldTranscript`, `TranscriptItem`,
     `summarizeEvent`.
   - **Verify:** `bun test packages/ui-core` green.

### Phase 2 — web adapter: three endpoints + SSE envelope

4. **Step 2.1 — endpoints and envelope**
   - **Files:** `packages/graph-ui/src/server.ts`
     - `GET /api/transcript?project&task&step?` → `sessions.transcript(...)`
     - `GET /api/plans?project&task` → `sessions.taskPlans(...)` (404 when null)
     - `GET /api/log?project&task?&limit?` → `sessions.log(...)`
     - `/api/stream` messages become an envelope:
       `data: { patch: GraphPatch | null, summary: LogRow | null }` — live updates carry both
       (patch null-ed when empty to keep messages small), the initial catch-up message carries
       `{ patch, summary: null }`. `id:` stays the seq — resume semantics unchanged.
   - **Files:** `packages/graph-ui/src/server.test.ts` — update stream assertions to the
     envelope shape; add: append a `task_status_changed`-style no-graph-change event → a
     message arrives with `patch: null` and a `summary.line`; `/api/transcript` returns the
     seeded items; `/api/log?limit=1` returns exactly one row.
   - **Verify:** `bun test packages/graph-ui` green.

### Phase 3 — page: navigation backbone (router, links, tabs, resizable panel)

5. **Step 3.1 — hash router + `Link` primitive + graph selection highlight**
   - **Files:** `packages/graph-ui/page/nav.ts`
     ```ts
     export interface Selection { project: string; node: string | null; tab: 'detail' | 'chat' | 'plan' | 'log' }
     export function navigate(patch: Partial<Selection>): void   // merge → location.hash = `#p=…&n=…&tab=…` (encodeURIComponent each)
     export function current(): Selection                        // parse location.hash (defaults: tab 'detail')
     export function onChange(cb: (s: Selection) => void): void  // hashchange + initial fire
     ```
   - **Files:** `packages/graph-ui/page/ui/components.ts` — add
     `Link(label: string, onClick: () => void)` → `el('a', { class: 'link', onClick })` styled
     via theme.css (`.link { color: var(--accent); cursor: pointer; text-decoration: none }`,
     underline on hover); add `Tabs(items: Array<{id, label}>, active, onSelect)` →
     `.tabs` strip of `.tab` buttons (theme.css: bottom-border accent on active).
   - **Files:** `packages/graph-ui/page/renderer.ts` — `GraphRenderer` gains
     `select(nodeId: string | null): void`; `sigma-renderer.ts` implements it: remember the
     previous selection, restore its size, bump the new one (`size: 7`) and set
     `type`-independent halo via `color` unchanged + `zIndex`… keep it minimal: size bump +
     sigma `highlighted: true` attribute (sigma renders a highlight ring natively).
   - **Files:** `packages/graph-ui/page/app.ts` — all clicks route through `navigate`:
     graph `onNodeClick(id)` → `navigate({ node: id })`; project nav → `navigate({ project, node: null })`;
     `onChange` is now the ONLY renderer of selection: switches project session when `p`
     changes, calls `renderer.select(n)`, renders the active tab.
   - **Verify:** `bunx tsc --noEmit -p packages/graph-ui`; manual: clicking around updates the
     hash, back/forward works, refresh restores selection.

6. **Step 3.2 — resizable, maximizable panel + tab strip**
   - **Files:** `packages/graph-ui/page/app.ts` + `ui/theme.css` — a 5px `.resizer` div between
     main and detail (pointer events: track `pointerdown/move/up`, set
     `gridTemplateColumns: 240px 1fr <px>px` on `.app`); a `⤢` button in the panel header
     toggles `.detail.max` (theme.css: `width: 70vw`), state kept in a module `let`, double-click
     on the resizer = same toggle. Tab strip renders at the panel top from `Tabs(...)`,
     `onSelect: id => navigate({ tab: id })`.
   - **Verify:** manual — drag resizes, toggle maximizes, tabs switch views, hash carries the tab.

### Phase 4 — page: the four tab views + sidebar task tree

7. **Step 4.1 — Detail tab interlinked**
   - **Files:** `packages/graph-ui/page/detail.ts` — every id becomes a `Link` that `navigate`s:
     task detail step rows → `navigate({node: 'step:…'})`; artifacts row → artifact node; note
     `links` and new `backlinks` → note nodes; note author task → task node; step detail gains
     a "task" link. `renderDetail` gets the nav callback injected:
     `renderDetail(nodeId, d, go: (node: string) => void)`.
   - **Verify:** manual — clicking any id in the panel moves the graph selection + panel.

8. **Step 4.2 — Chat tab**
   - **Files:** `packages/graph-ui/page/chat.ts` — fetch `/api/transcript?project&task[&step]`
     (task from selection: task node → whole task, step node → that step, other nodes → the
     empty state "select a task or step"). Compose from primitives:
     - iteration divider: `.chat-iter` muted rule with `iter N`
     - `message` → `Card` with role tint (theme.css `.msg-assistant { border-left: 2px solid var(--accent) }`)
     - `tool` → native `<details>` row: `<summary>` = tool name + error badge when `isError`,
       body = `Pre(JSON.stringify(input))` + `Pre(output)`
     - `question` → warn-toned Card "Q:"/"A:" (unanswered = `Badge('waiting', 'warn')`) — the
       future reply box slot
     - `signal` → `Badge(outcome)` + summary text
     - live: on SSE envelope whose `summary.taskId` matches the selected task while the chat
       tab is open → refetch transcript (300ms debounce), keep scroll pinned to bottom unless
       the user scrolled up (`scrollTop + clientHeight < scrollHeight - 40` = unpinned).
   - **Verify:** manual + the existing server transcript test covers the data path.

9. **Step 4.3 — Plan tab**
   - **Files:** `packages/graph-ui/page/plan.ts` — fetch `/api/plans?project&task` (task from
     selection; step/artifact nodes resolve to their task first). Render: version `Tabs`
     (`v1 · v2…`, approved one badged `ok`), then per step a `Card`: title + status badge (from
     graph detail if present), `KV` rows (role, model, maxIterations, skills), `dependsOn` as
     `Link` chips → `navigate({node: stepNodeId(taskId, dep)})`.
   - **Verify:** manual — orc-sim tasks show their single-step plans; a grounded task shows
     multiple versions.

10. **Step 4.4 — Log tab + sidebar task tree**
    - **Files:** `packages/graph-ui/page/log.ts` — initial `/api/log?project[&task]` (limit
      200), then append rows from every SSE envelope `summary` (client cap 500, drop oldest).
      Row: `.log-row` (mono font): dim seq · kind `Badge` (tone by family: step/run=accent,
      tool=warn, memory=purple, error/failed=danger) · summary line. Row click →
      `navigate({node: taskOrNoteRef})` — task events link their taskId; `memory_written`
      links the note node (id parsed from the summary's payload — have `summarizeEvent` also
      return `noteRef: string | null` for memory events to avoid string-parsing here; add that
      field in Step 1.2). Task-selected state filters client-side.
    - **Files:** `packages/graph-ui/page/app.ts` — sidebar: under the project list, a
      `Section('tasks')` listing graph nodes of type task (the `nodeTypes` map already tracks
      ids; keep labels/details in a parallel map fed by snapshot+patches): `NavItem` with
      status dot tone, active when selected, `onClick: () => navigate({node: taskId, tab: 'chat'})`.
      Live: patches update the map → re-render list.
    - **Verify:** manual — log streams during a run; clicking a row jumps to the node; task
      tree mirrors the graph live.

### Phase 5 — verification + docs

11. **Step 5.1 — full matrix + README**
    - **Files:** `README.md` — extend the `orc graph` bullet: "…with per-task chat transcripts,
      plan versions, a live event log, and deep-linkable navigation (`#p=…&n=…&tab=…`)."
    - **Verify:** matrix below.

## Verification matrix

| Test | Expected result |
|---|---|
| `bun run typecheck` | clean |
| `bun test` | green; ui-core/graph-ui suites grown (transcript, summarize, sessions, envelope, endpoints) |
| `grep -rn "Bun.serve\|document\." packages/ui-core/src` | 0 hits |
| `orc graph` + browser, run a live task | graph animates; Log tab streams every event; Chat tab of the running task fills live and stays pinned to bottom |
| Click: note detail link → note; author → task; plan dependsOn chip → step; log row → node | selection + graph highlight + panel follow every time; back button retraces |
| Refresh on `#p=…&n=step:…&tab=chat` | same project, node, tab restored |
| `feedback_requested` during a run | question card with `waiting` badge in Chat |
| Panel drag + maximize | resizes; 70vw reading mode; state survives tab switches |

## Files touched

- `packages/ui-core/src/transcript.ts` + `.test.ts` — new
- `packages/ui-core/src/summarize.ts` + `.test.ts` — new (logic moved from debug-tail)
- `packages/ui-core/src/sessions.ts` + `.test.ts` — transcript/taskPlans/log/backlinks, always-notify
- `packages/ui-core/src/index.ts` — exports
- `packages/cli/src/debug-tail.ts` — consume `summarizeEvent` (dedupe)
- `packages/cli/package.json` — `@orc/ui-core` dep
- `packages/graph-ui/src/server.ts` + `server.test.ts` — endpoints + envelope
- `packages/graph-ui/page/nav.ts` — new (router)
- `packages/graph-ui/page/chat.ts`, `plan.ts`, `log.ts` — new views
- `packages/graph-ui/page/detail.ts` — links + backlinks
- `packages/graph-ui/page/renderer.ts`, `sigma-renderer.ts` — `select()`
- `packages/graph-ui/page/ui/components.ts` — `Link`, `Tabs`
- `packages/graph-ui/page/ui/theme.css` — link/tabs/chat/log/resizer styles
- `packages/graph-ui/page/app.ts` — router wiring, tab strip, resizer, task tree
- `README.md` — one line

Ready to execute when you say go.
