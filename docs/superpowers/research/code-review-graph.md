# Research note: code-review-graph

Source: <https://github.com/tirth8205/code-review-graph> (Python 94% / TS 5.8%). Read
2026-07-18: README, repo tree, `code_review_graph/graph.py`, `migrations.py`,
`constants.py`, `tools/query.py`, `tools/review.py`. Not read (large / lower value):
`parser.py` (564 KB), `embeddings.py`, `communities.py`, `flows.py`, `incremental.py`.

## 1. What it is

A local-first "code intelligence" tool that parses a repo into a **code graph** (Tree-sitter
AST → nodes + typed edges in SQLite) so AI coding assistants read *only* the files a change
touches instead of the whole repo. It exposes ~30 MCP tools; the headline claim is ~82x median
token reduction on reviews by computing a change's **blast radius** from graph edges. It is a
*code-structure* graph auto-derived from source — not a human/agent knowledge store — which is
the key difference from our M4b memory. Still, its graph modelling, weighted traversal, and
token-budgeted MCP surface map cleanly onto our note-graph.

## 2. Architecture & data model

**Storage:** single SQLite DB in `.code-review-graph/`, with FTS5 (`nodes_fts`) for keyword
search and optional vector embeddings merged via Reciprocal Rank Fusion. SQLite is the
store-of-record; incremental rebuild is driven by SHA-256 file hashes (`incremental.py`).
Schema evolves via numbered additive migrations (`migrations.py`, v2..v9 — e.g. confidence
columns added at v9).

**Nodes** (`nodes` table): `kind` ∈ {File, Class, Function, Type, Test}, plus
`name, qualified_name (UNIQUE), file_path, line_start, line_end, language, parent_name, params,
return_type, modifiers, is_test, signature, community_id`. Note the node is anchored by a
**stable `qualified_name`** *and* a file_path + line range.

**Edges** (`edges` table) — the core idea. Columns:
`kind, source_qualified, target_qualified, file_path, line, extra (JSON), confidence REAL,
confidence_tier TEXT`. Edge `kind` is a **typed relationship**, not a flat link:

| kind | meaning |
|------|---------|
| CALLS | function invocation |
| IMPORTS_FROM | module/file import |
| INHERITS / IMPLEMENTS / OVERRIDES | type hierarchy |
| CONTAINS | parent→child (class→method) |
| TESTED_BY | source=production, target=test |
| DEPENDS_ON / REFERENCES | general dependency / reference |
| DEPENDS_ON_CONFIG | consumes a config value |

**Confidence per edge** (`graph.py`, `migrations.py` v9): a categorical `confidence_tier` ∈
{EXTRACTED (direct parse, default), INFERRED (derived), AMBIGUOUS (low-confidence)} plus a float
`confidence` 0.0–1.0. Lets the graph keep uncertain edges without treating them as fact.

**Blast-radius / traversal** (`graph.py::get_impact_radius_sql`, `constants.py`): bounded
best-score relaxation over the edge graph. Seeds from changed nodes, walks up to `max_depth`
hops, and scores each reached node by multiplying **per-edge-kind weights** by a **per-hop decay**,
pruning anything below a floor and capping node count:

```python
IMPACT_EDGE_WEIGHTS = {"CALLS":1.0, "INHERITS":0.9, "OVERRIDES":0.9, "IMPLEMENTS":0.9,
                       "TESTED_BY":0.7, "REFERENCES":0.6, "DEPENDS_ON":0.6,
                       "IMPORTS_FROM":0.5, "CONTAINS":0.3}   # default 0.5
IMPACT_DEPTH_DECAY = 0.6     # score *= 0.6 each hop  (env CRG_IMPACT_DEPTH_DECAY)
IMPACT_SCORE_FLOOR = 0.05    # prune below this        (env CRG_IMPACT_SCORE_FLOOR)
```

These weights are deliberately separate from the community-clustering weights: "review risk,
not structural affinity." This is a pure **graph-distance relevance signal with no embeddings** —
directly relevant to us since vectors are deferred.

**Query surface** (`tools/query.py`, `tools/review.py`): relationship queries via one
`query_graph(pattern, target, detail_level, max_results)` tool with 16 patterns
(`callers_of, callees_of, imports_of, importers_of, children_of, tests_for, inheritors_of,
file_summary, …`); `get_impact_radius(...)`; `traverse_graph(query, mode="bfs", depth=3,
token_budget=2000)`; `semantic_search_nodes(...)` (FTS5 BM25 + vectors via RRF).

**Result shaping (the transferable part):** every tool takes `detail_level ∈ {minimal, standard}`.
`minimal` returns the **top 5**, a **risk bucket** (high >20 / medium >5 / low ≤5 impacted nodes),
and an **exact omitted count**; `standard` returns full node dicts + aligned edges. `traverse_graph`
halts when `approx_tokens > token_budget`, sets a `truncated` flag, and returns **next-tool
suggestions**. `get_review_context` merges relevant line-ranges (3 lines of context, overlapping
ranges collapsed) and emits `review_guidance` signals like "N changed function(s) lack test
coverage" / "wide blast radius" / "inheritance change" instead of enumerating everything. It
reports `original_tokens` vs optimized size as `context_savings`.

## 3. Transferable ideas for our memory graph (ranked)

1. **Typed edges instead of a flat `links[]`.** Their 9 edge `kind`s are the single best idea.
   Give each `MemoryNote` link a `kind` — e.g. `refines`, `supersedes`, `contradicts`,
   `depends_on`, `example_of`, `derived_from`, `relates_to`. In SurrealDB model links as graph
   edges via `RELATE noteA->link->noteB SET kind=…`, so traversal can filter by relationship
   (`SELECT ->link[WHERE kind='supersedes']->note FROM …`). *Fit:* SurrealDB's native `RELATE`
   graph edges are exactly this; a flat id array throws away the relationship type an agent
   already knows when it writes the link. *Adaptation:* the link shape in the `memory_written`
   event payload becomes `{id, kind, confidence?}` rather than a bare id, so the projection can
   rebuild typed edges. (Contract change — flag, don't make it here.)

2. **Graph-distance relevance for `memory_search`, no embeddings.** Port the weighted best-score
   relaxation (`IMPACT_EDGE_WEIGHTS` × `IMPACT_DEPTH_DECAY`, prune at floor, cap nodes) as a
   "related notes" ranker: from a seed note (or search hit), walk typed links N hops, rank
   neighbours by (edge-kind weight × decay^hop). *Fit:* this is the pragmatic relevance signal
   while semantic vectors stay deferred — it needs only the graph we already have. In SurrealDB,
   either recursive `RELATE` traversal or an app-side BFS over the read model. Per-kind weights
   (e.g. `supersedes`/`contradicts` high, `relates_to` low) let agents surface the notes that
   actually constrain a task.

3. **Token-budgeted, `minimal`/`standard` results in the pull tools.** Give `memory_search` /
   `memory_read` a `detail_level` and a token budget: `minimal` = top-N + omitted count +
   a one-line neighbour summary; `standard` = full notes + typed edges; always set a `truncated`
   flag and suggest the next call. *Fit:* maps 1:1 onto our three pull tools and keeps memory
   from blowing an agent's context — the whole reason this repo exists. Cheap, high value.

4. **Per-edge confidence / provenance tier.** Add `confidence_tier` (or reuse provenance) to a
   link: human-confirmed vs agent-asserted vs speculative. *Fit:* our notes already carry
   provenance (createdBy/updatedBy/revision); extending it to *edges* lets `memory_search` weight
   or filter (e.g. down-rank AMBIGUOUS links, never auto-honor a `rule` reached only through an
   unconfirmed edge). Small addition to the link object.

5. **Anchor `paths` by symbol, not just file.** Their nodes pin to a stable `qualified_name` plus
   line range, so a pointer survives line drift. *Fit:* extend our `paths` pointer shape to
   `{path, symbol?, lineStart?, lineEnd?}` so a note can point at `pkg/foo.ts#MyClass.method`,
   not just a file. Improves precision of "which code does this note govern" without ingesting
   the codebase.

6. **Review-derived note categories & `rules` seeds.** Their `review_guidance` signals
   ("lacks test coverage", "wide blast radius", "inheritance change") and `community_summaries`
   fields (`purpose, key_symbols, risk`) are a ready taxonomy for our `categories`/`rules`:
   seed categories like `architecture-invariant`, `risk`, `security`, `test-coverage`. A `rule`
   ("changes to X must keep Y tested") is exactly their persisted guidance — but authored, not
   inferred. *Fit:* directional guidance for what a good note looks like; low code cost.

7. **FTS-first hybrid search, RRF as the future vector slot.** SurrealDB has built-in BM25
   full-text search; use it on `title/summary/body/tags/rules` for `memory_search` today, and
   Reciprocal-Rank-Fusion-merge it with the graph-distance ranker (#2). *Fit:* gives a real
   hybrid without embeddings now, and RRF is the exact merge point to slot vectors into later
   when we un-defer them — no re-architecture.

## 4. What NOT to adopt

- **Auto-deriving the graph from AST / Tree-sitter.** Their nodes/edges are *extracted from
  source*; ours are *authored knowledge*. Do not auto-populate `MemoryNote` from code structure —
  that's a different product (a code map) and would flood the memory with machine facts. Keep
  `paths` as thin pointers.
- **SQLite as store-of-record + hash-based incremental re-index.** We already have the Postgres
  event log as truth and rebuildable projections. SurrealDB stays a read model; don't bolt on a
  second store-of-record or their `migrations.py`-style ALTER migrations — projection schema
  evolves for free by replaying the log. (Their v9 "add confidence" migration is exactly the pain
  we avoid.)
- **Embeddings / `semantic_search` vectors** — explicitly deferred. Note RRF as the slot-in
  point (#7); build nothing now.
- **Push / auto-run flows.** Their GitHub Action auto-reviews PRs (push-ish). We deferred
  push/auto-inject; their MCP *pull* model (AI calls the tool) is the part that matches us — keep
  pull-only.
- **Heavy graph algorithms** — Leiden community detection, betweenness centrality, flow tracing.
  Justified by huge auto-derived graphs (27k+ files); our hand-authored note graph is small.
  Premature until scale demands it.
- **Tool sprawl (~30 MCP tools / 16 query patterns).** We have three pull tools; resist
  splintering. One `memory_search` with a `pattern`/`kind` param beats twelve tools.

## 5. Open questions / follow-ups

1. **Edge directionality:** `supersedes`/`refines` are directional; `relates_to`/`contradicts`
   arguably symmetric. SurrealDB `RELATE` is directed — decide per edge kind whether traversal
   treats it as directed or both-ways (store one directed edge, query with `<->`?).
2. **Contract impact of typed links:** #1 changes the `links` shape in the `memory_written`
   payload from `id[]` to `{id, kind, confidence?}[]`. Worth confirming the event contract can
   carry it and the vault-markdown projection can render it (e.g. grouped "Supersedes / Relates
   to" sections).
3. **Is graph-distance ranking (#2) enough** for `memory_search` before FTS, or do we want
   SurrealDB BM25 from day one? Cheap to try graph-only first and add FTS if recall is poor.
4. **Weights as config:** they expose decay/floor via env vars. A small tunable weight table for
   our edge kinds (default in code, overridable) is likely worth it once #1 and #2 land.
