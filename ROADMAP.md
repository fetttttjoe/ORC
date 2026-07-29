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

Both MCP directions are stdio-only today: `orc mcp serve` exposes 17 tools over stdio, and
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
2. **Parent-authored heals vs the child's restamp scope** — *open, edge.* The commit step restamps
   notes the CHILD subtree wrote; a heal authored by the parent's analyze step is outside that set.
   Immaterial while restamp only matters after a new commit (the parent's scout edits no files),
   but revisit if analyze-time heals start citing committed changes.
3. **Exec tool flakiness under agents** — *open, investigate.* A live run reported `grep`/`git grep`
   via exec intermittently returning 0 matches on lines that provably exist (fs_read/git show
   agreed). Reproduce, then fix or document. [sourced: task c5e9cb50 confirm-and-correct summary,
   2026-07-29]

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
