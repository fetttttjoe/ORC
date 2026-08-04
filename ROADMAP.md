# Roadmap

Forward-looking work, in intended order within each track. Entries state what would make them
worth starting ("when"), so a deferral is a decision, not a blind spot. Statuses: **next** (agreed,
unstarted), **deferred** (designed, waiting on its trigger), **open** (problem known, design open).

## Track 1 — team-scale concurrency (the shared-tree ceiling)

Today every task executes in one shared working tree. Task-attributed floors + pathspec commits
make DISJOINT concurrent tasks compose; OVERLAPPING tasks still serialize by hand. [derived:
2026-07-29 live pipeline run — a task's commit stages only its own recorded paths]

1. **Zone-aware admission** — *next.* Refuse or queue a task whose zones overlap a RUNNING task's
   zones; the same overlap rule `validatePlan` applies within one plan, lifted to admission. Makes
   single-tree mode team-tolerable with a small kernel change. When: before any second concurrent
   writer becomes routine.
2. **Worktree isolation tier** — *deferred (designed).* Implement `ISOLATION_TIER.worktree` (the
   enum already exists in contracts; frozen plans stamp `local` today): each task runs in its own
   `git worktree` with its own HEAD; the commit step commits on the task's branch.
   When: more than one person (or overlap-heavy concurrent tasks) drives the repo.
3. **PR-shaped integration** — *deferred.* On top of worktrees: the commit step pushes a branch
   instead of committing mainline; the verify auditor becomes pre-review, a human PR review the
   final gate. When: track 1.2 lands and a team exists to review.

### Knowledge graph across worktrees (design decision, recorded)

Rejected: forking the graph per worktree and merging on backport — knowledge prose does not merge
like code (a semantic merge arbiter's failure mode is a confident, unflagged lie); forking the
read model while writes land in the one log is a view filter, not a fork; and a hard fork
quarantines the commons (conventions, measured findings) along with the speculative subset.

Adopted shape, when 1.2 lands:
- One log, one graph. A worktree task's path-citing writes land in a task/branch **lane** (the
  existing `taskLaneScopes` pattern); other worktrees see them flagged or not at all.
- **Reader-relative currency**: drift/grounding probes run against the reader's own worktree —
  `createGroundingSource({store, dir})` is already dir-parameterized.
- **Integration = promote, not merge**: after backport, lane notes are re-verified against
  mainline and re-written into project scope via the ordinary same-id merge-on-omit write (the
  commit step's verify-then-stamp shape). Colliding heals surface as sequential writes and
  reconcile through the normal heal loop against the merged tree.
- **Required default flip**: `plugins/memory/src/drift.ts` treats an unreachable sourceRevision as
  "unknown, never drifted" — right for one tree, wrong across worktrees, where unreachable means
  "another branch" and must read NOT current for this reader. Must flip with 1.2 or worktrees
  silently trust other branches' facts.

## Track 2 — MCP surface (easier to consume)

Both MCP directions are stdio-only today: `orc mcp serve` exposes 18 tools over stdio, and
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
3. **Resources capability** — *open.* Expose read-only project state (status, plans, notes) as MCP
   resources so clients can subscribe rather than poll tools. When: a client actually wants
   subscription semantics.

## Track 3 — truthful-stamp pipeline follow-ups

1. **Split summary carries the audit verdict structurally** — *open.* The parent's split result
   takes the terminal step's summary, which is now the commit receipt; the verify verdict travels
   only because the commit contract says to carry it. Consider composing both terminal summaries
   into the split resolution. When: a parent visibly loses an audit verdict.
2. **Exec tool quoting: multi-word arguments are split on whitespace** — *open, root-caused.* The
   2026-07-29 "grep flakiness" is not intermittent: exec tokenizes the command string by
   whitespace with no shell quoting, so any quoted multi-word pattern (`grep "run finished" f`)
   becomes three arguments and matches nothing — single-word patterns work. [derived: three
   independent reproductions 2026-07-31 — two grounding scouts and one heal auditor each confirmed
   fs_read-present/grep-absent on multi-word patterns only] Fix or document: either real
   shell-quote parsing in the exec tokenizer, or a tool-description warning telling agents to use
   single-word patterns and fs_read for exact strings.
3. **A falsely-done task has no repair path** — *open.* `plan-revise`/`plan-note` refuse on
   status `done` (only `blocked` admits repair), so a task that terminated wrongly-successful —
   e.g. the empty split above — cannot be corrected in place; the whole grounding is re-bought.
   [sourced: kernel's editPlan from-status guard; live failure 2026-07-31 — "cannot annotate a
   plan while task is 'done'"] Either admit `done` into the repair path behind an explicit
   operator flag, or let a terminal task be reopened to `blocked`. When: the next wrongly-done
   terminal state — the empty-split gate (landed 79303eb, 2026-08-01) removes the known
   producer, but any step that lies about success recreates it.
4. **Outcome notes consolidate before the execution child finishes** — *open.* Root-task
   consolidation fires at root-done, which precedes the spawned execution child's completion, so
   durable outcome notes freeze mid-flight claims — two consecutive tasks' notes carry
   "implementation sub-task did not finish" while the sub-task went on to land its commit.
   [sourced: outcome-orc-memory-rebuild-gains-per-id-accounting and
   outcome-scout-asks-permission-only-when-a-wholesale-re-map-is-on, both 2026-07-31; the latter's
   implementation shipped as 2eeec6b] Defer consolidation to pipeline end, or update the outcome
   note on child completion. Outcome notes carry no sources, so nothing ever flags them stale.

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
- **Incremental topic repartition** — whole-corpus repartition outgrew the claim corpus (the
  measured slow stage is refreshLinks I/O, not partition()). When: the >1s refresh warning becomes
  routine again.
- **Retrieval negatives** — the weakest bench axis: the system still answers questions the corpus
  cannot answer. Bench-driven; measure before/after on both probe sets.

## Track 5 — roles and skills as operator-editable documents

Skills are force-loaded per step by ref and hash-audited via `skill_loaded` events; the per-role
contracts (auditor/heal/commit) are kernel constants inlined at the freeze, invisible to the
operator. [sourced: packages/kernel/src/plugins/skills.ts,
packages/kernel/src/execution/strategies/grounded-plan.ts] Direction borrowed from ECC's
agents-and-skills-as-markdown surface, mapped onto the existing loader rather than ported.
[sourced: github.com/affaan-m/ECC]

1. **Role contracts become shipped skills** — *next (designed).* `role-auditor` (absorbs the
   auditor + heal contracts verbatim) and `role-committer` (the commit contract) join
   `SHIPPED_SKILLS`; the freeze appends the role skillRef, deduped — position-gated exactly as
   the constants were (verify step / commit step), still un-authorable by the planner — and the
   constants are deleted. Accepted trade: the contract prose leaves the plan-hash-approved
   artifact and is audited by `skill_loaded` content hashes instead; a vault missing a role
   skill refuses `finalize_plan` with a message naming `orc init`.
2. **Plan-authoring gains the plan-done bar** — *next (designed).* Three STRUCTURE RULES: a
   measure-then-decide subplan must order before what it gates, never beside it; a verify never
   *uses* a step-tool its own task introduces (test it as code — the plan-level mitigation of
   the Track 4 verify/step-tool item); every subplan states a verifiable success criterion and
   names its check. [derived: two live-run findings — a measure subplan ran wave-parallel to the
   build it should have gated; a verify called a just-built step-tool the supervisor never
   loaded — plus the done-bar of ECC's planner agent]
3. **Agent-elective skill consumption** — *open.* `skill_search`/`skill_load` step-tools so an
   agent can pull a skill mid-run (bounded pulls, the KNOWLEDGE_PROTOCOL stance); read a skill's
   `references/` subdirectory (today only the SKILL.md body injects); tolerate third-party
   frontmatter (unknown keys are hard validation errors today, so external skill packs need
   trimming before they drop into `vault/skills/`). When: a plan step cannot know at authoring
   time which skill it needs, or the skill set outgrows force-loading.
4. **Boundary contracts consolidation** — *next (designed).* Runtime blame with compile-like
   placement, round-wide: one plan-field rule table (shape = refused at the producing
   memory_write itself; judgment = warn, human decides) driving write + validatePlan from one
   source; one `degraded` absent-measurement convention across tool outputs; verification as a
   first-class note stamp (`verified{revision,at,by}`, `memory_verify`) replacing
   authorship-inference in restamp/stillDrifted; then zones as `@area` references resolved at
   the freeze (registry = the drift-checked area notes; feeds Track 1.1); then a UI-parity sweep
   (edit-on-blocked reachable, subtree questions surfaced via openFeedbackInSubtree, terminal
   tasks never offer an answer box). Named frontier deliberately out: `depOutputs` are the one
   uncontracted agent→agent boundary. [derived: five incident-driven slices on 2026-07-30
   accreting per-incident fixes — this round consolidates them into one boundary story]
5. **Interactive plan canvas** — *open.* Today the human reviews the rendered plan and revises it
   only by annotating and waking the plan agent; there is no direct manipulation. A browser plan
   canvas (graph-ui or a dedicated view) would let the human edit subplans in place — reorder
   `dependsOn`, adjust `zone` globs, swap `modelRef`, rewrite requirements — with each edit
   written as an ordinary plan-note through the one mutation surface, so the approval gate, the
   changed-since-approval refusal, and the deterministic freeze all apply to human edits exactly
   as they do to agent edits. The planner's prose behavior is already operator-configurable via
   the plan-authoring skill (5.2); this item is the missing interaction layer. Its precondition is
   met — the console is Svelte 5 + shadcn-svelte with a query cache, so a canvas is components and
   mutations rather than hand-synchronized DOM. [derived: ECC's
   Plan Canvas — browser plan review with annotation and approval gates — is its strongest UX
   idea; its plan substrate underneath is plain markdown, weaker than the frozen-note pipeline
   here] When: annotate-and-wake round-trips visibly cost more than typing the edit would.

## Track 6 — memory learns from use

Notes record *access* (hits, activation decay) but not *outcome*: nothing distinguishes a note
that answered a step from one that wasted it, so dead ends get re-derived and the only quality
signals are author estimate and the auditor's verify stamp. [sourced:
packages/contracts/src/memory.ts — activation; plugins/memory/src/store.ts — recordAccess]
Direction borrowed from graphify's deterministic learning loop (outcome-tagged use records →
LLM-free aggregation with half-life decay → display-only verdicts), mapped onto the event log
rather than ported. [sourced: github.com/Graphify-Labs/graphify — save-result/reflect]

1. **Outcome events → derived use-verdicts** — *deferred (designed).* A use-outcome event
   (`useful | dead_end`; a correction is a heal or a `supersedes`/`contradicts` link, never a
   score) appended by the store beside `memory_written`; a pure derivation folds outcomes with
   half-life decay and a ≥2-record corroboration floor into `preferred / tentative / contested`,
   contested always showing both counts, never a net. Verdicts surface in read envelopes the way
   `drifted` does and **never enter rank scoring**: the bounded activation boost already occupies
   the use→rank channel, and an unbounded verdict loop (returned → used → marked useful → ranked
   up → returned) needs propensity correction nobody has — graphify defers it for exactly this
   reason. Design out its three measured defects: caps the aggregator can't see, full weight for
   undated records, corrections double-counted as score and provenance. An outcome record is
   evidence, never a verification — `memory_verify` stays auditor-gated. When: a live run
   re-derives a dead end memory already recorded, or note-count growth outpaces what verify
   stamps alone can triage.
2. **Lessons ride the step preload** — *deferred.* Derive a small lessons block (top dead ends,
   contested notes) from 6.1's events, watermark-gated so an already-fresh derivation costs
   nothing, injected beside the preload's currency line. When: 6.1 lands.

## Track 7 — projection cost and boot honesty

A read-model rebuild re-embeds every `memory_written` event through the configured embedder, and
the supervisor boots behind that drain with no signal. [derived: 2026-08-01 live incident — a
Docker restart of the then-in-memory SurrealDB forced a full 65,728-event replay; four concurrent
processes raced the shared cursor, wall time per embed rose from 88ms warm/solo to 7–13s, drain
throughput fell to ~2.5 events/min, and `orc serve` sat pre-banner with a claimed-but-never-
heartbeaten slot that `orc serve status` reported STALE on a live pid]

1. **One projector at a time** — *next.* Catch-up across processes is unfenced: applyEvent's
   transaction dedupes the write, but every racer pays the embedding before losing the race
   (embeds are computed outside the transaction by design). Add a cross-process advisory lock
   around catch-up (the runtime-lock pattern, scoped to projection) so CLI one-shots and servers
   defer to a live drainer instead of multiplying embedder load.
2. **Embeddings survive replay** — *open.* An embedding is a pure function of (model, text);
   re-buying 376 notes' vectors from a CPU embedder on every rebuild is the single dominant
   rebuild cost. Either persist vectors beside the log keyed by content hash, or accept rocksdb
   persistence (landed 2026-08-01) as sufficient until the next forced rebuild. When: the next
   `orc memory rebuild` visibly hurts.
3. **Cancelling a task must cancel its workflow** — *next.* A cancelled task leaves its in-flight
   DBOS workflow `PENDING`, and every later supervisor boot recovers it: the step re-executes (a
   real model call, real spend) and the boot blocks behind it until it settles. Measured
   2026-08-01: a workflow from 2026-07-30 — step `kernel-tools-and-wiring` of a task cancelled two
   days earlier, parked on an unanswered question — was still being resurrected on every start,
   and the operator saw only "supervisor booting" for minutes. `cancel` should cancel the DBOS
   workflow alongside the task, and recovery should skip workflows whose task is terminal.
   [derived: dbos.workflow_status PENDING row vs the task's cancelled status in the event log]
4. **A grounded task refuses to run on a degraded memory tier** — *next.* runtime.ts degrades
   memory to unavailable and continues — right for read-mostly commands, wrong for a
   grounded-plan run whose entire deliverable is plan-notes: it admitted and drove analyze+plan
   to guaranteed failure ($1.64, zero notes written, blocked). Gate at admission or first
   memory_write refusal, and re-probe the memory handle instead of freezing "unavailable" for
   the process lifetime — the DB was healthy again minutes into the doomed run. [derived:
   2026-08-01 task 989fabea — "namespace 'orc' does not exist" on every memory call while
   SurrealDB was being re-seeded]
5. **Task creation is idempotent across the no-supervisor window** — *next.* One `orc new`
   yielded two identical tasks 73s apart when no supervisor was live (task_created 65717 +
   65723, 2026-08-01): the creation retried without an idempotency key, and both lineages ran —
   the duplicate spent real tokens before recovery fenced it. Key the creation (the events
   table already carries idempotency_key) so a retry lands on the same task.
6. **A fenced task points at its successor; timelines label foreign events** — *next (ui).*
   The operator watched the fenced duplicate's static chat while the live retry streamed on the
   sibling; a sibling's status line rendered unlabeled inside the wrong task's timeline. Fenced/
   superseded tasks link forward; cross-task lines name their task. [derived: 2026-08-01 live
   session — "nothing is moving" while everything was]
7. **`catching_up` names its magnitude** — *next, small.* The health line counts memory-kind
   events past the cursor; mid-rebuild it read "~350" while the cursor was 14,700 seqs behind
   head. Say "rebuilding from seq K of H" when the gap spans more than one session, so an
   operator can tell seconds-behind from rebuilding-the-world.
