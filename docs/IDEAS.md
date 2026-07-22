# Idea bin

Deferred work with the reasoning intact. Nothing here is scheduled. An entry
graduates when a **trigger** fires — an observation from real use, not a
hunch. Entries that never trigger are the point: this file exists so a good
idea can wait without being rebuilt from scratch or shipped too early.

Format: what, why it was deferred, what would make it worth building, and any
design fixes already known so the eventual build starts from the corrected
version rather than the original sketch.

---

## 1. Neuron-like memory lifecycle (decay, sweep, archive, restore)

**Source:** `docs/superpowers/specs/2026-07-19-neuron-memory-web-research-design.md`
(full design, 19-slice plan) — deferred 2026-07-20 in favour of the four-slice
sourced-research plan.

**What it was:** notes and traversed links accumulate activation strength when
agents consume them, decay on a 30-day half-life while unused, drop out of
normal search/traversal when dormant, and become candidates for an explicit
depth-controlled sweep that retires them to a restorable Markdown archive.

**Why deferred:** `vault/memory/` held zero notes when the design was written,
in a repo four days old. Every constant in it — `halfLifeDays: 30`, the six cut
thresholds, the three routing floors — was a round number, not a measurement.
Fifteen of the nineteen slices were lifecycle machinery for a document pile
that had never been observed to grow.

**Trigger:** the knowledge graph reaches a size where an agent's `memory_search`
regularly returns stale or superseded notes ahead of current ones, *and*
`hits`/`lastAccessedAt` (shipped 2026-07-20, visible in `orc memory ls`) show a
clear split between hot and cold notes. Both halves matter: bloat alone argues
for better ranking, not deletion. Pick the half-life from the observed access
distribution, not from the original design's 30.

**How to measure that trigger honestly** (from `tirth8205/code-review-graph`,
reviewed 2026-07-20 — see entry 8): the obvious way to grade our ranker is
against the graph's own `supersedes` edges, and that is **circular** — it scores
the ranker against the same assertions the ranker consumes. Their
`impact_accuracy.py` reports circular and independent ground truth side by side
and labels the circular column `"graph-derived (circular — upper bound)"` in the
output itself. Ours would grade against an independent signal: which notes an
agent actually *read* versus which the ranker surfaced. Carry their bug as a
warning too — an error path that fell back to `predicted = set(changed)`
manufactured a perfect recall of 1.0; the fix records the row with
`status="error"` and excludes it from aggregates. A harness whose failure mode
is a perfect score is worse than no harness.

### Design fixes to apply if this is built

The original design has three problems worth carrying forward:

1. ~~**Do not derive traffic by parsing `tool_result` payloads.**~~ — **applied
   2026-07-20**, so the traffic signal is already in the shape this asks for.
   Kept below because the reasoning is what stops a future slice reverting it.
   The design
   reverse-parsed note identities and traversal paths back out of stored tool
   output to avoid "bloating history" with access events. The economics are
   backwards — an access payload is ~100 bytes against a `tool_result` that
   already stores the full note body — and it couples the model-facing response
   format to an internal projection: `budget.ts` blanks the note `id` under a
   tight budget, so the parser forces the tool output shape to protect a field
   it would otherwise be free to drop. Emit the access event from
   `tools.ts` `execute()`, the way the CLI path already does.

2. **Activation ranks, it does not filter.** Hiding notes from normal search
   below an activation floor means a note that is correct and legitimately
   untouched for 90 days disappears exactly when someone returns to that area.
   Context control already happens on the correct axis via `applyBudget` +
   relevance ranking. Use activation as a tiebreaker; this deletes
   `shallow|normal|deep` from search and neighbours entirely.

3. **Retirement must not orphan inbound links.** The design's guard keyed off
   *lane* activation, which only traversal reinforces — so three live notes can
   link to a candidate, and if nobody has walked those edges the lanes are cold
   and the note retires anyway. `applyEvent` drops incident links on delete,
   leaving those three notes with `links[]` entries pointing at a dead id, and
   the design's own non-goals forbid rewriting authored links to repair them.
   Protect on **authored inbound links from live notes** — a topology fact, not
   a traffic one.

**Also worth stating plainly if built:** with `research` as the only sweepable
class and "an agent rewrites it as durable" as the promotion path, this is not
garbage collection. It is a TTL on web research. That may be the right
behaviour, but the design should say so rather than frame it as collection.

---

## 2. ~~`retention: durable | expirable` on notes~~ — SHIPPED 2026-07-20

**Deferred here on 2026-07-20, then reversed the same day. The deferral was wrong.**

The original reasoning was "nothing reads the field until a sweep exists". That is the right
test for a *feature* with no consumer; it is the wrong test for **data capture that is only
possible at creation time**. `retention` is the authoring agent's judgment at write time, and
that is the only moment it exists. Deferring the field would have meant every note written
before the sweep shipped got retroactively defaulted to `durable` by the legacy decoder —
exactly backwards for research findings, and unrecoverable without re-reading and re-judging
every note. The sweep can wait; the label cannot.

Shipped with one change from the original design, which required `retention` explicitly on
every write (the source of that plan's 20-file churn): it **defaults to `durable`**. Same intent
captured, a fraction of the cost, and it fails safe — a note nobody classified is never
auto-deletable. `orc memory` and the vault frontmatter carry it; nothing branches on it until
entry 1 ships.

**Lesson worth keeping:** "no reader yet" justifies deferring behaviour, never deferring the
recording of a judgment that cannot be reconstructed later.

---

## 3. Scheduled / automatic memory maintenance

**Why deferred:** depends entirely on entry 1. The original design already
scoped scheduling out, and correctly: an unattended process that deletes
knowledge should not be the first version of anything.

**Trigger:** entry 1 has shipped and a human has run `--apply` enough times to
be bored by it. Keep the policy in the lifecycle service so the scheduler is an
adapter, never a second copy of the rules.

---

## 4. MCP grants bind the process, not the tool surface

**Source:** repo-wide audit 2026-07-20. Split out of
`docs/superpowers/plans/2026-07-20-system-hardening.md`.

`mcpFingerprint` (`trust.ts:25-28`) covers `command`, `args`, and env
names/values — the *invocation*, not what the server exposes. `refValidator`
checks only that the server is declared and trusted; it never checks that the
referenced tool existed when consent was given, and `mcp-client/src/index.ts:67`
honours `list_changed` by clearing the cache, so a newly advertised tool is
usable immediately. A user who trusts `npx -y notes-mcp` has pinned nothing:
`npx` re-resolves the latest release on every spawn.

**Why deferred:** `ApprovalPolicy.default` is `'manual'` (`approval.ts:12`), so
a human reviews the plan containing any new tool ref before it executes. The gap
between the stated boundary and the code is real, but not silently exploitable
under default policy. Closing it properly (~30 lines plus a CLI flow change)
means `orc mcp trust` spawns the server, calls `listTools`, and folds the sorted
tool names and schemas into the fingerprint — which makes granting trust require
a working server, a real UX cost.

**Trigger:** anyone runs with an `auto` approval rule that can match a
`task_split` (which self-approves at `kernel.ts:147-152`), or a first
non-developer user installs a third-party MCP server. Either removes the human
review that currently carries this.

---

## 5. `index.md` re-renders every note body on every memory event

**Source:** repo-wide audit 2026-07-20.

`projector.refreshIndex()` calls `surreal.allNotes()` — every row, every field,
`body` up to 100 KB — after each accepted memory event, to regenerate one file
containing a node and a `click` line per note.

**Why deferred:** invisible at present scale (the vault holds zero notes). At
600 notes averaging 20 KB, a step writing 40 notes triggers 40 full-table reads
(~480 MB transferred), and the resulting graph exceeds mermaid's default
`maxEdges` of 500 — Obsidian renders "Maximum number of edges exceeded" instead
of the graph, so the index breaks at exactly the scale where it matters.

**Trigger:** the graph passes ~200 notes, or a `bun test` run gets measurably
slower in the memory projector tests. Fix is ~3-6 lines: project the select down
to `noteId/scope/title/kind/links`, and refresh on the drain's existing
`applied > 0` batch boundary rather than per event.

---

## 6. ~~Test-helper connection pools are never closed~~ — FIXED 2026-07-20

Fixed at the shared seam rather than per test file. `createTestDb` now returns a handle with
`onClose(fn)`, and `drop()` runs registered closers LIFO **before** dropping the database. The
leak was structural: the helper handed out a URL and had no idea who opened pools against it, so
`DROP DATABASE ... WITH (FORCE)` terminated live backends as its routine mechanism — which is
where "terminating connection due to administrator command" and "event stream reconnect failed:
database does not exist" came from. FORCE is now a backstop for a wedged backend, not the path.

Adopted in `freshKernel` and both `makeCli` helpers plus three inline sites, which covers the
bulk of the 86 storage-opening call sites because most route through those three helpers.

**Measured:** peak Postgres connections during a full `bun test` went **38 → 15** of 100. Suite
unchanged at 0 failures.

Fixed alongside it, in production code: `EventLog.subscribe`'s disposer removed the `notification`
listener but left the `error` listener talking, so a subscription that was already closed could
still print a warning after the user's command finished. The handler must stay attached (an
`error` event with no listener crashes the process) but now guards on `closed`, matching what the
`end` handler already did.

**Not silenced, deliberately:** `storage.subscribe.test.ts` still prints one
`terminating connection due to administrator command`. That test calls `pg_terminate_backend` on
the listener on purpose to prove the reconnect path works; the warning is the behavior under test.

---

## 7. `buildRuntime` leaks the projector and Surreal socket on a construction throw

**Source:** repo-wide audit 2026-07-20.

`runtime.ts:48-60` starts the vault projector and opens memory before
constructing the port at `:62-86`. If `createDbosPort` or `port.launch()`
throws, neither `projector.close()` nor `memory.close()` runs, and `bin.ts`
cannot clean up either — `runtime.port ??= await buildRuntime(...)` never
assigns on a throw, so the `finally` at `bin.ts:70` only shuts down `host`/`hub`.

**Why deferred:** `bin.ts:89` always calls `process.exit(exitCode)`, which
force-kills the pg LISTEN client and the Surreal websocket, so practical impact
for the CLI is zero. It matters only for `buildRuntime`'s other callers
(`runtime.test.ts:73`) and any embedder.

**Trigger:** anything embeds the runtime in a long-lived process rather than a
one-shot CLI. Fix is ~6 lines: wrap the port construction in `try`/`catch` that
closes `memory` and `projector` before rethrowing.

---

## 8. Techniques banked from `tirth8205/code-review-graph`

Reviewed 2026-07-20. A Python CLI + MCP server that Tree-sitter-parses a repo
into a SQLite graph of code symbols and answers "what does this change affect?"
so an agent reads a blast-radius subset instead of the whole repo. Real and
active (713 commits, MIT, ~40% test-to-source ratio by volume), though velocity
outruns review in places and its 21.7k stars sit against only 72 watchers.

**Almost nothing transfers, for a structural reason worth recording.** Its graph
is *derived* from source, so it must re-derive on every edit — hence 48 KB of
incremental mtime/hash reconciliation against a mutable store. Ours is
*authored* and projected from an append-only log through an event cursor:
incremental by construction, rebuildable from truth, disposable by design. Their
hardest engineering problem is one our architecture does not have. Equally, the
bulk of the repo (community detection, betweenness centrality, hub/surprise
scoring, FTS5, embeddings) answers questions of *scale* against a graph that for
us currently holds zero notes — and every constant in it is an uncalibrated
round number, which is the exact failure `IDEAS` entry 1 already caught in our
own deferred design. Adopting it would import the mistake we caught ourselves
making.

Three things worth keeping:

1. **Honest dual-mode evaluation** — folded into entry 1's trigger above.
2. **Reciprocal Rank Fusion.** Merge N ranked lists by summing `1/(60 + rank)`.
   Eight lines, no dependency, and it uses only ordinal position — so a
   substring-relevance rank and a graph-distance rank fuse without being
   commensurable. TRIGGER ARMED 2026-07-22: `surreal.ts` `search()` now ranks
   by field-weighted term relevance (+ durable-scope boost) with recency as
   tie-break only — the second ranking signal exists, so RRF graduates the
   moment search relevance and graph distance need combining in one result
   (e.g. neighbors-aware search). Until a call site wants the fusion, hold.
3. **Calibrate the estimator, never replace it.** `budget.ts`'s `approxTokens`
   is chars/4 with a ponytail comment saying "swap for a real tokenizer only if
   it misbudgets". Their pattern is strictly better: keep chars/4 in the hot
   path permanently and check it offline against a real tokenizer, so the
   dependency stays in dev and the runtime stays free.

**Explicitly rejected:** query-shape kind boosting (relies on code casing
conventions; our notes are prose), `context_savings` metadata (spends tokens
telling the model about tokens it did not spend), risk scoring and surprise
scoring (uncalibrated additive constants for a domain we do not have), and
`install`-style editor auto-detection that writes MCP config into Cursor/Claude
Code. That last one is the direct inverse of our posture — declaration in
`.orc/config.json`, consent in `.orc/trust.json`, grants bound to a fingerprint,
`orc mcp trust` an explicit human act. Their convenience is our threat model;
worth remembering only as a thing to keep not doing.

---

## 9. First-class rule notes with a violation trail

**Source:** knowledge-graph optimization session, 2026-07-22.

**What it is:** `'rule'` as a new `NOTE_KIND` — project rules become
addressable graph nodes agents actually see, proposed by a small
"architect" model from project settings/instructions but **human-approved
before they bind** (same gate philosophy as plans). A violation is itself a
note linking `contradicts → rule-x` with the reason in the body and
`retention: expirable`, so agents can ask "was this tried and rejected?"
before re-litigating, and the trail can be swept.

**Why deferred:** waiting on the graph-refresh run and bench results first;
and a rule without enforcement is decoration.

**Design fixes already known:**

1. The per-note `rules[]` field is dead weight today — stored, rendered,
   token-budgeted, never injected into any agent prompt. Fold it into rule-note
   bodies when this ships; two homes for rules is worse than either.
2. Reuse, don't invent: `contradicts` covers the violation edge, `expirable`
   covers the trail's lifecycle. No new link kind, no new retention class.
3. Three enforcement tiers, each with existing precedent: code-enforced (the
   zone write-fence — executor refuses), auditor-checked (the `verify` step
   receives rule notes in its prompt and is the one writer of violation notes —
   never self-reporting agents), advisory (top-N relevant rules pushed into
   step prompts; an agent will not search for the rule it is about to break).

**Trigger:** an agent repeats an approach a human already rejected, or a bench
probe like `"what rules govern fs writes"` exists and fails.

---

## 10. Knowledge zones: per-agent note ownership for parallel subplans

**Source:** knowledge-graph optimization session, 2026-07-22 — while watching
the graph-refresh plan solve this by hand.

**What it is:** the memory analog of the file write-fence. A plan-note declares
which note ids/prefixes its subplan OWNS (`noteZone`, mirroring `zone`); the
freezer carries it into the step; the memory store refuses writes outside it.
Parallel subplans then get mechanically disjoint knowledge spaces — per-topic
sub-graphs each agent maintains alone — instead of disjointness by prose
convention. A librarian-style read surface ("what do we already know about X,
who owns it") is the query half: agents ask before researching, so no topic is
re-derived twice.

**Why deferred:** the convention already works (the refresh plan's ownership
map had zero collisions), merge-on-omit removed the worst clobber class, and
the search-first rule in the codebase-analysis skill covers the ask-before-
research half for free. Enforcement is only worth building when convention is
observed to fail.

**Design fixes already known:**

1. Reuse the zone machinery end-to-end (contracts field → freezer copy → store
   fence) — same shape, same tests, different resource.
2. The read surface is memory_search + the hub, not a new service: if agents
   cannot find a topic, fix ranking/summaries, don't add an oracle in front.
3. Cross-scope: ownership binds WRITES; reads stay global — a fence that
   blocks reading another subplan's findings would defeat the graph.

**Trigger:** two parallel subplans write the same note id in one run, or a
scout re-derives a topic an existing note already covered (contamination-check
style audit can detect both from the event log).
