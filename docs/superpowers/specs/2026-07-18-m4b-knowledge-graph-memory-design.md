# M4b — Knowledge Graph / Memory Design Specification

**Date:** 2026-07-18
**Status:** Approved design, pre-implementation
**Amends:** `2026-07-16-orchestrator-design.md` (§5.2 MemoryStore, §5.3 VaultGateway, §8.5 Memory, R6);
builds on `2026-07-17-m4a-vault-projector-design.md` (§4.1 stream, D5 two-graph boundary, §12).
**Milestone:** M4b. M5 (recursion/strategies) consumes what this builds.

---

## 1. Goal

A persistent, cross-task **knowledge graph** that agents write to during runs and read back
in later steps and tasks, so work is reused instead of redone (the M5 enabler, R6). It is the
mutable, current-state, delete-on-demand counterpart to M4a's immutable trace graph.

The design is **CQRS over the existing event log**:

1. **Write model = the Postgres event log** — `memory_written` / `memory_deleted` events.
   Append-only, auditable, replayable; delete is a tombstone. This is the single source of
   truth (R9 preserved for knowledge, not just history).
2. **Read model = SurrealDB** — a multi-model (document + graph + vector + full-text) store,
   a **projection rebuilt from the log**. Agents query it; it is never truth.
3. **Human/browse view = markdown `vault/memory/**`** — a second projection, Obsidian-ready,
   for people and a future webapp. Projection-only in v1.

All writes go through one ergonomic **`MemoryStore` gateway** (the single writer). Callers
never touch either store directly.

## 2. Scope

**In:** two event kinds (`memory_written`, `memory_deleted`) + a `MemoryNote` contract; a
`MemoryStore` gateway (write → log; read → SurrealDB); a `plugins/memory/` package (SurrealDB
adapter + a stream-driven projector that maintains SurrealDB and renders `vault/memory/**`);
agent tools `memory_write` / `memory_search` / `memory_read` injected as `ResolvedTool[]`; CLI
`orc memory add|rm|ls|search|cat|rebuild`; a `projectDbUrl` config field and a SurrealDB
service in `docker-compose.yml`; keyword (full-text) + tag/category/scope filtering + graph
(link) retrieval; write-provenance and non-sourced read-observability.

**Out (deliberately deferred):** semantic/vector retrieval and the embedding pipeline (the
store is vector-ready; population is the #1 fast-follow — §12); auto-injection of memory into
step prompts ("push"/three-tier read discipline — pull-only in v1); bidirectional human
editing of `vault/memory/**` markdown (projection-only in v1; the CLI is the human write
path); private-per-run memory scopes (one shared `project` scope in v1, `scope` field reserved);
a web GUI.

## 3. Requirements captured

- **RM1** Cross-task reuse: an agent writes knowledge; a later step/task reads it (R6, M5).
- **RM2** Two disciplines reconciled: history append-only/immutable, knowledge mutable
  current-state; delete is a tombstone appended to history, so the graph shrinks while the log
  still replays to any point (M4a §12 / RQ2).
- **RM3** Scale target: hundreds of concurrent agents. Memory writes stay **off** the global
  append lock; reads **never** fold the log; the read model is a shared, indexed, concurrent
  store.
- **RM4** Clean SoC: truth fixed on Postgres; every projection (SurrealDB, markdown) is
  disposable and rebuildable behind a port, so the read substrate is swappable.
- **RM5** Ergonomic single writer: one `MemoryStore.write(note)` call fans out to log →
  SurrealDB → vault. No caller writes a store directly (the claude-obsidian corruption lesson,
  §5.3).
- **RM6** Observability: "who authored/edited and when" (durable, sourced) and "how often /
  last read" (cheap, best-effort).
- **RM7** Readable on-disk format: OKF markdown so Obsidian / a future webapp / a later
  embedding index can all consume it without store changes.

## 4. Architecture

Four pieces, wired by the runtime like M3's `mcp-client` and M4a's vault projector.

```
packages/contracts/src/
├── memory.ts        # MemoryNote schema + NoteRef/provenance; memory event payloads
└── events.ts        # + memory_written, memory_deleted; taskId relaxed to nullable (D3)

plugins/memory/src/
├── note-md.ts       # pure: renderNoteFile(note) → markdown (frontmatter + body)   (no fs)
├── surreal.ts       # SurrealDB adapter: applyWritten / applyDeleted / get / list / search / rebuild
├── projector.ts     # subscribe → apply to SurrealDB + render vault/memory/**       (durable cursor)
├── store.ts         # MemoryStore gateway: write/remove → log.append; get/list/search → surreal
├── tools.ts         # memory_write / memory_search / memory_read as ResolvedTool[]
└── index.ts         # createMemory({ log, config, provenance }) → { store, projector }
```

### 4.1 Write model (kernel / log)

`memory_written` carries a **full note snapshot** (upsert semantics: last-writer-wins by `seq`).
`memory_deleted` carries `{ id, scope }` (tombstone). Both are appended via the **non-locking**
`EventLog.append` — *not* `EventLog.transaction`. The advisory lock exists to serialize
check-then-append (plan versioning, §M2); a memory write is a blind append keyed by a stable
`id`, needs no pre-read, so it stays off the contention path (RM3). Concurrent writes to the
same id resolve deterministically by `seq` in the projection.

### 4.2 Read model (SurrealDB)

One SurrealDB record per live note (keyed by `scope:id`), holding all Tier-1 fields (§6) plus
Tier-2 read-observability. The projector applies events to it; agent/CLI reads query it. It is
**a projection** — `orc memory rebuild` drops and replays all `memory_*` events into a fresh
store. SurrealDB is chosen for multi-model fit (document body, graph links, vector-ready,
full-text) so the whole knowledge graph lives in one store behind one wrapper.

### 4.3 The projector (the sync)

Subscribes to the §4.1 stream. For each `memory_*` event, applies it to SurrealDB and renders
`vault/memory/<id>.md`. Keyed by `seq`, idempotent (re-apply of the same event is a no-op
upsert). Tracks a **durable last-applied `seq`** in SurrealDB so restart resumes and rebuild is
a full replay. Because the stream's monotonic cursor can skip a lower `seq` that commits after
a higher one under concurrent appends (documented `subscribe` caveat), on start/catch-up the
projector reconciles by querying `memory_*` events `WHERE seq > lastApplied` rather than
trusting the cursor alone.

### 4.4 The gateway (`MemoryStore` — the wrapper, RM5)

```
write(note)            → validate → append memory_written (log.append)      → MemoryNote
remove(id, scope?)     → append memory_deleted                              → void
get(id, scope?)        → SurrealDB lookup                                   → MemoryNote | null
list(filter?)          → SurrealDB: id/title/categories/tags/summary        → NoteSummary[]
search(query, filter?) → SurrealDB full-text + filter + graph               → NoteSummary[]
```

Writes are **event-first**: `write` returns once the event is committed; the projector applies
to SurrealDB and vault shortly after (eventual consistency — acceptable, since agents write at
step end and other steps/tasks read later). The gateway stamps **provenance** from the calling
context (executor·model·role for agents; `cli`/user for humans) into the event payload.

### Design decisions

- **D1 — CQRS with the log as the only truth.** Write model = Postgres events; read model =
  SurrealDB; view = markdown. SurrealDB and markdown are disposable projections rebuilt from
  the log. This is what makes the specialized store safe to adopt (RM4): pick wrong, replay the
  log. Considered and rejected: mutable CRUD with no events (loses audit/replay, reopens the
  corruption risk); a pure-Postgres read model (chosen against — a specialized multi-model
  store fits the knowledge-graph workload); an in-memory index (single-process, fails RM3).

- **D2 — Memory writes are non-locking blind appends; reads never fold the log.** The two
  scale walls in the current code are the global advisory lock on `transaction()` and
  `fold(log.all())` per read. Memory sidesteps both: writes use `log.append` (no lock), reads
  hit SurrealDB (indexed, O(query), shared across processes). RM3 is satisfied by construction.

- **D3 — Memory events are not task-scoped; `taskId` becomes nullable.** A note is
  project-scoped, not owned by a task. `EventInput.taskId` (and the `events.taskId` column)
  relax to nullable; `memory_*` events set `taskId = null` and record authorship in
  `payload.authoredBy = { taskId?, stepId?, runToken?, executor?, model?, role? } | null`.
  Required guard: existing projectors filter by event kind — the **vault projector ignores
  `memory_*` / null-`taskId` events** (its `renderAll` derives task ids from the log and must
  not choke on a null), and the **memory projector ignores non-memory events**. `fold` gains
  explicit no-op cases for the two kinds (knowledge is not part of `State`; it lives in
  SurrealDB), preserving the exhaustiveness check.

- **D4 — Two field tiers: writes are sourced, reads are observed (RM6).**
  - *Tier 1 (sourced, in markdown frontmatter):* authored fields + `createdAt/By`,
    `updatedAt/By`, `revision` — all folded from `memory_written` events. Auditable,
    rebuildable, and rewritten on each edit.
  - *Tier 2 (SurrealDB-only, NOT event-sourced):* `lastReadAt`, `readCount` — bumped on read,
    best-effort, **reset to zero on rebuild**, and kept **out** of the markdown (otherwise every
    read rewrites a projection-only file → churn/drift). Recording reads as events would flood
    the log at RM3 scale and reads are not truth, so they are deliberately not sourced.

- **D5 — Ownership boundary extends M4a's D5.** The memory projector owns **only**
  `vault/memory/**`; it never writes `vault/tasks/**` or `vault/skills/**`. The same atomic,
  containment-checked writer discipline (tmp→rename, skip-unchanged, drift-warn on hand-edited
  projection files) is reused. `orc memory rebuild` re-renders `vault/memory/**` in place per
  file — never a whole-vault wipe.

- **D6 — Pull, not push; keyword/graph now, semantic later.** Agents fetch memory via tools
  when they choose (no relevance engine, no context bloat). v1 retrieval is SurrealDB full-text
  + category/tag/scope filter + link-graph. Semantic (vectors + local Ollama embeddings) is the
  #1 fast-follow — the SurrealDB record reserves a vector field, so it is additive with no
  format or store change (RM7, §12).

- **D7 — `vault/memory/**` is projection-only in v1.** Like M4a's `log.md`, human hand-edits
  are drift-detected and overwritten, not parsed back. The human write path is the CLI
  (`orc memory …`), which routes through the same gateway. Bidirectional Obsidian editing of
  memory (parse markdown → `memory_written`, the plan-round-trip pattern) is a clean later
  addition, deferred to keep v1 tight.

## 5. Data flow

- **Agent write:** step tool `memory_write(note)` → `MemoryStore.write` → `log.append`
  (`memory_written`, provenance stamped) → projector applies to SurrealDB + renders
  `vault/memory/<id>.md`.
- **Agent read:** `memory_search(query)` / `memory_read(id)` → `MemoryStore.search|get` →
  SurrealDB query; `lastReadAt`/`readCount` bumped (Tier 2).
- **Human:** `orc memory add|rm|ls|search|cat` → the same gateway.
- **Delete:** `memory_deleted` tombstone → projector removes the SurrealDB record + the
  markdown file; a later `memory_written` with the same id re-creates it (fold: latest event
  wins).
- **Startup / rebuild:** projector reads `lastApplied` from SurrealDB and replays
  `memory_* WHERE seq > lastApplied`; `orc memory rebuild` resets the store and replays from 0
  (Tier-2 read-stats reset — D4).
- **Containment / resilience:** projector handlers are wrapped (a failure warns, never breaks
  the stream or a run); if SurrealDB is unavailable, read tools return a clear tool error
  (`isError: true`) and the run continues — reuse is best-effort, memory is never on the
  critical path.

## 6. Note format (the contract — OKF, RM7)

`id` matches `^[a-z0-9][a-z0-9-]*$` (safe filename + SurrealDB record id — no traversal).
Path: `vault/memory/<id>.md` for the default `project` scope; named scopes reserve
`vault/memory/<scope>/<id>.md`. Frontmatter fields map 1:1 to SurrealDB columns and to
`list`/`search` output.

```markdown
---
type: memory
id: auth-token-refresh
scope: project                                # default shared KB; reserved for partitioning
title: Auth token refresh flow
categories: [architecture, security]          # broad buckets
tags: [auth, token-rotation]                  # freeform keywords
links: [session-model, api-error-taxonomy]    # ids of related notes → the graph
paths: [packages/kernel/src/auth.ts, plugins/mcp-client/src/trust.ts:40]   # pointers down to code
rules:
  - Refresh tokens are single-use; reuse forces full re-auth.   # normative statements agents honor
summary: Refresh tokens rotate on use; reuse triggers full re-auth.        # one-liner = "hot tier"
createdAt: 2026-07-18T09:12:04Z
createdBy: api-loop·sonnet-5·research          # agent identity, or "cli" / user
updatedAt: 2026-07-18T11:30:22Z
updatedBy: api-loop·opus·review                # "edited by <agent>"
revision: 3                                    # write count
---

<freeform markdown body — the authored knowledge>
```

Tier-2 (`lastReadAt`, `readCount`) live only on the SurrealDB record, never in this file (D4).

## 7. Config & CLI

- Config: `projectDbUrl` (SurrealDB connection; its own boundary, distinct from the Postgres
  event-log URL — RM4). A SurrealDB service added to `docker-compose.yml`.
- New npm dependency: the `surrealdb` client (in `plugins/memory` only).
- CLI: `orc memory add`, `rm <id>`, `ls [--category --tag]`, `search <query>`, `cat <id>`,
  `rebuild`.
- No kernel workflow changes; the only kernel/contracts changes are the two event kinds and the
  nullable-`taskId` relaxation (D3).

## 8. Error handling

- **Projection failure** (SurrealDB apply or vault render throws): warn, never fail the write —
  the event is already committed truth; the projector catches up on the next event or a rebuild
  (mirrors M4a containment).
- **SurrealDB unavailable on read:** tool returns `{ isError: true }`; the agent gets a clear
  message and proceeds. Memory is best-effort, never blocking.
- **Malformed note input:** the gateway validates with the `MemoryNote` zod schema before
  appending; reject with a clear error and append **no** event (mirrors plan-parse rejection).
- **Idempotency / ordering:** apply is keyed by `(id, seq)`; last-writer-wins by `seq`;
  re-applying an event is a no-op upsert. The catch-up reconcile (§4.3) closes the
  cursor-skip gap.
- **Path/id safety:** enforced by the `id` pattern; the writer is confined to
  `vault/memory/**` (D5).

## 9. Testing

- **Gateway:** `write` appends `memory_written` with the right payload + stamped provenance;
  `remove` appends `memory_deleted`; malformed input → rejected, no event; write uses
  `log.append` (asserted **off** the advisory-lock/transaction path — RM3/D2).
- **Projector:** `memory_written` → SurrealDB upsert + `vault/memory/<id>.md` with correct
  frontmatter; `memory_deleted` → record + file removed; last-writer-wins by `seq`; idempotent
  re-apply; catch-up from a durable cursor with a simulated skipped `seq`; rebuild-from-log
  yields an identical read model (minus Tier-2 read-stats).
- **Read model / lifecycle:** create → update → delete → re-create sequence yields the correct
  current view; `revision` increments; `createdBy` fixed, `updatedBy` tracks the latest writer.
- **Retrieval:** full-text `search` returns matching notes; `list` filters by
  category/tag/scope; link-graph resolves note→note.
- **Tools:** `memory_write|search|read` execute through the gateway; SurrealDB-down → read tool
  returns `isError`, run continues.
- **Provenance / D3:** agent write records executor·model·role; CLI write records `cli`/user;
  `memory_*` events carry `taskId = null`; the **vault projector ignores them** (no null-taskId
  crash); `fold` no-ops them and stays exhaustive.
- **Integration (the reuse proof):** a fake-provider run where step A writes a note and a later
  step B `memory_search` + `memory_read`s it — reuse demonstrated end-to-end, with SurrealDB and
  `vault/memory/**` both reflecting it.

## 10. Implementation order (for the plan)

1. `MemoryNote` contract + `memory_written` / `memory_deleted` kinds + payload schemas;
   `taskId` nullable; `fold` no-op cases; vault-projector event-kind guard (D3).
2. SurrealDB service in `docker-compose.yml` + `projectDbUrl` config; `surreal.ts` adapter with
   `applyWritten/applyDeleted/get/list/search/rebuild` and the durable cursor.
3. `note-md.ts` pure renderer (frontmatter round-trip fields) + its tests.
4. `projector.ts` (subscribe → apply + render, reconcile, containment) reusing M4a's atomic
   writer discipline.
5. `store.ts` `MemoryStore` gateway (non-locking append + provenance stamping; reads via
   SurrealDB) + Tier-2 read bumping.
6. `tools.ts` agent tools; wire `createMemory` + tool injection + projector into the runtime.
7. CLI `orc memory add|rm|ls|search|cat|rebuild`.
8. Integration test: the reuse proof (§9).

## 11. What this unlocks (context, not scope)

- **Semantic retrieval (#1 fast-follow):** embed note text via the local Ollama provider,
  store vectors in the reserved SurrealDB field, add hybrid (keyword + vector) ranking to
  `search`. Additive — no format, store, or event change (D6, RM7).
- **M5 (strategies):** topologies route steps to read/write this graph, so agents reuse prior
  work instead of recomputing it — the whole point of M4b.
- **Push / three-tier read:** the runtime can later auto-select relevant memory into a step's
  prompt, built on the same `search` surface.
- **Bidirectional memory editing & a webapp:** parse `vault/memory/**` edits back into
  `memory_written` (the plan-round-trip pattern, D7); a webapp reads the same readable format
  or queries SurrealDB directly. Additive on the foundation built here.
