# Plan: OrcActions — CLI capabilities in the web UI (create, propose, approve, run, reply, retry, cancel)

Turns the road view's copy-paste chips into real buttons and adds task creation from the
browser. The design keeps one implementation of every command: a `buildOrcActions` in the CLI
package wraps the exact calls `main.ts` already makes (kernel + ExecutionPort), the `orc graph`
command hands it to the web server, and CLI commands migrate onto the same functions
command-by-command (cancel migrates now — its sweep logic moves into the shared impl).

Action inventory v1 (the task lifecycle the road shows):

| Action | Implementation (verified against main.ts) |
|---|---|
| `newTask` | `kernel.createTask({title, spec, parentId})`; grounded: `kernel.createGroundedTask` + fire-and-forget `port.startRun` |
| `propose` | `kernel.proposePlan(id, singleStepDraft(task, model, skills, config?.maxIterations))` |
| `approve` | `kernel.approvePlan(id, version?)` |
| `run` | `port.startRun(id, {cwd})` — fire-and-forget; the UI already watches the stream |
| `reply` | `await needPort()` (DBOS must be up in-process) then `kernel.replyFeedback(id, text)` |
| `retry` | `port.retry(id)` |
| `cancel` | `port.cancelRun(id)` + the orphan-note sweep (moves out of main.ts into the shared impl) |
| `annotate` | `kernel.annotatePlan(id, { targetNote, refs, text })` — refine one plan-note |
| `revise` | annotate each scoped note + `kernel.replyFeedback(id, text)` — wakes the parked plan agent (mirrors `orc plan-revise`) |

Deliberately CLI-only (not in this plan): `mcp trust` / `ext trust` / `init` / `migrate`
(local-consent and setup surfaces — weakening them over HTTP is a security regression), plan
draft **files** (`propose --file`), grounded-plan annotate/revise UI, memory CRUD. All can layer
on later through the same port.

Security (non-negotiable, mutations over localhost HTTP are CSRF-able):
- A random session token is minted at server boot. `GET /api/session` returns
  `{ actions: boolean, token, defaultCwd }`; every `POST /api/actions/*` must carry it in an
  `x-orc-token` header. A cross-origin page cannot read the token (CORS) and cannot send the
  custom header without a preflight we never approve — both classic CSRF vectors die.
- Server stays bound to 127.0.0.1. Action bodies are zod-parsed.
- When `orc graph` runs without a project (`plugin` absent), the server has no actions object
  and every actions route answers 501 — the read-only mode we have today is preserved.

---

### Phase 1 — the port (interface in ui-core, one implementation in cli)

1. **Step 1.1 — `OrcActions` interface in ui-core**
   - **Why:** adapters (web now, TUI later) program against the interface; implementations live
     where the runtime lives.
   - **Files:** `packages/ui-core/src/actions.ts` (+ export from `src/index.ts`)
     ```ts
     // Mutating capabilities, implemented by whoever owns a Kernel + ExecutionPort (the CLI
     // today). Adapters receive this; ui-core itself never constructs one.
     export interface OrcActions {
       newTask(input: { title: string; spec?: string; parentId?: string; grounded?: { modelRef: string; cwd: string } }): Promise<{ taskId: string }>
       propose(taskId: string, opts: { modelRef: string; skillRefs?: string[] }): Promise<{ version: number; steps: number }>
       approve(taskId: string, version?: number): Promise<{ version: number }>
       run(taskId: string, cwd: string): Promise<{ workflowId: string }>
       reply(taskId: string, text: string): Promise<{ answered: boolean }>
       retry(taskId: string): Promise<{ workflowId: string }>
       cancel(taskId: string): Promise<{ swept: number }>
     }
     ```
   - **Verify:** `bunx tsc --noEmit -p packages/ui-core`.

2. **Step 1.2 — `buildOrcActions` in the CLI package; cancel migrates onto it**
   - **Why:** one implementation per command. The CLI's cancel action currently holds the sweep
     block inline — it moves here and `main.ts` delegates, so web-cancel and CLI-cancel cannot
     drift.
   - **Files:** `packages/cli/src/actions.ts`
     ```ts
     import { EVENT_KIND, type ExecutionPort } from '@orc/contracts'
     import { subtreeTaskIds, type Kernel, type OrcConfig, type ProjectConfig, type EventLog } from '@orc/kernel'
     import { createMemory, orphanedNotes } from '@orc/memory'
     import type { OrcActions } from '@orc/ui-core'
     import { singleStepDraft } from './main'   // if this import cycles (main imports actions), move singleStepDraft into actions.ts and re-export from main

     export function buildOrcActions(deps: {
       kernel: Kernel
       needPort: () => Promise<ExecutionPort>
       config: OrcConfig
       plugin?: { config: ProjectConfig; log: EventLog }
     }): OrcActions { ... }
     ```
     Implementations are verbatim the main.ts calls from the inventory table. `cancel` contains
     the whole sweep block (try/catch, provenance author, projector catch-up) returning the
     swept count; `packages/cli/src/main.ts`'s cancel command becomes
     `const { swept } = await actions.cancel(taskId)` + the existing console reporting (build
     one `actions` instance inside `buildProgram` when `portFactory` exists).
   - **Files:** `packages/cli/src/actions.test.ts` — reuse the cancel-sweep wiring test's
     harness shape (real plugin, stub port): `newTask` returns an id that `kernel.getTask`
     resolves; `propose`+`approve` land plan v1 approved; `cancel` sweeps the seeded orphan
     (assert same events as the existing main.test case). Keep the existing main.test
     cancel-sweep test green unchanged — it now exercises the delegation.
   - **Verify:** `bun test packages/cli` all green.

3. **Step 1.3 — `orc graph` hands actions to the server**
   - **Files:** `packages/cli/src/main.ts` graph command:
     `startGraphUi({ url, port, cwdProject, actions: portFactory && plugin ? buildOrcActions({ kernel, needPort, config: loadConfig(), plugin }) : undefined, defaultCwd: plugin?.config.dir ?? process.cwd() })`
   - **Verify:** `bunx tsc --noEmit -p packages/cli`.

### Phase 2 — web adapter: session + action routes with CSRF guard

4. **Step 2.1 — routes**
   - **Files:** `packages/graph-ui/src/server.ts` (+ `zod` stays transitive via ui-core — add
     explicit dep to graph-ui package.json), `server.test.ts`.
     - Boot: `const token = crypto.randomUUID()`.
     - `GET /api/session` → `{ actions: opts.actions !== undefined, token, defaultCwd: opts.defaultCwd ?? null }`.
     - `POST /api/actions/:name` (single handler): 501 when no actions; 403 when
       `req.headers.get('x-orc-token') !== token`; body `await req.json()` parsed by a per-name
       zod schema (`{ title: z.string().min(1), spec: z.string().optional(), ... }` etc.);
       dispatch to the matching `OrcActions` method; `Response.json(result)`; errors →
       `Response.json({ error: message }, { status: 400 })` (kernel throws are user-actionable:
       stale version, no open feedback, unknown task).
   - **Files:** `server.test.ts` additions — build a real `OrcActions` from a stub kernel? No:
     pass a hand-rolled `OrcActions` stub recording calls. Cases: POST approve with token →
     200 + stub called; without token → 403 and stub NOT called; unknown action → 404; server
     without actions → 501; `GET /api/session` shape.
   - **Verify:** `bun test packages/graph-ui` green.

### Phase 3 — page foundation: create dialog, action client, road buttons, reply box

Navigation change (the user's "own field"): the request journey is first-class —
- Sidebar top: a primary **`+ new request`** button (hidden on read-only servers).
- The `plan` tab becomes the **`request`** tab (first position, default when a task is
  selected): lifecycle rail → your-move buttons → **decomposition** (grounded tasks) → road of
  steps → **knowledge** (notes this request created, growing live) → outputs.

5. **Step 3.1 — primitives: `Toast` + `Dialog` (native `<dialog>`)**
   - **Files:** `page/ui/components.ts` + `theme.css`.
     - `toast(text, tone)`: appends to a fixed bottom-right `.toasts` stack, fades after 4s.
     - `openDialog(title, fields, onSubmit)`: builds a `<dialog>` with labeled inputs
       (`text`/`textarea`), Cancel/OK buttons, `showModal()`, returns values on submit. All
       `createElement`, no innerHTML.
   - **Files:** `page/api.ts` — the action client:
     ```ts
     let session: { actions: boolean; token: string; defaultCwd: string | null }
     export async function initSession(): Promise<boolean>   // fetch /api/session once
     export async function act<T>(name: string, body: unknown): Promise<T> // POST with x-orc-token; throws on {error}
     ```
   - **Verify:** tsc; visual.

6. **Step 3.2 — “+ new request” in the sidebar**
   - **Files:** `page/app.ts` — primary button atop the sidebar (hidden when
     `!session.actions`). Dialog fields: title, spec, and a mode select —
     **quick** (single-step template; model input, default haiku) or **grounded** (the agent
     analyzes the repo and proposes a decomposition; model input + cwd prefilled from
     `session.defaultCwd`). Submit → `act('newTask', { …, grounded? })` → toast →
     `navigate({ node: taskId, tab: 'request' })` — the journey view takes over: quick shows
     "your move: propose"; grounded shows the analyze step already running.
   - **Verify:** manual — create both modes from the browser; grounded starts its run
     immediately and the chat tab shows the analyzer working.

7. **Step 3.3 — road buttons + reply box**
   - **Files:** `page/plan.ts` — `renderRoad` gains `act: ((name, body) => Promise<unknown>) | null`.
     When present, the your-move callout renders buttons instead of bare chips:
     - draft → **Propose** (model defaulted to `anthropic/claude-haiku-4-5`, editable in a
       small input)
     - awaiting_approval → **Approve** (version-pinned to the shown version)
     - approved → **Run** with a cwd input prefilled from `session.defaultCwd`
     - open question → inline textarea + **Reply**
     - failed → **Retry** · any active state → **Cancel** (confirm dialog)
     Each button: disable while pending → `act(...)` → toast success/error; the SSE-driven
     refresh repaints the new state — no optimistic UI.
   - **Files:** `page/chat.ts` — the unanswered question card gets the same reply textarea when
     actions exist (the slot we reserved).
   - **Verify:** manual matrix below; CLI parity spot-check (`orc plan <id>` shows v1 after a
     web propose).

### Phase 4 — the request journey: decomposition, refine, knowledge growth

8. **Step 4.1 — ui-core + actions: plan-notes and refine**
   - **Files:** `packages/ui-core/src/sessions.ts` — new method
     `planNotes(projectId, taskId)`: `foldPlanNotes(s.events, planScope(taskId))` (both
     exported by `@orc/kernel`); returns the decomposition notes (title, summary, rationale,
     uncertainty, `decomposes_into`/`depends_on` links). Test: grounded fixtures from
     `packages/kernel/src/execution/strategies/grounded-plan.test.ts` style.
   - **Files:** `packages/ui-core/src/actions.ts` interface + `packages/cli/src/actions.ts`:
     `annotate(taskId, noteId, text, refs?)` and `revise(taskId, text, scope: string[])`
     (annotate each + reply — same calls as the `plan-revise` command; migrate that command
     onto it like cancel). Server: two schemas in `ACTION_INPUT` + dispatch. Tests: stub-level
     route test + cli action test.
   - **Verify:** `bun test packages/ui-core packages/cli packages/graph-ui` green.

9. **Step 4.2 — request tab: decomposition + knowledge sections**
   - **Files:** `page/plan.ts` (renders the whole request view), `page/app.ts` (tab rename
     `plan` → `request`, first position, default tab for task nodes).
     - **Decomposition** (grounded tasks, when `/api/plan-notes` is non-empty): the split-up as
       an indented tree following `decomposes_into` (root first), each node: title, summary,
       `Badge` for uncertainty count, `depends_on` chips, and — when actions exist — a per-note
       **refine** input (annotate) plus one **revise scoped notes** action for the checked
       notes; while the plan gate is open, **approve plan** = reply 'approve'. Every note links
       into the graph (`noteNodeId(planScope(taskId), id)`) — the split IS graph data.
     - **Knowledge**: notes whose `wrote` edge originates in this task's subtree — listed with
       kind badges and live count ("knowledge: 4 notes"), each a `Link`; grows as SSE patches
       land (the section re-renders with the road's existing live refresh).
   - **Files:** `packages/graph-ui/src/server.ts` — `GET /api/plan-notes?project&task` →
     `sessions.planNotes(...)`.
   - **Verify:** manual — a grounded request shows its decomposition tree; annotating a note
     and revising wakes the plan agent (chat shows it); knowledge list grows during a run.

10. **Step 4.3 — graph focus mode (watch the expansion)**
    - **Files:** `page/renderer.ts` — `focus(nodeIds: Set<string> | null): void`;
      `sigma-renderer.ts` — sigma `nodeReducer`/`edgeReducer` dim (color → `#2a2a33`, no
      label) everything outside the set; null restores. `page/app.ts` — a **focus** toggle in
      the request view header: computes the set client-side from current graph links (task
      subtree via `child` edges, their steps/artifacts via `plan`/`out`, their notes via
      `wrote`, plus the plan-scope notes) — no server change. New patches re-apply the focus
      filter, so freshly written notes light up inside a dimmed world as they arrive.
    - **Verify:** manual — focus a running grounded task: the graph dims to its subtree and new
      knowledge nodes appear bright as the agents write them.

11. **Step 4.4 — docs**
    - `README.md`: extend the `orc graph` bullet — "…full request lifecycle from the browser:
      create (quick or grounded) → review the decomposition → refine/approve → run → watch the
      knowledge graph grow; trust/init stay CLI-only."

## Verification matrix

| Test | Expected result |
|---|---|
| `bun run typecheck` + `bun test` | clean / all green (new: cli actions tests, server action-route tests) |
| POST action without `x-orc-token` | 403, action not executed (test) |
| `orc graph` outside a project → POST action | 501; UI hides all buttons (`session.actions=false`) |
| Browser: + new request (quick) → propose → approve → run | full lifecycle without touching the terminal; road advances stage by stage live |
| Browser: + new request (grounded) | analyze runs immediately; decomposition tree appears; refine a note → revise → plan updates; approve → steps instantiate |
| Request view knowledge section + focus toggle | note count grows during the run; focus dims the graph to the request and new notes appear bright |
| Agent asks a question (`ask_human`) | question card shows textarea; Reply resumes the step; answer appears in chat |
| Web cancel of a running task | task cancelled + orphan notes swept (same events as CLI cancel — shared impl) |
| CLI parity | `orc cancel` still sweeps (delegation kept main.test green); `orc plan` shows web-proposed plans |

## Files touched

- `packages/ui-core/src/actions.ts` (new), `src/sessions.ts` (planNotes), `src/index.ts`
- `packages/cli/src/actions.ts` (new; annotate/revise too), `actions.test.ts` (new), `main.ts` (cancel + plan-revise delegate; graph passes actions)
- `packages/graph-ui/src/server.ts` + `server.test.ts` (session + action routes + plan-notes, CSRF)
- `packages/graph-ui/page/api.ts` (new), `ui/components.ts` + `theme.css` (Toast, Dialog, buttons, tree, focus), `app.ts` (new-request, request tab, focus), `plan.ts` (request view), `chat.ts` (reply box), `renderer.ts` + `sigma-renderer.ts` (focus)
- `README.md`

Ready to execute when you say go.
