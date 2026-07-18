# M4c — Memory Graph / Recursive-MAS Substrate Design Specification

**Date:** 2026-07-19
**Status:** Proposed design, pre-implementation
**Amends:** `2026-07-18-m4b-knowledge-graph-memory-design.md` (§6 note format, D6 pull-keyword-now,
§11 what-this-unlocks); builds on everything M4b shipped.
**Milestone:** M4c. M5 (recursion/strategies) consumes what this builds.
**Source ideas:** `docs/superpowers/research/code-review-graph.md` (code-review-graph + RecursiveMAS
synthesis). Every idea below is tagged **cheap-now** / **contract-change** / **deferred** and cited
to that note's section.

---

## 1. Goal

M4b shipped a persistent, event-sourced, CQRS knowledge graph: agents `memory_write` notes; later
steps/tasks `memory_search`/`memory_read` them. Its "graph" is a **flat `links: id[]`** field — a
bag of untyped pointers. M4c makes the graph *earn its name*: give links a **type** and a
**confidence**, model them as real SurrealDB `RELATE` edges, and add the two things a graph is for —
**traversal** (`memory_neighbors`, a blast-radius pull) and a **graph-distance relevance ranker**
(the interim relevance signal while vectors stay deferred). Wrapped around all of it: **token-budgeted
tool results** so pulling memory never blows a sub-agent's context — the whole reason the memory
subsystem exists.

The larger frame (research §"Synthesis"): the typed-link note graph becomes the **shared context
substrate a recursive multi-agent system traverses on demand**. Each sub-agent binds a bounded slice
by traversing typed links from its seed notes — *context-by-traversal, not context-by-compaction*.
M4c ships the **pull primitives** that make that substrate real; the automatic step-boundary binding
of a slice is push and stays deferred (§10).

This is additive over M4b: the event log is still the only truth; SurrealDB and `vault/memory/**`
are still disposable projections rebuilt from the log. Nothing here changes those invariants — it
adds a typed edge to the note contract and a derived edge index + traversal to the read model.

## 2. Scope

**In (contract-change):**
- Typed + confidence-weighted links: `links: { id, kind, confidence? }[]` replacing `id[]`, with a
  **backward-compatible coercion** so every historical flat-string link event still replays
  (§6, D1). This is the one contract change; it flows into the `memory_written` payload for free
  (`events.ts` payload already references `MemoryNoteInput`).
- `MemoryStore.neighbors(...)` on the gateway interface + a `NeighborResult` summary shape.
- A `memory_neighbors` pull tool (the traverse / blast-radius tool).
- `detail_level` + budget fields on `memory_search` / `memory_read` results.

**In (cheap-now — no contract impact):**
- SurrealDB `RELATE` edge materialization in the projector (a **derived index**, rebuilt on replay).
- Pure graph-distance ranker (`rank.ts`) — per-edge-kind weight × depth-decay, floor, cap.
- Token-budget result shaping (pure `budget.ts` helper) on the pull tools.
- Vault-render delta: typed links in `vault/memory/**` frontmatter.

**Out (deferred — unchanged from M4b, restated so nobody re-adds them):** embeddings / vector
retrieval / semantic search (research §4 "Embeddings"; the RRF slot in §7 stays a slot); **push /
auto-inject / step-boundary auto-binding** of a context slice (research §4 "Push"; M4c is pull-only);
RecursiveMAS's actual mechanism — latent hidden-state exchange, `CrossModelAdapter`, Inner-Outer
co-training (research §"RecursiveMAS", §4 RecursiveMAS-specific); bidirectional vault editing;
private-per-run scopes; a web GUI; heavy graph algorithms (Leiden/centrality — research §4, our
graph is hand-authored and small); auto-deriving the graph from AST (research §4, that is a code map,
a different product).

## 3. Requirements captured

Carrying M4b's RM1–RM7 unchanged, adding:

- **RG1** Links carry the relationship the author already knew when they wrote them: a `kind`
  (`refines/supersedes/contradicts/depends_on/example_of/derived_from/relates_to`) and an optional
  `confidence` (research §3.1, §3.4). A flat id array throws that knowledge away.
- **RG2** Migration is free under CQRS: no log rewrite. Old flat-string link events replay as
  `kind: 'relates_to'` because the contract *coerces* them; only the read model (SurrealDB edges,
  vault markdown) is rebuilt (research §5.2, §4 "SQLite as store-of-record" — the pain we avoid).
- **RG3** Traversal answers "the notes that constrain this task": from seed notes, walk typed links
  N hops, ranked by (edge-kind weight × decay^depth), pruned at a floor, capped (research §3.2 —
  code-review-graph's `get_impact_radius`). No embeddings.
- **RG4** Reverse reachability: "what *supersedes / contradicts* this note" must be a cheap query,
  not a full scan. This is why edges are materialized as `RELATE`, not read only off the note's own
  out-link field (§4.2, D3).
- **RG5** Pulling memory is bounded: every pull tool returns at most a budget of tokens, a
  `truncated` flag, an exact omitted count, and a next-tool suggestion (research §3.3, §2 "Result
  shaping"). Memory is never on an agent's critical path *and* never floods its context.
- **RG6** The graph is the recursive-MAS substrate: a sub-agent's context slice is a traversal from
  its seed notes, pulled via `memory_neighbors`, not a compacting inherited conversation (research
  §"Synthesis"). M4c ships the pull tool; the runtime auto-binding is deferred.

## 4. Architecture

No new packages. All deltas land in the M4b files, plus two small **pure** modules
(`rank.ts`, `budget.ts`) that keep the graph-scoring and token-shaping logic DB-free and trivially
testable.

```
packages/contracts/src/
└── memory.ts        # links: id[] → { id, kind, confidence? }[] (coerces legacy strings);
                     #   LINK_KINDS/LinkKind/MemoryLink; MemoryStore.neighbors; NeighborResult
                     # events.ts unchanged — its memory_written payload already refs MemoryNoteInput

plugins/memory/src/
├── rank.ts          # NEW pure: DEFAULT_LINK_WEIGHTS + rankNeighbors(edges, seeds, opts)   (no DB)
├── budget.ts        # NEW pure: approxTokens + applyBudget(items, {limit, budget})          (no DB)
├── surreal.ts       # links stored typed; RELATE edge materialization; neighbors() traversal
├── note-md.ts       # frontmatter renders typed links (kind + confidence)
├── store.ts         # + neighbors() delegating to surreal
├── tools.ts         # + memory_neighbors; detail_level/budget on memory_search / memory_read
└── index.ts         # buildTools now includes memory_neighbors
```

### 4.1 The typed link (the contract change)

```ts
export const LINK_KINDS = [
  'refines', 'supersedes', 'contradicts', 'depends_on',
  'example_of', 'derived_from', 'relates_to',
] as const
export const LinkKind = z.enum(LINK_KINDS)

const MemoryLink = z.object({
  id: Id,
  kind: LinkKind.default('relates_to'),
  confidence: z.number().min(0).max(1).optional(),   // absent ⇒ treated as 1.0 by the ranker
})

// Backward-compatible: a bare string id (every M4b event) coerces to relates_to.
const LinkInput = z.union([
  z.string().regex(MEMORY_ID_RE).transform(id => ({ id, kind: 'relates_to' as const })),
  MemoryLink,
])

// in MemoryNoteInput:
links: z.array(LinkInput).default([]),
```

This is the whole migration. The `memory_written` payload is `{ note: MemoryNoteInput, author }`
(`events.ts:85`) — changing `MemoryNoteInput.links` changes the payload with no `events.ts` edit.
The projector re-parses every replayed event through `MemoryNoteInput.parse` (`projector.ts:18`), so
a v1 event carrying `links: ['session-model']` parses to `links: [{ id: 'session-model', kind:
'relates_to' }]` on the next rebuild — automatically, for free, no data migration on the log.

### 4.2 Read-model edges (SurrealDB RELATE — cheap-now, derived)

Today `surreal.ts` stores `links` as a `t.array(t.string())` field on the `note` document and does
no traversal. M4c keeps the note's own links **on the document** (they are part of the authored
snapshot — `get()` and the vault renderer need them) *and* materializes them as `RELATE` graph edges
so traversal — especially **reverse** traversal (RG4) — is a native query, not a table scan.

The projector's single-writer discipline makes this deterministic on replay:

- **`applyWritten`:** upsert the note doc (now with typed `links`), then re-materialize this note's
  **out-edges**: `DELETE link WHERE in = note:<from>`, then for each link
  `RELATE note:<from> -> link -> note:<to> SET kind = …, confidence = …`. Delete-then-relate is
  idempotent and replay-identical.
- **`applyDeleted`:** delete the note doc, its out-edges (`in = note:<id>`) **and** its in-edges
  (`out = note:<id>`), so no dangling edges survive a tombstone.
- **`clear` / `rebuild`:** drop the `link` table alongside `note`/`meta`; a full log replay rebuilds
  every edge. Edges are a projection, never truth (M4b RM4/D1 hold).

`neighbors()` fetches edges frontier-by-frontier from Surreal and hands them to the pure `rank.ts`
scorer (§4.3) — the weighted best-score relaxation is far clearer in TS than in SurrealQL, and the
hand-authored graph is small (research §4 "Heavy graph algorithms" — premature to push scoring into
the DB). SurrealDB does the cheap part (fetch typed edges, both directions); TS does the scoring.

### 4.3 Graph-distance ranker (`rank.ts` — pure, cheap-now)

A direct port of code-review-graph's `get_impact_radius` (research §2, §3.2): bounded best-score
relaxation over the edge graph.

```ts
export const DEFAULT_LINK_WEIGHTS: Record<LinkKind, number> = {
  supersedes: 1.0, contradicts: 1.0, refines: 0.9, depends_on: 0.8,
  derived_from: 0.7, example_of: 0.6, relates_to: 0.5,        // default 0.5
}
export const DEFAULT_DECAY = 0.6   // score *= 0.6 per hop  (CRG_IMPACT_DEPTH_DECAY)
export const DEFAULT_FLOOR = 0.05  // prune below this      (CRG_IMPACT_SCORE_FLOOR)
export const DEFAULT_CAP   = 20    // max neighbours returned

// score(node) = max over reaching paths of  Π(weight(kind) × confidence) × decay^depth
export function rankNeighbors(
  edges: Edge[], seeds: string[],
  opts?: { depth?; decay?; floor?; cap?; weights?; kinds? },
): NeighborResult[]
```

Best-score (not sum): a node's relevance is its strongest path from any seed. `confidence` (default
1.0) multiplies the edge weight, so an `AMBIGUOUS`/low-confidence link is down-weighted, never
auto-honored (research §3.4). Weights live as a `DEFAULT_*` const (house-rule defaults-in-code);
making them config-overridable is an open question (§9), not v1.

### 4.4 Token-budgeted results (`budget.ts` + tool deltas — cheap-now)

`budget.ts` is ~15 lines of pure helper:

```ts
export const approxTokens = (s: string) => Math.ceil(s.length / 4)   // ponytail: chars/4 heuristic
export function applyBudget<T>(items: T[], text: (t: T) => string,
  opts: { limit: number; budget: number }): { items: T[]; truncated: boolean; omitted: number }
```

Applied to the three pull tools (research §3.3), mirroring code-review-graph's `minimal`/`standard`:

- **`memory_search`** gains `detail_level: 'minimal' | 'standard'` (default `standard`) + `limit`.
  `minimal` = top-N summaries (default 5) + `truncated` + `omitted` count + `next` suggestion
  ("call `memory_read <id>` / `memory_neighbors <id>`"). `standard` = up to `limit` (default 20).
  Search still returns *summaries*, never bodies — bodies are `memory_read`'s job.
- **`memory_read`** gains `detail_level` + `budget`. `minimal` truncates the body to the budget and
  sets `truncated`; `standard` returns the full note (current behaviour, the default).
- **`memory_neighbors`** always budget-shaped: ranked `NeighborResult[]` (`{ id, title, summary,
  via, depth, score }`), capped by `cap`/`budget`, with `truncated` + `next`.

Defaults preserve M4b behaviour: an existing caller that passes neither field gets `standard` — no
silent truncation of anything that works today.

### 4.5 `memory_neighbors` — the traverse tool (contract-change: new tool)

```
memory_neighbors(seed: id, kinds?: LinkKind[], depth = 2, budget = 1500) → {
  neighbors: NeighborResult[],   // ranked by graph distance (§4.3)
  truncated: boolean, omitted: number, next?: string
}
```

The **pull** analogue of RecursiveMAS *pushing* `planner_to_refiner` (research §"Synthesis"): a
sub-agent seeds from a note it already holds (a `memory_search` hit, its task's `paths`-matched note,
or a parent-passed id) and pulls exactly the neighbourhood it needs — its blast-radius slice — never
the whole memory. `kinds` filters the traversal (e.g. only `supersedes`/`contradicts` to find what
overrides a decision); `depth` bounds the hops; `budget` bounds the tokens.

### Design decisions

- **D1 — Migration is a tolerant contract + a read-model rebuild, not a log migration (RG2).** The
  single biggest decision. Because the event log is truth and the projector re-parses every event on
  replay, the *only* safe way to evolve the link shape is to make the new schema accept the old data.
  `LinkInput` is a `z.union([string→coerce, MemoryLink])`; a legacy `links: ['x']` event parses to
  `[{ id: 'x', kind: 'relates_to' }]`. Ship the contract, run `orc memory rebuild`, done — SurrealDB
  and vault are rebuilt with typed links + edges; the log is untouched and every old event still
  validates. *Considered and rejected:* a one-shot script rewriting historical `memory_written`
  payloads (violates append-only immutability — M4b RM2 — and is exactly code-review-graph's
  `migrations.py` v9 pain the CQRS model exists to avoid, research §4). The cost of the tolerant
  union is one permanent branch in the schema; cheap and honest about history.

- **D2 — Links stay on the note document; edges are a derived index.** The note snapshot in the
  event carries its links; `get()` returns them; the vault renderer groups them. The `RELATE` edges
  are a *second* representation the projector derives, existing only so traversal (and reverse
  traversal, RG4) is a native graph query. Two representations, one writer, deterministic on replay —
  acceptable because the writer is single and the edges are disposable. *Rejected:* storing links
  *only* as edges (then `get()`/render must reassemble the note's out-links per read — extra work on
  the hot read path for no gain).

- **D3 — Materialize `RELATE` rather than BFS the doc field. (ponytail-flagged.)** Reading only the
  note's own `links` field gives out-links for free and needs no edge table — genuinely simpler. It
  fails RG4: "what supersedes *this* note" then requires scanning every note. `RELATE` gives cheap
  bidirectional traversal. *Ceiling:* while the graph stays small, an app-side BFS over out-links
  plus a one-time reverse-index build would also work; `RELATE` is chosen for query ergonomics and
  because SurrealDB is already the store. Flagged as an open question (§9) — if edge upkeep proves
  fiddly, the fallback is pure-doc BFS.

- **D4 — Graph-distance is the interim relevance signal; vectors stay deferred (research §3.2,
  §3.7).** `rankNeighbors` needs only the graph we now have. Semantic search / embeddings remain the
  #1 fast-follow; §4.3's ranker is the exact thing Reciprocal-Rank-Fusion later merges vectors *into*
  — no re-architecture, just a second ranked list fused in (research §3.7). Nothing vector ships now.

- **D5 — Pull-only; the recursive-MAS substrate is framing, the tools are the deliverable.** M4b
  already injects the memory tools at the DBOS step boundary (per-step `ResolvedTool[]`). M4c adds
  `memory_neighbors` to that injected set — the sub-agent *pulls* its slice. **Auto-binding** a slice
  into a step's prompt (the runtime picking seeds and pre-loading neighbours) is push and stays
  deferred (research §4 "Push", M4b Out). We ship the primitive that makes the substrate traversable,
  not the automation that traverses it for the agent.

- **D6 — RecursiveMAS: framing + topologies in, mechanism out (research §"Synthesis", §4).** We
  adopt RecursiveMAS's *problem framing* (don't make every agent re-hold the full context; share a
  compact refined slice) and map its four topologies onto our graph (§8). We adopt **none** of its
  mechanism: latent hidden-state tensors, `CrossModelAdapter`/RecursiveLink, and Inner-Outer
  co-training are opaque, ephemeral, pushed, and require training the models — all in direct conflict
  with CQRS / event-log-is-truth / interpretability. Our channel is authored, persistent, pulled,
  interpretable notes. This is a hard boundary, restated so it is never crept across.

## 5. Data flow (deltas over M4b §5)

- **Write with typed links:** `memory_write({ id, links: [{ id: 'b', kind: 'supersedes' }] })` →
  gateway → `log.append(memory_written)` → projector: upsert note doc + re-materialize its out-edges
  (`RELATE … SET kind='supersedes'`) + render `vault/memory/<id>.md` with grouped links.
- **Traverse:** `memory_neighbors('a', { kinds: ['supersedes','contradicts'], depth: 2 })` →
  gateway `neighbors` → `surreal.neighbors` fetches edges frontier-by-frontier → `rankNeighbors` →
  budget-shaped `NeighborResult[]`.
- **Legacy replay:** `orc memory rebuild` replays the log; a v1 `memory_written` with flat string
  links coerces to `relates_to`, materializes `relates_to` edges — old knowledge joins the typed
  graph with zero manual work.
- **Delete:** `memory_deleted` tombstone → note doc + all its edges (in and out) removed; a later
  `memory_written` re-creates note and edges (latest event wins).

## 6. Note format delta (the contract — §6 of M4b)

Frontmatter `links` changes from a flat list to typed entries (block-YAML, the M4a-proven renderer):

```markdown
links:
  - id: session-model
    kind: refines
  - id: legacy-auth
    kind: supersedes
    confidence: 0.9
```

`renderNoteFile` (`note-md.ts`) already emits `links: note.links`; with typed links this is an array
of objects — valid block YAML, round-trips, machine-readable. Optionally a grouped body section
("## Supersedes / ## Relates to", research §5.2) improves human reading; deferred as polish. Tier-2
read-obs stays out of the file (M4b D4, unchanged).

## 7. Config & CLI

- No new config field required for v1 (ranker weights are code defaults). `memoryLinkWeights`
  override is an open question (§9), not scoped.
- No new CLI subcommand required; `orc memory` gains typed-link display in `cat`/`ls` for free (they
  print the note). A `orc memory neighbors <id>` mirror of the tool is a cheap optional add.
- `orc memory rebuild` is the migration command — it already exists; M4c just relies on it to
  rebuild edges + coerce legacy links.

## 8. Recursive-MAS substrate (design framing — research §"Synthesis")

The typed-link graph is the shared substrate a recursive MAS traverses on demand. RecursiveMAS's
four topologies become **graph shapes / link kinds**, not code paths:

| RecursiveMAS topology | Our graph mapping |
|---|---|
| **Sequential** (Planner→Critic→Solver) | a `refines` chain; the next agent traverses `refines`/`contradicts` from the prior note |
| **Deliberation** (Reflector + Tool-Caller) | `contradicts`/`refines` feedback edges the next round pulls |
| **Mixture** (experts + summarizer) | a rollup note that `derived_from`-links its experts' notes |
| **Distillation** (Expert→Learner) | `derived_from` edges from source to distilled note |

The recursion closes through **the log + graph, not passed tensors**: a child writes new/updated
notes (`memory_write`, append-only); the parent/next agent re-traverses on its next turn. Where a
sub-agent *binds* its slice — the seed→traverse at the DBOS step boundary — is the RecursiveMAS
slot-injection analogue, but **pulled** (`memory_neighbors`), and the auto-binding of it is deferred
(D5). What M4c ships is the traversable substrate + the pull tool; M5 wires topologies onto it.

## 9. Open questions

1. **Edge directionality (research §5.1).** `supersedes`/`refines`/`derived_from` are directional;
   `relates_to`/`contradicts` are arguably symmetric. `RELATE` is directed — store one directed edge
   and decide per-kind whether `neighbors` queries out-only, in-only, or both (`<->`). Proposal:
   traverse both directions but let `rank.ts` weight the reverse direction of a directional kind
   lower. Confirm before Task 3.
2. **Weights as config vs code.** Code-review-graph exposes decay/floor via env (research §5.4). A
   `memoryLinkWeights` config override is likely worth it once the ranker lands, but defaults-in-code
   ship first (house rule). Decide whether M4c or M5 adds the knob.
3. **Graph-only vs graph + BM25 for `memory_search` (research §3.3, §5.3, §3.7).** M4b's search is
   case-insensitive substring. Do we add SurrealDB BM25 full-text now and RRF-merge it with the
   graph-distance ranker, or keep substring + graph-distance and defer BM25? Cheapest: keep current
   search, add `memory_neighbors` as a *separate* graph signal, and merge later. Proposed: defer BM25.
4. **RELATE vs pure-doc BFS (D3, ponytail).** If edge upkeep in the projector proves fiddly at
   small scale, fall back to app-side BFS over the note's out-link field + a reverse index. Revisit
   after Task 3's tests.
5. **Reproducible context manifest (research §5.5).** Does a sub-agent need a stored record of which
   note ids it was handed (for debugging/reproducibility), or is re-running seed→traverse
   deterministic enough? Deferred with the auto-binding (D5), noted here so M5 addresses it.
6. **Confidence source.** Who sets `confidence` — the authoring agent's own estimate, or a provenance
   tier (human-confirmed vs agent-asserted, research §3.4)? v1: optional author-supplied float,
   default 1.0. A provenance-derived tier is a clean later refinement.

## 10. What this unlocks (context, not scope)

- **Vectors (still #1 fast-follow):** embed note text, store in the reserved SurrealDB vector field,
  RRF-merge the vector rank with §4.3's graph-distance rank — the ranker is already the fusion point
  (research §3.7). Additive; no contract/store change.
- **Push / auto-binding:** the runtime seeds a step's traversal from its task text/`paths` and
  pre-loads the neighbourhood into the prompt — built on `memory_neighbors` (research §5.7). The
  deferred half of the recursive-MAS substrate.
- **M5 topologies:** Sequential/Mixture/Distillation/Deliberation routed onto the link kinds (§8),
  so recursion happens through the graph, not through re-held context.
