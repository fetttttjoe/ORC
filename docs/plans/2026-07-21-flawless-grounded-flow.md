# Plan: flawless grounded flow — from request to knowledge, no dead ends

Goal: a user can run `request → analyze → plan review → execute → verify → purge → repeat`
end to end without ever hitting a silent failure, a guessing agent, or a stale view. Every
defect below was OBSERVED in live testing on 2026-07-21; each phase is independently
shippable and verifiable.

## Vision ↔ system scorecard (verified 2026-07-21; statuses updated 2026-07-22 after P2/P3/P5-batch/P6 shipped)

The product vision: one tool, usable from the browser or by another agent; takes a task,
analyzes the repo first when bound to one; holds the project as a knowledge graph and the
work as a separate todo/plan graph; generates docs from the knowledge graph; agents pull
bounded graph slices instead of re-reading the repo (token economy); every interaction
logged and replayable; plans handed back for human annotation; questions asked, skills loaded.

| Vision pillar | Status | Where / gap |
|---|---|---|
| Browser use, full loop | ✅ | `orc graph` UI: create → review → annotate → approve → run |
| Used BY an agent (Claude, etc.) | ❌ | `mcp-client` only consumes servers; nothing exposes orc AS one → Phase 7 |
| Analyze-before-plan on a repo | ✅ | grounded strategy + analyze gate + plan-note graph |
| Knowledge graph ↔ todo graph split | ✅ | memory notes (current/target arch) vs task/plan/step graph |
| Docs generated from the graph | ✅ | seeded `documentation` skill, ordinary task — no extra runner |
| Token economy, measurable | ✅ | hits canonical + task-bound envelopes; per-task pulls chip + per-step cost chips in the request view (P5 batch 1) |
| Every interaction replayable | ✅ | tasks: event-sourced. Copilot chat: `copilot_exchange` events since 2026-07-22 — the pane itself rebuilds from the log (Phase 6) |
| Plan handed back + annotations | ✅ | `plan_annotated` + revise loop, web annotate, plan editor + mermaid; copilot approve-bypass closed structurally (P2: tool removed) |
| Questions always asked | ✅ | grounded: `feedback_requested` outbox; copilot: clarify-before-mutate mandated + approval structurally human-only (P2) |
| Skills loadable | ✅ | SKILL.md index, `skillRefs` validated at propose time |

Grounded facts (evidence from the event log / session):
- A copilot-invented cwd (`/workspace/orc-sim`) reached the executor and burned 4 workspace
  retries on a deterministic `EACCES` before blocking the task (seq 6210–6215). → Phase 1 (done)
- An 8-step "audit" plan shipped with zero `dependsOn`, its verification step running in
  parallel with the work it verified, in one shared worktree with no zones. → Phase 2
- `zone: []` is accepted by contracts but enforced by NOTHING at runtime. → Phase 2
- Surreal sessions silently expired → the read model was empty for hours while agents
  "successfully" wrote memory (events committed, projection dead). Fixed for auth; the
  DETECTION gap (no health surfacing in the UI) remains. → Phase 3
- Per-event session refold is O(history) — fine at demo scale, marked in `sessions.ts`. → Phase 4
- `/api/copilot` receives the whole message history FROM THE BROWSER (`CopilotBody.messages`,
  max 60) and appends nothing — copilot conversations are outside the audit boundary while the
  copilot can approve/run/create (verified in `graph-ui/src/server.ts` 2026-07-21). → Phase 6
- No MCP server surface exists: `plugins/mcp-client` consumes; grep for a serving adapter over
  `OrcActions` finds none (verified 2026-07-21). → Phase 7
- The copilot auto-approved and ran its own plan: `task_created → plan_proposed → plan_approved
  → run_started` in 600ms (seq 6205–6210, create/propose/approve share one millisecond — no
  human in that loop). The `approve` tool is guarded only by a prompt line ("ASK the user …
  unless they already told you to proceed fully"), and the 2026-07-22 12:29 run shows the
  guard not holding. The human gate must be structural. → Phase 2
- That 12:29 failed run predated the P1 fix taking effect (server booted 12:28:04, fix written
  after). VALIDATED 2026-07-22 12:54: the re-run asked permission, used the real cwd, built a
  connected 7-note knowledge map, grounded its plan from the graph (zero repo re-reads), held
  at the human gate 58s, and completed all four steps with verify-as-last — task 329529ea.

## Phase 1 — trust boundaries for run inputs (DONE with this commit)
- [x] `assertRunnableCwd` at the action boundary: grounded creation and `run` reject a
      non-existent/non-directory cwd with the project's real dir in the message.
- [x] Copilot prompt anchors the KNOWN `defaultCwd` and forbids invented paths.
- Acceptance: `new_request(grounded, cwd=/workspace/x)` fails in <1s with an actionable
  error; no `run_started` event is ever appended for an invalid cwd.

## Phase 2 — plans that cannot ship malformed — ✅ SHIPPED 2026-07-22
- [x] Approval is human-only: `approve` removed from the copilot toolset (`ui-core/copilot.ts`);
      prompt states HUMAN-ONLY and points at the UI button / `orc approve`. The copilot keeps
      `reply` — it may RELAY the user's stated answer to a grounded ask_human gate, but the
      words originate with the human in the same exchange. Test: copilot.test.ts.
- [x] Mechanical guard in `validatePlan` (contracts — the seam every propose/edit/split routes
      through via `appendPlanVersion`): a multi-step plan with every `dependsOn` empty and no
      `verify` step is rejected, error names the offending shape. Test: plan.test.ts.
- [x] Freezer role mapping: `instantiateFrozenPlan` freezes the `verify` subplan as role
      `auditor` (shared `VERIFY_STEP_ID` in contracts). Test: grounded-plan.test.ts.
- [x] Zone ENFORCED (not removed): `assertInZone` write-fence in `contracts/workspace.ts`
      (same trust-boundary module as `resolveInWorkspace`), applied by `executeTool` on
      `fs_write` only — reads stay free, empty zone = unrestricted, error names the fence.
      Tests: workspace.test.ts + tools.test.ts.
- [x] Permanent-error fail-fast: `isTerminalError` (the shared retry predicate every retry
      site consults) now treats `EACCES/EPERM/ENOENT/EROFS/ENOTDIR/EISDIR` as terminal;
      transient codes (EBUSY, EAGAIN) still retry. Test: execution.test.ts.
- Acceptance met at unit level: dependency-free multi-step plan rejected at every authoring
  path; `verify` freezes as auditor; out-of-zone write fails with a named fence; EACCES
  fails on attempt 1.
- [ ] FOLLOW-UP (noted 2026-07-22): zones are not expressible for grounded SUBPLANS —
      `ChildPlanStep` omits `zone` and expansion stamps `[]` (kernel.ts), so parallel
      siblings in one worktree are guarded only by the plan-authoring skill's prose rule
      ("must not write the same files"). Upgrade path: plan notes declare write zones →
      `instantiateFrozenPlan` freezes them into child steps → the existing executor fence
      enforces disjointness mechanically. Until then the skill line stays — there is NO
      workspace write queue; the advisory lock serializes event appends only.

## Phase 3 — no silent degradation, ever — ✅ SHIPPED 2026-07-22
- [x] `/api/health` on the graph server (`opts.health` provider, wired by the CLI to
      `probeMemory`); the footer polls every 15s and shows a red `memory degraded` badge.
      A probe failure IS the degraded signal (never a 500).
- [x] Projector lag surfaced: `probeMemory`'s reason (`N unapplied events` — cursor vs log)
      rides the badge tooltip. Read-only servers (outside a project) report `memory: null`.
- [x] Blocked-task affordance: a `step_failed` card in the project conversation gets an
      inline `retry failed step` row (same action as the inspector); superseded rows retire
      on the next run/step start so a stale button can't double-start.
- Acceptance: killing SurrealDB changes the footer within one poll interval (≤15s); a failed
  step is retryable from the chat in one click. (e2e for the kill-surreal path deferred —
  needs a disposable Surreal per test; unit + manual verified.)

## Phase 4 — scale and structure (defer until felt)
- [ ] Incremental session folds: replace refold-per-event with kernel `applyEvent` behind
      the same `ProjectSessions` interface (marked in `sessions.ts`).
- [ ] Multi-project runtimes: lift the mutation fence by giving the graph server
      per-project kernel+port factories (today: fence + honest errors).
- [ ] Cross-scope note links as SCHEMA (`MemoryLink.scope?`) instead of the view-level
      project-scope fallback in `buildGraph`.
- [ ] e2e coverage for the full loop: purge → create → analyze-gate answer → chip
      correction → approve → waves → delete chat (today: shell boot, inspector journey,
      scroll regression, copilot stream, approve-advance — see `e2e/app.pw.ts`).

## Phase 5 — UI polish pass (collect, then batch)
First batch shipped 2026-07-22 (evidence: screenshots of the completed orc-sim run):
- [x] Feed lines carry step context: `verify · attempt 1`, `synthesize → Produced …` — fixed
      once in `summarize.ts`, so web log, project feed, and debug-tail all gained it.
- [x] Artifact lines human-readable: `path · 21.4 KB · sha 092bd8f1` (was `sha256:… 21935B`).
- [x] Artifact count dedup by (path, sha): a verify step re-declaring the same output no
      longer shows "2 verified artifacts" for one file (view-level; lineage keeps every receipt).
- [x] Per-step cost/tokens: `stepUsage` fold in kernel projections (same agent_call events as
      task usage), rendered as a chip on each step card (`$0.92 · 625.3k tok`) — always
      visible beats on-hover.
Still open:
- [ ] Audit visual hierarchy of the chat cards (user reported "a bit wrongly done" —
      gather specifics: spacing, duplicate information density, card ordering).
- [ ] Chat placeholder ("this is the project chat…") stays visible above seeded history
      after a reload — hide it once the first card/bubble lands (noticed 2026-07-22; the
      e2e ready-wait keys on it, so give the pane an explicit ready marker when fixing).
- [x] Token-economy made visible (2026-07-22): `recordAccess` now binds the event envelope to
      the author's task identity (agent pulls carry taskId/stepId/runToken; CLI stays null),
      and the request view's knowledge card shows `· N pulls`. Tests: store.test.ts.
- [ ] Copilot: stream tool-call cards collapsed by default once >3 in one exchange.

## Phase 6 — the interaction log has no blind spots — ✅ SHIPPED 2026-07-22
- [x] `copilot_exchange` event kind (contracts): user message + final assistant text + bounded
      tool-call summaries + modelRef; usage (incl. priced cost) rides the envelope. Appended by
      the graph server after the stream ends (`opts.appendExchange`, CLI wires it to the
      project log) — HOME project only; foreign-project chats stay read-only and unjournaled.
      Redaction at the storage boundary like every event; the signal-router's exhaustive
      kind-map forced an explicit routing decision (false) — the seam worked as designed.
- [x] Pane rebuilds from the log: `reload()` renders nothing from localStorage (it only feeds
      the model's short-term context); `seed()` replays `copilot_exchange` rows into real
      bubbles in true seq order via a `LogRow.exchange` side-channel (same pattern as
      `noteRef`). Live rows are skipped — this tab already rendered them while streaming.
      Purge/delete-chat rewrite the pane like any view, bubbles included.
- [x] Clarify-before-mutate prompt line — landed with the P2 batch (copilot.ts).
- Acceptance verified: e2e reloads mid-conversation and the bubbles come back FROM THE LOG
  (app.pw.ts, extended); `orc log --json` shows exchanges (ordinary events); fold treats the
  kind as traceability-only (projections.test).

## Phase 7 — orc as a tool for other agents (`orc mcp serve`)
The vision's "usable everywhere — even by Claude" pillar. The transport-free core
(`OrcActions` + `ProjectSessions`) was built so adapters stay thin — the web server proves
it; an MCP server is the second adapter, not a new subsystem.
- [x] `orc mcp serve` (stdio) read slice — SHIPPED 2026-07-22. One tool definition, two
      doors: `asResolvedTools` (ui-core) reshapes the copilot's read toolset (project_status,
      task_plan, task_transcript, plan_notes, recent_activity) for MCP; memory
      search/read/neighbors ride along from the memory plugin (degraded-tolerant), write
      surface excluded. Lazy SDK import; sessions + memory only — DBOS never boots.
      Test: mcp-serve.test.ts spawns the real binary and drives initialize → tools/list →
      tools/call over stdio.
- [x] Mutating tools — SHIPPED 2026-07-22: the copilot's mutate set (new_request, propose,
      run, reply, retry, cancel, annotate, revise) rides the same `asResolvedTools` bridge
      over the same `OrcActions` the web door uses. Trust/init stay CLI-only. Second stdout
      layer for mutations: the transport keeps the REAL stdout; `process.stdout.write` is
      rerouted to stderr, so winston (DBOS booting lazily for run/retry) cannot corrupt the
      protocol channel — the winston TODO from the read slice is resolved structurally.
- [x] Autonomy dial — SHIPPED 2026-07-22: `orc mcp serve --autonomy gated|full` (default
      gated). The `approve` tool is MCP-specific (the two doors differ exactly here): gated
      → refuses naming the way forward; full → approves. The human decides once, at launch.
      `ApprovalPolicy` (manual|auto + depth/cost rules) remains the finer dial when wanted.
- [x] Source attribution, first cut — SHIPPED 2026-07-22: `plan_approved.approvedBy` gained
      the `mcp` variant (contracts enum + kernel + OrcActions thread it through), so THE
      gate event is auditable as agent-approved. Broader per-event source attribution stays
      the roadmap's "Attribution first" collaboration prerequisite — it needs an envelope
      design pass, not a payload enum.
- [x] Prerequisite: clean stdout — DONE 2026-07-22. Audit found 55 stdout writers on boot
      paths but all read-path prints are console.warn (already stderr); bin.ts now rebinds
      log/info/debug → stderr as the FIRST lines under `mcp serve`, before any boot code.
      DBOS (winston → process.stdout, uncatchable by console rebind) stays un-booted on the
      read path (lazy port); the mutations slice added layer 2 — transport owns the real
      stdout, everything else reroutes to stderr.
      Acceptance test asserts EVERY stdout line parses as a JSON-RPC frame.
- Acceptance status: spawn test drives initialize → tools/list → project_status → approve
  (gated: refuses with 'human gate' + '--autonomy full') → new_request (task created) over
  real stdio, every stdout line a JSON-RPC frame; `approvedBy: mcp` verified at the kernel
  (kernel.test). Remaining to observe live: a full `--autonomy full` run driven by actual
  Claude Code end to end — do it once against a scratch project and note the result here.

Deferred, with triggers (candidates for `docs/IDEAS.md`):
- Doc staleness detection (re-suggest the docs task when the knowledge graph changed since
  the last docs artifact) — trigger: docs generated twice and observed stale.
- Embeddable flow-viewer library (annotated plan flows rendered outside the orc UI) —
  trigger: a second host application actually wants to render plans.

Rules for executing this plan: one phase per PR, each lands with its acceptance checks as
tests. Execution order: P2 → P3 → P6 → P7 → P4 → P5 — numbering stays stable for reference;
order is by risk: correctness → visibility → auditability → reach → scale → polish. No phase
starts before the previous one in that order has its checks green in CI.
