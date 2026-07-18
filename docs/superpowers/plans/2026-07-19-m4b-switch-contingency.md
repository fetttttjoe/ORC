# M4b — Switch / Contingency Plan (patch plan)

**Date:** 2026-07-19
**Status:** Reference doc — not a task list, not a plan amendment. Nothing here is scheduled;
each scenario below is a bounded runbook to reach for if its trigger fires.
**Relates to:** `docs/superpowers/specs/2026-07-18-m4b-knowledge-graph-memory-design.md` (the
design this plan protects); `docs/superpowers/plans/2026-07-18-m4b-knowledge-graph-memory.md`
(the implementation plan); `.superpowers/sdd/progress.md` (the ledger — see the **PIVOT** and
**SURQLIZE DEBT** sections, which this doc directly answers).

## Why this doc exists

M4b's read-model stack carries one accepted foundational risk, recorded in
`.superpowers/sdd/progress.md`: we adopted **surqlize@0.1.0**, a pre-1.0 SurrealDB ORM, on the
user's explicit direction (over the recommendation to hand-roll). surqlize 0.1.0 shipped an
**unparseable `.d.ts`** (`dist/index.d.ts:1394` declares a type literally named `infer`, a
reserved word — a TS1003/TS1109 parse error under both `tsgo` and stable TS 5.7.3, not a
`tsgo` bug). We carry a one-line rename patch for it: `patches/surqlize@0.1.0.patch`, wired via
`patchedDependencies` in the root `package.json`. The upstream fix is tracked at **surqlize
PR #51**; we drop our patch the day that ships (Scenario B).

As insurance against surqlize proving unviable outright, the **prior hand-rolled raw-`db.query`
adapter** (written before the pivot, against server v2.1.4 + client `surrealdb@^1.3`) was
preserved rather than deleted, at git tag **`m4b-hand-rolled-v2`** (commit `71f7cb5`). The
current stack has since moved to server v3.2.0 + client `surrealdb@2.0.4` (see PIVOT), so that
tag is a **retarget**, not a drop-in.

This doc is the switch plan for both of those, plus two adjacent risks (server-version change,
store swap), so a pivot is a runbook, not an improvisation.

## 1. Architectural safety net (read this first)

M4b's design (`2026-07-18-m4b-knowledge-graph-memory-design.md` §1, D1, D4, RM4) is **CQRS over
the Postgres event log**:

> Write model = the Postgres event log (`memory_written` / `memory_deleted` events, appended via
> the non-locking `EventLog.append`). Read model = SurrealDB. Human view = markdown
> `vault/memory/**`. **The log is the only source of truth. SurrealDB and the vault are
> projections, rebuilt from the log** (D1: "This is what makes the specialized store safe to
> adopt: pick wrong, replay the log.").

This is precisely what makes every scenario below **bounded**. Concretely:

**Never changes, in any scenario:**
- The event log itself — Postgres, `packages/kernel/drizzle/**` migrations, `EventLog.append`.
- The event contracts — `packages/contracts/src/memory.ts` (`MemoryNote`, `MemoryNoteInput`,
  `MemoryFilter`, `NoteSummary`, `MemoryAuthor`, the `MemoryStore` interface) and
  `packages/contracts/src/events.ts` (`memory_written` / `memory_deleted` kinds).
- The **`MemoryStore` gateway contract** (`write/remove/get/list/search`, `packages/contracts/src/memory.ts:52-58`)
  and its one implementation shape in `plugins/memory/src/store.ts` — it calls
  `surreal.get/list/search/bumpRead/applyWritten/applyDeleted` etc. through the `SurrealMemory`
  class's public method names, never through surqlize or raw SurrealQL directly.
- The agent tools (`plugins/memory/src/tools.ts`, `memory_write`/`memory_search`/`memory_read`)
  and CLI surface — both call `MemoryStore`, never a store internal.
- Any already-committed history: `memory_written`/`memory_deleted` events already in Postgres
  are untouched by any of this; a rebuild replays them, it doesn't reinterpret them.

**What actually changes, in every scenario below:** only the **adapter**
(`plugins/memory/src/surreal.ts`, the class implementing `open/applyWritten/applyDeleted/get/
list/search/bumpRead/getCursor/setCursor/clear/close`), its dependency footprint
(`plugins/memory/package.json`, root `package.json` `patchedDependencies`, `patches/*.patch`),
the docker service (`docker-compose.yml`), and a call to the projector's existing
**`rebuild()`** (`plugins/memory/src/projector.ts:66` — `surreal.clear()` then replay every
`memory_*` event from `seq 0`). No scenario below is a data migration; every one ends in "replay
the log into the new/changed store."

## 2. Scenario A — surqlize → hand-rolled raw-`db.query` adapter

**This is the primary risk this doc exists to cover.**

### Trigger
Any of:
- surqlize proves unviable in practice beyond the `.d.ts` patch (e.g., its query builder can't
  express a retrieval need M4c/M5 adds — recall `plugins/memory/src/surreal.ts` already notes
  "surqlize has NO raw escape hatch" for anything the builder can't do).
- The `.d.ts` patch breaks against a surqlize point release that reshuffles the same file (patch
  no longer applies cleanly, or applies but the underlying bug has moved).
- PR #51 stalls for a long time **while** a separate, blocking surqlize bug surfaces (so waiting
  for upstream is no longer tenable).

### Blast radius (exact files)
| File | Change |
|---|---|
| `plugins/memory/src/surreal.ts` | Replaced wholesale with a retargeted version of `git show m4b-hand-rolled-v2:plugins/memory/src/surreal.ts` |
| `plugins/memory/src/surreal.test.ts` | Retargeted; carry forward the two regression tests the current version added after the tag (case-insensitive `search('TOKENS')`, `bumpRead` merge-safety) |
| `plugins/memory/package.json` | Drop `"surqlize": "0.1.0"` line; keep `"surrealdb": "2.0.4"` (do **not** revert to the tag's `^1.3.0` — see retarget notes) |
| `package.json` (root) | Remove the `patchedDependencies` entry (`"surqlize@0.1.0": "patches/surqlize@0.1.0.patch"`) — if it becomes the only entry, remove the whole `patchedDependencies` key |
| `patches/surqlize@0.1.0.patch` | Delete |
| `bun.lock` | Regenerated by `bun install` (drops surqlize + the patch reference) |

**Untouched:** `plugins/memory/src/store.ts`, `projector.ts`, `tools.ts`, `index.ts`,
`note-md.ts`, `write-note.ts`, `test-helpers.ts` (already targets the current SDK's
`connect()`/`signin()`/`use()` split — see retarget notes), `packages/contracts/**`,
`docker-compose.yml`, `packages/kernel/src/config.ts` (`projectDbUrl`). None of these know or
care whether the adapter's internals are surqlize or raw `db.query` — they only see the
`SurrealMemory` class's public methods.

### Steps
1. **Recover the tagged adapter:** `git show m4b-hand-rolled-v2:plugins/memory/src/surreal.ts`
   (and `:plugins/memory/src/surreal.test.ts`, `:plugins/memory/src/test-helpers.ts`,
   `:plugins/memory/package.json` for reference) into a scratch file.
2. **Retarget the connection.** The tagged version dialed server v2.1.4 with a single call:
   `db.connect(url, { namespace, database, auth: { username, password } })`. The current stack
   is server v3.2.0 + client `surrealdb@2.0.4`, which needs **separate**
   `connect()` → `signin()` → `use()` calls — the current `surreal.ts:36-39` and
   `test-helpers.ts` already do this correctly; copy that shape verbatim.
3. **Reuse the raw SurrealQL almost as-is.** The tagged adapter's `LET $ex = (SELECT ...)[0];
   UPSERT ... CONTENT {...}` pattern, its `DEFINE TABLE IF NOT EXISTS note SCHEMALESS; DEFINE
   TABLE IF NOT EXISTS meta SCHEMALESS;` bootstrap, `search`'s `string::lowercase(...) CONTAINS
   string::lowercase($q)` clauses, and the cursor/`clear`/`close` methods are all
   server-version-portable SurrealQL — carry them over unchanged, then **smoke-test every method
   against the live v3.2.0 container** (`bun run db:up`) rather than assuming 1:1 syntax
   compatibility across the v2.1.4→v3.2.0 jump.
4. **Drop the vestigial soft-delete field.** The tagged version still carries a `deleted:
   false` field (set, filtered on, checked in `get`) even though `applyDeleted` already does a
   hard `DELETE type::thing(...)` — this was later identified as dead weight and removed from
   the surqlize adapter (progress ledger, Task 4 fix). Drop it the same way when retargeting, so
   behavior matches the current adapter's hard-delete semantics exactly.
5. **Keep the `SurrealMemory` contract identical** — same class name, same public method
   signatures (`open/applyWritten/applyDeleted/get/list/search/bumpRead/getCursor/setCursor/
   clear/close`) — so `store.ts`, `projector.ts`, and their tests need **zero** changes.
6. **Carry forward the two tests the surqlize version added after the tag**: the
   case-insensitive `search('TOKENS')` assertion and the `bumpRead` merge-safety test (raw-peek
   at `readCount`/`lastReadAt` via a second `Surreal` client) — real regression coverage,
   independent of which adapter implementation is under test.
7. **Remove the surqlize dependency footprint**: delete the `surqlize` line from
   `plugins/memory/package.json`, delete `patches/surqlize@0.1.0.patch`, remove the
   `patchedDependencies` entry from root `package.json`.
8. `bun install` (regenerates `bun.lock`).
9. Run the adapter tests directly: `bun test plugins/memory/src/surreal.test.ts`, then the full
   `plugins/memory` suite, then `bun run typecheck` (drops one `tsc` target's exposure to
   surqlize's types entirely — the patch existed only for this).

### Verify
- `bun test plugins/memory` green (all of `surreal.test.ts`, `store.test.ts`,
  `projector.test.ts`, `tools.test.ts`, `note-md.test.ts`, `write-note.test.ts`).
- `bun run typecheck` exits 0 with no `patchedDependencies` in play.
- Optional but recommended: run `orc memory rebuild` (once the Task 9 CLI lands) or call
  `projector.rebuild()` directly against a project with real history, confirming the replayed
  read model matches what the surqlize adapter produced (same notes, same `revision` counts,
  Tier-2 `readCount`/`lastReadAt` reset to zero per D4 — expected on any rebuild).

### Effort
Half a day to a day: the class shape and most SurrealQL are already written and preserved at
the tag; the real work is the connect-call retarget, the drop-the-`deleted`-field cleanup, and
smoke-testing raw SurrealQL against v3.2.0 (not just trusting the v2.1.4-era code unchanged).

### Reversibility
Fully reversible — re-adding `surqlize` + the patch + `patchedDependencies` and swapping
`surreal.ts` back is a symmetric operation, and nothing about this scenario touches the log or
any committed event.

## 3. Scenario B — happy path: drop the patch when surqlize PR #51 releases

**This is the default desired end-state** (per the SURQLIZE DEBT entry in
`.superpowers/sdd/progress.md`: "carrying `patches/surqlize@0.1.0.patch` until surqlize PR #51
releases → then drop patch + bump surqlize").

### Trigger
surqlize publishes a release that includes the PR #51 fix (the `infer` → `Infer` rename, or
equivalent) to a real npm version.

### Blast radius (exact files)
| File | Change |
|---|---|
| `plugins/memory/package.json` | Bump `"surqlize"` to the fixed version |
| `package.json` (root) | Remove the `patchedDependencies` entry (or the whole key if it's the only one) |
| `patches/surqlize@0.1.0.patch` | Delete |
| `bun.lock` | Regenerated |

**Untouched:** `plugins/memory/src/surreal.ts` itself (the adapter code doesn't change — only
the dependency it imports does), everything downstream of it.

### Steps
1. Confirm the release includes PR #51 (check the surqlize changelog / the PR itself for the
   merge + release tag).
2. Bump the version in `plugins/memory/package.json`.
3. Delete `patches/surqlize@0.1.0.patch` and the `patchedDependencies` entry in root
   `package.json`.
4. `bun install`.
5. `bun run typecheck` — should now pass against surqlize's own (fixed) `.d.ts`, with no local
   patch propping it up.
6. `bun test plugins/memory` — should be unaffected (same adapter code, same behavior).

### Verify
`bun run typecheck` exit 0 and `bun test` green with **zero** entries in `patchedDependencies`
and no `patches/surqlize@0.1.0.patch` file present.

### Effort
Under an hour — this is a version bump plus deleting two things, not a code change.

### Reversibility
Trivial — re-pin to `0.1.0` and restore the patch from git history if the new release
regresses something else.

## 4. Scenario C — SurrealDB server version change

### Trigger
A need (or forced move, e.g. a security fix only in a newer image) to change the pinned
`surrealdb/surrealdb:v3.2.0` server version — up or down.

### Blast radius (exact files)
| File | Change |
|---|---|
| `docker-compose.yml` | `image:` tag (currently `surrealdb/surrealdb:v3.2.0`, line 17) and possibly the `command:` CLI flags (line 18: `start --user root --pass orc --bind 0.0.0.0:8000 memory`) if the target version renames/removes flags |
| `plugins/memory/src/surreal.ts` | Only if the new version's SurrealQL/behavior actually differs in a way the adapter depends on (e.g. the v3.2.0-specific "SELECT throws on a never-written table" behavior the current `DEFINE TABLE` bootstrap comment calls out at `surreal.ts:40-44`) |

**Untouched:** everything above the adapter — contracts, log, `MemoryStore`, tools, projector
logic (only its `rebuild()` gets invoked, not edited).

### Steps
1. Change the `image:` tag in `docker-compose.yml`; adjust `command:` flags only if the new
   version's CLI changed them (the v2.1.4→v3.2.0 jump needed **no** flag changes per the ledger
   — "SurrealDB v3.2.0 booted HEALTHY with the SAME v2-era flags").
2. `bun run db:up` (recreates the container on the new image; `docker-compose.yml`'s
   healthcheck — `/surreal isready` — gates readiness).
3. Smoke-test the adapter's raw-query paths (the `DEFINE TABLE` bootstrap, any raw escape
   hatches) against the new version before trusting it.
4. Run `orc memory rebuild` (or `projector.rebuild()` directly) to repopulate SurrealDB from the
   log on the new server version — this is not optional, since a version swap should be treated
   as a fresh store.

### Verify
Container healthy (`docker compose ps` / the compose healthcheck), `bun test plugins/memory`
green against the new server, rebuild completes and read-back matches pre-swap note count/content
(minus Tier-2 stats, which always reset on rebuild).

### Effort
An hour to half a day, depending on whether the new version changes any raw SurrealQL behavior
the adapter leans on.

### Reversibility
Reversible by reverting the image tag and re-running `db:up` + rebuild — the log doesn't care
which server version last held the projection.

### Constraint on downgrades
**surqlize needs server ≥3.0** while it's in use (the PIVOT ledger entry: "surqlize 0.1.0 …
needs server 3.x+client 2.x"). The current adapter's `DEFINE TABLE` bootstrap exists specifically
because v3.2.0's `SELECT` throws on a table that's never been written, unlike v2.x's
auto-vivify-on-write behavior — surqlize's builder has no raw escape hatch to route around a
behavior difference like that itself. So: don't downgrade the server below v3.0 while surqlize
is the adapter (Scenario B/current state); that constraint disappears if Scenario A's hand-rolled
adapter is in place, since it already targeted v2.1.4 successfully.

## 5. Scenario D — swap SurrealDB entirely for another store

### Trigger
A structural reason to leave SurrealDB altogether (e.g. an operational/licensing constraint, or
a future workload SurrealDB doesn't fit well — vector-at-scale, say).

### Blast radius (exact files)
| File | Change |
|---|---|
| `plugins/memory/src/surreal.ts` | Replaced by a new adapter file (new class, e.g. `PostgresMemory`/`whateverMemory`) implementing the same method set the `MemoryStore` gateway calls: `open/applyWritten/applyDeleted/get/list/search/bumpRead/getCursor/setCursor/clear/close` |
| `plugins/memory/src/store.ts` | One-line import swap (`import { SurrealMemory } from './surreal'` → the new adapter); the gateway's own logic (§4.4 of the design — event-first write, malformed-input rejection, provenance stamping) doesn't change, since it only calls the adapter's public methods |
| `plugins/memory/src/index.ts` | Swap the `SurrealMemory.open(...)` construction (currently `index.ts:20-21`) for the new adapter's equivalent open call, and update `opts.config.projectDbUrl`'s meaning/shape if the new store's connection string differs |
| `plugins/memory/package.json` | Drop `surrealdb`/`surqlize`, add the new store's client dependency |
| `docker-compose.yml` | Replace (or add) the `surrealdb` service with the new store's service |
| `packages/kernel/src/config.ts` | `projectDbUrl` field stays (RM4: "its own boundary, distinct from the Postgres event-log URL") — only its default/validation may need adjusting for the new store's URL scheme |

**Untouched:** `packages/contracts/src/memory.ts` (the `MemoryNote`/`MemoryStore` contract),
the event log and `memory_written`/`memory_deleted` events, `plugins/memory/src/tools.ts` (the
agent tools call `MemoryStore`, never a store internal), `note-md.ts`/`write-note.ts` (the
vault projection is independent of which read-model store backs SurrealDB-shaped queries).
Full-text search, tag/category filtering, and link-graph retrieval (design §4.4, D6) would need
re-implementing against the new store's query surface, but the **shape** of what `list`/
`search` return (`NoteSummary[]`) doesn't change.

### Steps
1. Design-review the new store against the same requirements SurrealDB was chosen for (design
   §4.2: "multi-model fit — document body, graph links, vector-ready, full-text") — this is a
   real design decision, not a mechanical swap, and deserves its own spec note before code.
2. Implement a new adapter class with the exact method set above; port the `open()` bootstrap
   pattern (schema/table setup) to whatever the new store needs.
3. Add the new store's service to `docker-compose.yml` (`bun run db:up` picks it up).
4. Swap the one import + construction call in `store.ts` / `index.ts`.
5. Port `plugins/memory/src/surreal.test.ts`'s test *cases* (not its SurrealQL specifics) to the
   new adapter — same behaviors: write/update/revision, search matching, cursor round-trip,
   bumpRead merge-safety, delete.
6. `bun install`, `bun run typecheck`, `bun test plugins/memory`.
7. Rebuild the read model from the log against the new store (`projector.rebuild()` / `orc
   memory rebuild`) — this is the whole point of D1: the new store starts empty and is
   populated entirely from `memory_*` events, never from a data export/import of the old store.

### Verify
Same as Scenario A/C: full `plugins/memory` suite green, typecheck clean, rebuild-from-log
produces a read model with the same notes/content as before the swap (Tier-2 stats reset).

### Effort
Multi-day — this is the only scenario that's a real implementation task (new adapter + new
query surface for search/filter/graph), not a retarget or a version bump. Bounded, but not
small.

### Reversibility
Reversible in principle (swap the import back, bring the old service back up, rebuild from the
log again) as long as the old adapter file is kept around (e.g. via git history) rather than
deleted outright — same "the log is truth, projections are disposable" property that makes the
forward swap safe also makes reverting it safe.

## Summary table

| Scenario | Trigger | Effort | Reversibility |
|---|---|---|---|
| A. surqlize → hand-rolled | surqlize proves unviable / patch breaks / PR #51 stalls + new blocker | ~0.5–1 day | Full |
| B. Drop patch (PR #51 ships) | Upstream fix released | <1 hour | Trivial |
| C. Server version change | Need/forced move off v3.2.0 | ~1 hour–0.5 day | Full |
| D. Swap SurrealDB entirely | Structural reason to leave SurrealDB | Multi-day | Full (in principle) |

All four are bounded by the same invariant (§1): the Postgres event log never moves, the
`MemoryStore` contract never moves, and every read-model change ends in a `rebuild()` replay —
never a data migration of truth.
