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
3. **`available_models` on the MCP door** — *next, small.* The serve door omits it (only the web
   copilot lists models), so MCP clients must guess a valid `modelRef` for `propose`/grounded
   `new_request`. List it read-only.
4. **Resources capability** — *open.* Expose read-only project state (status, plans, notes) as MCP
   resources so clients can subscribe rather than poll tools. When: a client actually wants
   subscription semantics.

## Track 3 — truthful-stamp pipeline follow-ups

1. **Split summary carries the audit verdict structurally** — *open.* The parent's split result
   takes the terminal step's summary, which is now the commit receipt; the verify verdict travels
   only because the commit contract says to carry it. Consider composing both terminal summaries
   into the split resolution. When: a parent visibly loses an audit verdict.
2. **Exec tool flakiness under agents** — *open, investigate.* A live run reported `grep`/`git grep`
   via exec intermittently returning 0 matches on lines that provably exist (fs_read/git show
   agreed). Reproduce, then fix or document. [sourced: task c5e9cb50 confirm-and-correct summary,
   2026-07-29]
3. **`orc memory rebuild` gains per-id accounting** — *next, small.* Rebuild is clear → replay →
   refresh with no post-replay check, and unparseable events are skipped rather than wedging the
   replay — so a silently broken projection reports success. [sourced:
   plugins/memory/src/projector.ts — rebuild()] After replay, diff projected note ids against the
   distinct non-tombstoned `memory_written` ids in the log; any unexplained absence warns and
   marks the rebuild degraded. Per-id accounting, not a count ratio — a ratio passes exactly when
   a few notes vanish. [derived: graphify's shrink guard, which refuses a rebuild unless every
   lost node is accounted for by a re-extracted source — github.com/Graphify-Labs/graphify]
4. **Memory reads fail loud on unknown filters** — *next, small.* `memory_search` with an unknown
   `category`/`tag` silently filters to an empty result indistinguishable from "no matching
   notes"; validate against the known sets and refuse naming them, the discipline
   `orc memory neighbors --kinds` already applies. Same pass: extend the absence note ("absence
   is not proof") to the two envelopes that lack it — `memory_read`'s `{note: null}` and keyed
   `memory_topics`. [sourced: plugins/memory/src/tools.ts — SearchInput, absenceNote call sites]
5. **Unknown drift is surfaced, not silently clean** — *next, small.* An unreachable
   `sourceRevision` yields null from the drift probe and reads as clean in every envelope and the
   step preload's currency line, so a reader cannot tell "checked, clean" from "could not check".
   Keep the fail-toward-not-drifted verdict (right for one tree) but surface `unknown` as its own
   state alongside `drifted`. The full verdict flip is already recorded under Track 1 (worktrees).
   [sourced: plugins/memory/src/drift.ts — createDriftProbe returns null on unreachable revisions,
   and noteDrifted folds null into "not drifted"]

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
   the plan-authoring skill (5.2); this item is the missing interaction layer. [derived: ECC's
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
