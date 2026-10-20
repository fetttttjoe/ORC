# Roadmap

Forward-looking work, in intended order within each track. Entries state what would make them
worth starting ("when"), so a deferral is a decision, not a blind spot. Statuses: **next** (agreed,
unstarted), **deferred** (designed, waiting on its trigger), **open** (problem known, design open).

## Track 0 — the workspace console (next, in this order)

A project has workspaces. In a workspace the operator gives orc a request, sees what it plans, and
follows every agent live; they answer or redirect at the request or the task level. Every
interaction is a chat: `chat_opened` starts one, every mutation verb takes an `Origin {chatId,
door}`, and a chat's digest (what it asked, caused, changed and cost) folds from the log alone.
The read path is one registry of named server views. [sourced: packages/ui-core/src/views/view.ts,
packages/contracts/src/chat-digest-fold.ts] Four specs remain; each merges green on its own.

1. **Workspace module** — *next.* A shell (tree · conversation · dock), the workspace timeline, a
   request tab with the combined chat of its task subtree, subtask tabs with one lane per step,
   and the plan visual in the dock. One feature module behind a narrow port. It carries the
   per-workspace worktree setup scripts, and the session list's project name, which falls back
   to the config name instead of the logged `project_identified`.
2. **Task lifecycle verbs** — *next.* Move, archive, delete, and purge-with-knowledge: the kernel
   first, then every door.
3. **External chats** — *next.* The plugin's SessionStart hook opens a chat, and the MCP door
   tags every call with it. The transcript is referenced and read on demand.
4. **Authoring and action seam** — *next.* Claims are authored from the console (class, sources,
   retire), and a `WorkspaceAction` registry runs each action as a chat. No actions ship with it.

Carried beside the console:
- **A rename does not rewrite `.orc/identity.json`** — *open.* A purge re-seeds the logged name,
  but the file keeps the old one. When: spec 1 touches project identity.
- **Content-keyed test record** — *deferred (designed).* Re-measure repeated `bun test` proof with
  `bench/test-runs.ts` first; build the record only if repeats still cost real time.
- **`createDbosPort` is one closure** — *deferred.* Split it when one change has to touch two of
  its workflows.
- **Unpriced catalog models** — *next.* The Anthropic price table (`COSTS` in
  `plugins/provider-anthropic/src/index.ts`) names no 5.5-generation model, though discovery lists
  them. A call on one records `costUSD: null`, and the subtree budget counts null as 0
  (`Kernel.proposeSplit`), so such a run never draws down its budget. Price the models from the
  provider's published table, and refuse an unpriced model when a budget is set.
- **Provider robustness** — *open.* A malformed Codex token surfaces as a raw `JSON.parse` error,
  and the openai plugin pins `client_version` (`plugins/provider-openai/src/options.ts`).

## Track 1 — team-scale concurrency (the shared-tree ceiling)

Today every task executes in one shared working tree. Task-attributed floors + pathspec commits
make DISJOINT concurrent tasks compose; OVERLAPPING tasks still serialize by hand. [derived:
2026-07-29 live pipeline run — a task's commit stages only its own recorded paths]

1. **Zone-aware admission** — *next.* Refuse or queue a task whose zones overlap a RUNNING task's
   zones; the same overlap rule `validatePlan` applies within one plan, lifted to admission. Makes
   single-tree mode team-tolerable with a small kernel change. When: before any second concurrent
   writer becomes routine.
2. **Worktree isolation tier** — *deferred (designed).* Implement `IsolationTier.worktree` (the
   enum already exists in contracts; frozen plans stamp `local` today): each task runs in its own
   `git worktree` with its own HEAD; the commit step commits on the task's branch.
   When: more than one person (or overlap-heavy concurrent tasks) drives the repo.
3. **PR-shaped integration** — *deferred.* On top of worktrees: the commit step pushes a branch
   instead of committing mainline; the verify auditor becomes pre-review, a human PR review the
   final gate. When: track 1.2 lands and a team exists to review.

## Track 2 — MCP surface (easier to consume)

Both MCP directions are stdio-only today: `orc mcp serve` exposes up to 22 tools over stdio, and
`plugins/mcp-client`'s hub lazy-spawns stdio servers. [sourced: packages/cli/src/mcp-serve.ts,
plugins/mcp-client/src/index.ts]

1. **SSE / streamable-HTTP serving** — *next.* Serve `orc mcp serve`'s tool surface over the MCP
   streamable-HTTP transport (SSE-compatible) so clients connect to a URL instead of spawning a
   local process — claude.ai connectors, remote teammates, long-lived sessions. Requires an auth
   story: a network door is a non-human door, so the approve gate's refusal (and `approvedBy`
   attribution) carries over unchanged; add bearer-token auth at the transport.
2. **Remote MCP clients in the hub** — *open.* Let `.orc/config.json` declare URL-based (SSE /
   streamable-HTTP) servers alongside stdio commands; trust fingerprints extend to URL + declared
   headers. When: the first external tool a plan needs is only reachable over the network.
3. **Resources capability** — *open.* Expose read-only project state (status, plans, claims) as MCP
   resources so clients can subscribe rather than poll tools. When: a client actually wants
   subscription semantics.

## Track 3 — truthful-stamp pipeline follow-ups

1. **Split summary carries the audit verdict structurally** — *open.* The parent's split result
   takes the terminal step's summary, which is now the commit receipt; the verify verdict travels
   only because the commit contract says to carry it. Consider composing both terminal summaries
   into the split resolution. When: a parent visibly loses an audit verdict.
2. **A falsely-done task has no repair path** — *open.* `plan-revise`/`plan-note` refuse on
   status `done` (only `blocked` admits repair), so a task that terminated wrongly-successful —
   e.g. the empty split above — cannot be corrected in place; the whole grounding is re-bought.
   [sourced: kernel's editPlan from-status guard; live failure 2026-07-31 — "cannot annotate a
   plan while task is 'done'"] Either admit `done` into the repair path behind an explicit
   operator flag, or let a terminal task be reopened to `blocked`. When: the next wrongly-done
   terminal state — the empty-split gate (landed 2026-08-01) removes the known
   producer, but any step that lies about success recreates it.

## Track 4 — carried operator items

- **Queued-state visibility** — a task waiting for a worker slot is indistinguishable from a
  running one; add an admitted-but-not-scheduled state. When: the first time a team member asks
  "is it stuck?".
- **Built-in read-only command set for exec** — split safe reads (cat/ls/head/wc/find) from
  operator-gated mutating commands so an allowlist choice about `grep` never implies one about
  `rm`.
- **Declared external read resources** — let a task declare read-only paths outside the workspace
  (bench corpora) instead of blanket-unfencing reads.
- **A task's verify cannot exercise a step-tool the same task introduces** — the tool exists only
  in uncommitted code the running supervisor never loaded; verify-as-code or a deploy step. When:
  it bites a second time.

## Track 5 — roles and skills as operator-editable documents

Skills are force-loaded per step by ref and hash-audited via `skill_loaded` events; the per-role
contracts are themselves skills (`vault/skills/role-auditor`, `role-committer`, `role-finisher`),
appended to the step's `skillRefs` at the freeze, so the operator edits them like any other skill.
[sourced: packages/kernel/src/plugins/skills.ts,
packages/kernel/src/execution/strategies/grounded-plan.ts] Direction borrowed from ECC's
agents-and-skills-as-markdown surface, mapped onto the existing loader rather than ported.
[sourced: github.com/affaan-m/ECC]

1. **Agent-elective skill consumption** — *open.* `skill_search`/`skill_load` step-tools so an
   agent can pull a skill mid-run (bounded pulls); read a skill's
   `references/` subdirectory (today only the SKILL.md body injects); tolerate third-party
   frontmatter (unknown keys are hard validation errors today, so external skill packs need
   trimming before they drop into `vault/skills/`). When: a plan step cannot know at authoring
   time which skill it needs, or the skill set outgrows force-loading.
2. **One boundary story for contracts** — *next (designed).* Runtime blame with compile-like
   placement, round-wide: one plan-field rule table (shape = refused at the producing
   write itself; judgment = warn, human decides) driving write + validatePlan from one
   source; one `degraded` absent-measurement convention across tool outputs; then a UI-parity sweep
   (edit-on-blocked reachable, subtree questions surfaced via openFeedbackInSubtree, terminal
   tasks never offer an answer box). Named frontier deliberately out: `depOutputs` are the one
   uncontracted agent→agent boundary. [derived: five incident-driven slices on 2026-07-30
   accreting per-incident fixes — this round gathers them into one boundary story]
3. **Interactive plan canvas** — *open.* Today the human reviews the rendered plan and revises it
   only by annotating and waking the plan agent; there is no direct manipulation. A browser plan
   canvas (graph-ui or a dedicated view) would let the human edit subplans in place — reorder
   `dependsOn`, adjust `zone` globs, swap `modelRef`, rewrite requirements — with each edit
   written as an ordinary plan-note through the one mutation surface, so the approval gate, the
   changed-since-approval refusal, and the deterministic freeze all apply to human edits exactly
   as they do to agent edits. The planner's prose behavior is already operator-configurable via
   the plan-authoring skill; this item is the missing interaction layer. Its precondition is
   met — the console is Svelte 5 + shadcn-svelte with a query cache, so a canvas is components and
   mutations rather than hand-synchronized DOM. [derived: ECC's
   Plan Canvas — browser plan review with annotation and approval gates — is its strongest UX
   idea; its plan substrate underneath is plain markdown, weaker than the frozen-note pipeline
   here] When: annotate-and-wake round-trips visibly cost more than typing the edit would.

## Track 6 — boot honesty and task identity

Supervisor boot and task lifecycle give the operator too little signal. [derived: 2026-08-01 live
incident — `orc serve` sat pre-banner with a claimed-but-never-heartbeaten slot that `orc serve
status` reported STALE on a live pid]

1. **Cancelling a task must cancel its workflow** — *next.* A cancelled task leaves its in-flight
   DBOS workflow `PENDING`, and every later supervisor boot recovers it: the step re-executes (a
   real model call, real spend) and the boot blocks behind it until it settles. Measured
   2026-08-01: a workflow from 2026-07-30 — step `kernel-tools-and-wiring` of a task cancelled two
   days earlier, parked on an unanswered question — was still being resurrected on every start,
   and the operator saw only "supervisor booting" for minutes. `cancel` should cancel the DBOS
   workflow alongside the task, and recovery should skip workflows whose task is terminal.
   [derived: dbos.workflow_status PENDING row vs the task's cancelled status in the event log]
2. **Task creation is idempotent across the no-supervisor window** — *next.* One `orc new`
   yielded two identical tasks 73s apart when no supervisor was live (task_created 65717 +
   65723, 2026-08-01): the creation retried without an idempotency key, and both lineages ran —
   the duplicate spent real tokens before recovery fenced it. Key the creation (the events
   table already carries idempotency_key) so a retry lands on the same task.
3. **A fenced task points at its successor; timelines label foreign events** — *next (ui).*
   The operator watched the fenced duplicate's static chat while the live retry streamed on the
   sibling; a sibling's status line rendered unlabeled inside the wrong task's timeline. Fenced/
   superseded tasks link forward; cross-task lines name their task. [derived: 2026-08-01 live
   session — "nothing is moving" while everything was]
