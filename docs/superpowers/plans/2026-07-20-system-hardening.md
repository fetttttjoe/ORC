# System hardening implementation plan

**Source:** Repo-wide audit, 2026-07-20, against the working tree (48 uncommitted files, 1,213 insertions) — not HEAD
**Baseline:** `bun run typecheck` clean; `bun test` 459 pass / 2 skip / 0 fail in 138s across 63 files
**Approach:** Vertical TDD slices, ordered by severity. Every slice has a test that fails against current code first.
**Sequencing:** This plan lands before `docs/superpowers/plans/2026-07-20-sourced-research.md` — it fixes defects in shipped code, that one adds a feature.
**Deferred:** four items with real ceilings but no present bite — `docs/IDEAS.md` entries 4–7.

Total: ~150 lines of production change, ~120 lines of new test, ~45 lines deleted.

## Status — 2026-07-20: COMPLETE

All 19 slices implemented. Final verification:

- `bun run typecheck` — 0 diagnostics
- `bun test` — **467 pass / 2 skip / 0 fail** across 65 files (baseline was
  459/2/0 across 63; the 2 skips remain the live-provider tests)
- `bun audit` — no vulnerabilities
- `git diff --check` — clean
- `orc_test_*` databases: 257, none removed

**~~Where coverage is weaker than the rest~~ — closed 2026-07-20.** Slice 4 (the
cancel/finish race) shipped argued-from-the-code rather than demonstrated: no
test drove the interleaving, and the existing cancel tests only covered the
already-terminal case. It now has one.

The seam turned out to be `log.transaction` itself, not the fault injection
point the note above assumed. A `beforeTransaction` hook in
`dbos-port.test.ts` commits a competing `running→cancelled` immediately before
the finish path opens its transaction — the one window that reproduces the
defect under both shapes of the code. Against the original two-transaction form
(status read in `fn()`, append from `toEvents`) the cancel lands after the read
and is overwritten: **verified failing with `Expected: "cancelled" / Received:
"done"`**, which is precisely the failure this slice describes. Against the
shipped one-transaction form the same cancel commits first and the re-check
honours it. The test arms only once `step_completed` is committed, so the
injected cancel cannot land mid-run where the old code's read would have caught
it and the test would have passed vacuously.

Every slice in this plan is now demonstrated by a failing-then-passing test.

**Correction to slice 13 — the MCP stderr item was wrong and is withdrawn.**
The uncommitted `stderr: 'pipe'` → `'ignore'` change was deliberate, not a
regression: `mcp-client/src/index.test.ts` asserts "a crashing server identifies
the server without leaking stderr". A third-party server's stderr is untrusted
output that would land in the event log and the vault's `log.md`. Restoring the
capture reintroduced that leak and the existing test caught it. Reverted; the
reasoning is now a comment at the call site so it is not re-litigated.

**Slice 2 shipped stronger than planned:** `clear()` became one transaction
rather than a reordering. Same size, and it makes the partial state unreachable
instead of merely reordering which partial state is possible.

**Slice 5 shipped narrower than planned:** hashing all env values would have put
a verifier for an inlined literal secret into `trust.json` and broken rotation —
`trust.test.ts:49` already pinned that intent. Only `$NAME` indirections are
covered, which closes the exfiltration path without hashing secret material.

---

## Phase 1 — Durability: state that is lost, corrupted, or wedged

### 1. Make run scheduling replay-deterministic

- **Why:** The most severe defect found. `DBOS.startWorkflow` binds child handles **positionally**, not by the explicit `workflowID`: `dbos-executor.js:280-285` looks up `(callerID, callerFunctionID)` and returns `result.childWorkflowID` without ever comparing it to the requested id. `runWorkflow` launches children from inside the `Promise.race` settle loop, so launch order is a function of real completion timing on the first run, but of `Map` insertion order on replay (every `getResult` is pre-recorded, so all promises are already settled). Different order → different slots → a step receives another step's handle.
- **Failure:** Plan `[A, B]` independent, `C dependsOn A`, `D dependsOn B`. First run: B settles at 5s (launches D), A at 20s (launches C). Crash at 25s. On replay `race` returns A first, so C takes D's slot and D takes C's. `pending` is now `{C → D's promise, D → C's promise}`, and `pending.delete(r.stepId)` deletes by the id in the *result*, never the key holding that promise. The map never drains: `orcRun` busy-loops on an already-resolved promise at 100% CPU, never appends its finish event, and the task is pinned `running` forever — its parent's split never resolves.
- **Files:** `packages/kernel/src/execution/dbos-port.ts`, `packages/kernel/src/execution/resume-fixture.ts`, `packages/kernel/src/execution/resume.test.ts`
- **RED:** Add a second resume scenario: two *independent* steps, one fast and one slow, marker-gated so the slow one is still in flight at the kill. Crash after the fast step records its result, restart, and require the task to reach `done` with each step's recorded status matching its own id. This hangs against current code — bound the test so a hang fails rather than wedging the suite.
- **GREEN:** Replace continuous scheduling with wave scheduling: launch every ready step, `await Promise.allSettled` on the wave, recompute readiness from `(done, failed)`. Launch order becomes a pure function of plan topology and completed-set, identical on first run and replay. This **deletes** `pending` and the re-entrant `launchReady`.
- **Cost, stated honestly:** waves lose the property the comment at `:326` claims — a fast step's dependents now wait for its whole wave. A positional fix preserving continuous scheduling needs DBOS's `startWfFuncId`, which the public `DBOS.startWorkflow` params do not expose. Correctness first; revisit if wave latency measurably hurts.
- **Verify:** `bun test packages/kernel/src/execution/resume.test.ts packages/kernel/src/execution/dbos-port.test.ts packages/kernel/src/execution/split-run.test.ts` passes.

### 2. Fix `clear()` ordering so a partial wipe cannot orphan the graph forever

- **Why:** `surreal.ts:205-209` deletes notes, then meta, then links, as three unsynchronized statements. Every other projection path is per-event transactional with the cursor; this is the one place the ordering is inverted.
- **Failure:** `rebuild()` with 500 events applied (cursor 500). `delete(Note)` commits, the Surreal socket drops before `delete(Meta)`. `drainFrom(0)` now rejects all 500 events as `e.seq <= cursor` and applies nothing. The graph is permanently empty; every later `start()`/`catchUp()` also drains zero; `probeMemory` reports healthy because `countAfter(500)` is legitimately 0. Agents get empty searches with "absence is not proof" and no error is raised anywhere.
- **Files:** `plugins/memory/src/surreal.ts`, `plugins/memory/src/surreal.test.ts`
- **RED:** Apply events, then simulate a partial clear (delete the note table only), then `rebuild()`, and require every note back. Fails today.
- **GREEN:** Move `delete(Tb.Meta)` first. Every crash ordering then self-heals: cursor 0 with stale rows replays fully, since writes re-upsert, deletes re-delete, and `delete(Link).where(fromId…)` re-materializes edges.
- **Verify:** `bun test plugins/memory/src/surreal.test.ts plugins/memory/src/projector.test.ts` passes.

### 3. Deliver split results that arrived before the gate

- **Why:** `dbos-port.ts:230` filters gate targets to splits that are `!s.resolved`. But `split_resolved` is appended by the router at *resolution* time, not consumption time (`signal-router.ts:96-113` appends, then `DBOS.send`s). So a split that resolved before the parent reached its gate is filtered out, the parent never `recv`s it, and the durable message sits unconsumed forever. The comment at `:223-226` has the premise backwards: an already-resolved split is exactly the one with a message waiting.
- **Failure:** An api-loop step calls `task_split` at iteration 1 under auto-approve, does three more tool iterations, then calls `join_splits` with no ids (`loop.ts:251` passes `[]`). The child finished during those iterations. `own` computes `[]`, and the model is told its child produced nothing — the child's summary and `notes[]`, the entire point of the split protocol, are silently dropped.
- **Files:** `packages/kernel/src/execution/dbos-port.ts`, `packages/kernel/src/execution/split-run.test.ts`
- **RED:** Scenario where the child completes *before* the parent reaches `join_splits`; require the parent to receive the child's summary and notes. `split-run.test.ts` currently yields the gate immediately after `task_split`, so the child can never win that race — the new test must let it.
- **GREEN:** Track consumed splitIds in a workflow-local `Set` rather than using `resolved` as the consumed marker. It rebuilds correctly on replay because each `gate:targets:<toolCallId>` checkpoint replays its recorded value in order.
- **Verify:** `bun test packages/kernel/src/execution/split-run.test.ts` passes.

### 4. Close the cancel/finish race

- **Why:** `dbos-port.ts:347-353` reads task status inside `fn()` but appends the terminal status from `toEvents`, which `makeCheckpoint` runs in a *separate* transaction. The `status !== running` guard is TOCTOU. `cancelOne` (`:393-403`) does read and write in one locked transaction; this path does not.
- **Failure:** Two-step run, step `b` completes, `finish` reads `status = running` (a `byTask` read plus fold — tens of ms on a large task). A human runs `orc cancel` in that window; it takes the project lock, re-checks, appends `running→cancelled`, prints `cancelled`. Then `finish` appends `running→done`. `fold` is last-seq-wins with no `from` check (`projections.ts:183-189`), so the task reports **done** — and if the router already sent the parent `outcome: cancelled`, the split payload and the task status now disagree.
- **Files:** `packages/kernel/src/execution/dbos-port.ts`, `packages/kernel/src/execution/dbos-port.test.ts`
- **RED:** Append `running→cancelled` between the finish read and its draft append; require the final status to stay `cancelled`.
- **GREEN:** Re-check status inside the same `log.transaction` as the append, with an explicit idempotency key, mirroring `cancelOne`.
- **Verify:** `bun test packages/kernel/src/execution/dbos-port.test.ts` passes.

---

## Phase 2 — Trust and redaction boundaries

### 5. Fingerprint MCP env **values**, not just key names

- **Why:** `trust.ts:26` hashes `Object.keys(cfg.env ?? {}).sort()`. `.gitignore:4` un-ignores `.orc/config.json` and the README instructs committing it, so the declaration is a shared, PR-reachable artifact and the fingerprint is the only thing between a config edit and re-consent. The comment justifying the gap is wrong: config env values are `$NAME` *references*, so hashing them leaks nothing and rotating the actual secret never changes the declaration.
- **Failure:** Repo declares `"env": {"API_KEY": "$WEATHER_TOKEN"}`; user runs `orc mcp trust weather`. A PR changes only the value to `"$ANTHROPIC_API_KEY"`. Command, args, and key names are byte-identical, so the fingerprint is unchanged and `isMcpTrusted` returns true. `resolveEnv` (`mcp-client/src/index.ts:22`) reads `process.env.ANTHROPIC_API_KEY` and hands it to the third-party child process. No prompt, no warning.
- **Files:** `packages/kernel/src/plugins/trust.ts`, `packages/kernel/src/plugins/trust.test.ts`
- **RED:** Grant trust, change only an env *value*, require `isMcpTrusted` to return false.
- **GREEN:** `Object.entries(cfg.env ?? {}).sort()`. Delete the two-line comment defending the gap.
- **Verify:** `bun test packages/kernel/src/plugins/trust.test.ts packages/kernel/src/plugins/host.test.ts` passes.

### 6. Route DBOS step results through the redactor

- **Why:** `redact.ts:1-3` claims to be the one storage-boundary normalizer and that "every projection downstream sees only redacted data". True for `events` and `operations`; false for DBOS. Confirmed in the vendored SDK at `dbos-executor.js:619-623`: `runStep` serializes the return value into `operation_outputs.output`. Both `makeCheckpoint` (`:78`) and `makeOperation` (`:100`) return raw results. `deriveSystemUrl` (`config.ts:70`) only swaps the pathname — same cluster, same credentials.
- **Failure:** A step's agent reads a `.env` in its workspace. The `tool_result` event is correctly redacted in `events.payload`, while the identical object is written verbatim to `<db>_dbos_<projectId>.dbos.operation_outputs.output` in plaintext. Same for MCP tool outputs and `callModel`'s full `TurnResult` text.
- **Files:** `packages/kernel/src/storage/index.ts`, `packages/kernel/src/execution/dbos-port.ts`, `packages/kernel/src/execution/dbos-port.test.ts`
- **RED:** Run a step whose tool result contains an env secret; assert the secret is absent from `operation_outputs.output`.
- **GREEN:** Expose `redact` on the `Storage` facade and pass step results through it inside both `runStep` bodies. `Redactor` is typed `Record<string, unknown> → Record<string, unknown>`, so non-object results (the `budget:N` checkpoint returns a number) need a passthrough guard.
- **Verify:** `bun test packages/kernel/src/execution/dbos-port.test.ts packages/kernel/src/storage.test.ts` passes.

### 7. Broaden secret key matching — without the obvious trap

- **Why:** `redact.ts:7` carries `accesstoken`/`refreshtoken` but nothing matching a bare or prefixed token name. Value-based redaction only catches strings already in `process.env`, so a secret *minted during a run* is stored plaintext.
- **Failure:** A trusted GitHub MCP server's `create_token` tool returns `{"token": "ghp_…"}`. The key matches no suffix and the value was never in `process.env`, so it reaches `events.payload` in plaintext and then the vault projector's `log.md` on disk.
- **The trap — do not add bare `'token'`:** `runToken` normalizes to `runtoken`, which `endsWith('token')`, and `runToken` is required in most payload schemas (`events.ts:50,55,61,68,76,85,90,95`) validated *after* redaction (`event-log.ts:50-51`). Adding it fails validation on nearly every event.
- **Files:** `packages/kernel/src/redact.ts`, `packages/kernel/src/redact.test.ts`
- **RED:** Assert `authToken`/`bearerToken`/`sessionToken`/`apiToken` values are redacted **and** that an event carrying `runToken` still validates and round-trips.
- **GREEN:** Add `'authtoken'`, `'bearertoken'`, `'sessiontoken'`, `'apitoken'` to the suffix list.
- **Verify:** `bun test packages/kernel/src/redact.test.ts packages/kernel/src/storage.test.ts` passes.

---

## Phase 3 — Correctness and honesty

### 8. Stop breaking mermaid on agent-authored titles

- **Why:** `render.ts:36` — the deliberately shared escaper — replaces only `"`. `MemoryNoteInput.title` is `z.string().min(1).max(200)` with no newline restriction, and the tool schema advertises the same. Both `memory-index.ts:21` and `render.ts:160` feed titles straight in.
- **Failure:** `memory_write({title: "Auth\n```\n## Injected heading\n"})` yields an `index.md` with an odd number of fences, a mermaid block that terminates mid-declaration, and agent-controlled markdown rendering as a real heading. Every note in that section becomes invisible.
- **Files:** `packages/vault-projector/src/render.ts`, `packages/vault-projector/src/render.test.ts`, `plugins/memory/src/memory-index.test.ts`
- **RED:** Render a note whose title contains a newline and a fence; require a parseable single-block graph.
- **GREEN:** Collapse `[\r\n]+` to a space in the shared escaper, covering both call sites.
- **Verify:** `bun test packages/vault-projector/src/render.test.ts plugins/memory/src/memory-index.test.ts` passes.

### 9. Normalize tags so search and filter agree

- **Why:** `surreal.ts:166-171` matches `n.tags.contains(q)` against a lowercased query, on the stated convention that tags are stored lowercase — but `memory.ts:56` applies no normalization, and `matchFilter` (`surreal.ts:187`) compares `filter.tag` case-exactly. The two retrieval paths do not even agree with each other.
- **Failure:** A scout writes `tags: ['Postgres']`. `memory_search({query: 'Postgres'})` lowercases to `postgres`, `contains` is false, and the tag branch never fires — the note surfaces only if the word also appears in title/summary/body. `orc memory ls --tag Postgres` matches; `--tag postgres` does not. Silent partial recall on the primary retrieval tool.
- **Files:** `packages/contracts/src/memory.ts`, `packages/contracts/src/memory.test.ts`, `plugins/memory/src/surreal.test.ts`
- **RED:** Write `['Postgres']`, search `Postgres` and `postgres`, filter by both cases; all four must hit.
- **GREEN:** Lowercase tag items in `MemoryNoteInput`. This applies on replay too, since the projector re-parses each payload, so a rebuild converges existing notes onto the normalized form.
- **Verify:** `bun test packages/contracts/src/memory.test.ts plugins/memory/src/surreal.test.ts plugins/memory/src/tools.test.ts` passes.

### 10. Stop reporting a revision the write did not produce

- **Why:** `store.ts:30` returns `(await surreal.get(...)) ?? {…, revision: 1}`. The projector is asynchronous, so inside the flush window this is the *previous* revision, and before any projection it fabricates `revision: 1` with empty timestamps. `tools.ts:105` hands it to the model as `{id, revision}`.
- **Failure:** An agent updates `auth` a 4th time before the projector drains and is told `revision: 3` — the value from before its own write. Any agent reasoning about whether its update landed is working from a number that was never true.
- **Files:** `plugins/memory/src/store.ts`, `plugins/memory/src/tools.ts`, `plugins/memory/src/store.test.ts`, `plugins/memory/src/tools.test.ts`
- **RED:** Write twice without draining the projector; require the tool result not to carry a stale revision.
- **GREEN:** Drop `revision` from the write tool result. The comment already concedes "best-effort"; the honest move is not to emit the field. Callers needing the true revision read the note.
- **Verify:** `bun test plugins/memory/src/store.test.ts plugins/memory/src/tools.test.ts` passes.

### 11. Report cancellation as cancellation, not as a crash

- **Why:** `main.ts:126` does `return await handle.wait()`, and `wait` is `handle.getResult()` (`dbos-port.ts:370`), which **rejects** for a cancelled workflow — the repo's own `split-run.test.ts:245` acknowledges this. `execAction` (`main.ts:305-312`) only handles the resolve branch.
- **Failure:** `orc run` in one terminal, `orc cancel` in another. The first prints a raw DBOS error through `formatCliError` and exits 1, indistinguishable from a crash, while `orc status` correctly shows `cancelled`. The CLI's own intro promises "ctrl-c stops the run", so this is an advertised path. Every stub port in the CLI tests has `wait: async () => outcome`, so no test ever exercises a rejecting wait.
- **Files:** `packages/cli/src/main.ts`, `packages/cli/src/main.test.ts`
- **RED:** Stub port whose `wait` rejects with a cancellation error; require `run finished: cancelled` and exit 0.
- **GREEN:** Catch in `execAction` and map a cancellation rejection to the cancelled outcome; other rejections keep current behavior.
- **Verify:** `bun test packages/cli/src/main.test.ts` passes.

### 12. Give humans the epistemic honesty the model already gets

- **Why:** `main.ts:499-517` — `memory ls` and `memory search` end in a bare `for … console.log`, so an empty result prints zero bytes and exits 0. `tasks` (`main.ts:265`) prints `_no tasks_`, and the *agent* path already returns "no note matched — absence is not proof a decision doesn't exist" (`tools.ts:129`).
- **Failure:** A user whose Surreal projection is lagging runs `orc memory search auth`, sees a blank line, and concludes the note doesn't exist — when the honest answer is that the read model returned nothing.
- **Files:** `packages/cli/src/main.ts`, `packages/cli/src/main.test.ts`
- **RED:** Both commands on an empty project must print a sentinel.
- **GREEN:** The same `_no notes_` sentinel `tasks` already uses.
- **Verify:** `bun test packages/cli/src/main.test.ts` passes.

### 13. Three small honesty and cost fixes

- **Why:** Independent one-liners, grouped to keep the diff count down.
  - `dbos-port.ts:241,251` — `DBOS.recv(topic, 60)` records **two durable rows per minute per parked gate**, and replays every one sequentially on recovery. An overnight `ask_human` gate is ~1,440 rows; a weekend is ~3,600, each a DB round-trip on restart. Verified safe to change: `recv`'s wait loop checks cancellation every ≤10s independently of the outer timeout (`system_database.js:1255-1261`), so raising 60 → 3600 is 60× fewer rows with identical semantics. The `ponytail:` comment at `:249` names the *timeout* ceiling, not this one.
  - `budget.ts:49-58` — the discard ladder can blank `id` and `scope` while still emitting `next: 'memory_read with a larger budget'`, a hint the agent cannot act on, and the result no longer satisfies `MemoryNote`. Move `id` and `scope` off the ladder; they are bounded at 128 chars each and are the only fields that make the response actionable.
  - `mcp-client/src/index.ts:59` — the uncommitted change from `stderr: 'pipe'` to `'ignore'` dropped the failing server's own stderr from the startup error, which was usually the actual cause ("module not found", "missing env var"). Restore the capture in the error path only.
- **Files:** `packages/kernel/src/execution/dbos-port.ts`, `plugins/memory/src/budget.ts` (+test), `plugins/mcp-client/src/index.ts` (+test)
- **Verify:** `bun test plugins/memory/src/budget.test.ts plugins/mcp-client/src/index.test.ts` passes.

---

## Phase 4 — Tests that cannot currently fail

Each of these is green today and would stay green through the regression it names.

### 14. Pin rebuild-reproduces-provenance

- **Why:** The subsystem's central claim has no test. Existing rebuild assertions cover "deleted stays deleted" (`projector.test.ts:35`) and edge reconstruction (`reuse.integration.test.ts:38`), but nothing checks `revision`, `createdAt`, `createdBy`, or `updatedBy` after `rebuild()` — exactly the fields `applyEvent` derives read-then-write, and exactly what `planGraphHash` (`grounded-plan.ts:17-22`) hashes. Drift here changes an approved plan's identity.
- **Files:** `plugins/memory/src/projector.test.ts`
- **Change:** Write a note twice, snapshot `allNotes()`, `rebuild()`, `toEqual` the snapshot. ~10 lines.

### 15. Make the subscribe test assert what its name claims

- **Why:** `kernel.test.ts:123-130` is named "delivers appended events by seq" but asserts only `seen.length > 0` — break `toRecord` so every record carries `seq: 0` and it still passes. It also uses a bare 100ms sleep for a LISTEN/NOTIFY round-trip, while every other subscription test in the repo uses deadline polling (`storage.subscribe.test.ts:55`, `feedback-gate.test.ts:34`, `signal-router.test.ts:87`).
- **Files:** `packages/kernel/src/kernel.test.ts`
- **Change:** Deadline poll, assert `seen` equals the appended seqs. ~4 lines.

### 16. Replace the tautological tier guard

- **Why:** `tools.test.ts:138-144` compares `memoryTools(store, author)` against `memoryTools(store, author, 'verify')` — the same function at the same tier, since `verify` is the default. It proves only that the default maps to verify, which the scout/auditor tests at `:117-136` already imply. Add an epistemics fragment to the verify descriptions and both sides move together: every plain worker step (the `tierForRole` default in production) silently ships a changed tool surface.
- **Files:** `plugins/memory/src/tools.test.ts`
- **Change:** Assert verify descriptions against literals, or delete the test. ~5 lines.

### 17. Pin `isConnectionRefused`

- **Why:** `errors.ts:18-24` recursively walks `AggregateError.errors` and `.cause` chains, guarding the most common new-user failure, and has zero coverage — `bin.test.ts:30-40` points at a dead port but only runs `--help`, which returns at `bin.ts:48` before connecting. A `pg` or Bun upgrade that changes nesting depth or the code string silently turns "start it with: docker compose up -d" back into a raw driver error.
- **Files:** `packages/kernel/src/errors.test.ts`
- **Change:** Three literal error shapes (flat, `AggregateError`, nested `cause`) plus one negative. ~6 lines, no database.

### 18. Fix the fixture timestamp overflow

- **Why:** `grounded-plan.test.ts:72-82` interpolates `2026-01-01T00:00:0${seq}.000Z` from a `describe`-scoped counter. The fourth test already consumes seq 9–11, producing `00:00:011.000Z` — an invalid ISO timestamp. It passes only because that test asserts on ids, and because the test that *does* assert `createdAt`/`updatedAt` (`:105-106`) happens to run while seq ≤ 5. Insert one `it()` before it and the provenance assertions start comparing malformed strings.
- **Files:** `packages/kernel/src/execution/strategies/grounded-plan.test.ts`
- **Change:** `String(seq).padStart(2, '0')`. 1 line.

---

## Phase 5 — Deletion

### 19. Delete dead code

- **`packages/vault-projector/src/render.ts:169-181`** — `masterplanDag` is exported from `render.ts` but not re-exported by `index.ts:8`, and has zero production callers; only its own tests (`render.test.ts:113-142`) consume it. The shared `mermaidGraph` helper stays, since `taskExpansionGraph` needs it. **−13 impl, −30 test.**
  - Related, decide at the same time: `NOTE_KIND.plan` is missing from `memory-index.ts:9-13` `SECTIONS`, so plan notes get vault files but never appear in `index.md`. That gap is probably why `masterplanDag` was written. Either wire it in as a fourth section (~3 lines) or delete and accept that plan notes are reachable by path only. **Deleting is the default** — nothing has asked for a plan DAG view.
- **`packages/kernel/src/plugins/host.ts:33,55`** — `PluginHost.trust` is read once at construction, exported on the interface, and consumed nowhere outside the `refValidator` closure at `:76`; every other site uses fresh-read predicates. It is the only stale-trust read in the codebase. Inline `loadTrust(config.dir)` in `refValidator`. **−2 lines.**
- **Verify:** `bun run typecheck` clean; `bun test` passes.

---

## Phase 6 — Final verification

1. `bun run typecheck` exits 0 with no diagnostics.
2. `bun test` reports zero failures; the 2 live-provider skips remain the only skips.
3. `bun audit` reports no vulnerabilities.
4. Kill-9 resume with two independent out-of-order steps completes and binds each result to its own step (slice 1).
5. Partial Surreal clear followed by `rebuild()` restores every note (slice 2).
6. A step whose tool output contains an env secret leaves no plaintext in `operation_outputs` (slice 6).
7. Changing only an MCP env **value** in `.orc/config.json` revokes trust (slice 5).
8. `git status --short` shows only planned files; `git diff --check` reports no whitespace errors.
9. `SELECT count(*) FROM pg_database WHERE datname LIKE 'orc_test_%'` matches before and after. Existing stale test databases are not removed.

## Verification matrix

| Test | Expected result |
|---|---|
| Two-step out-of-order resume | Task reaches `done`; each result binds to its own step; no hang |
| Partial Surreal clear | `rebuild()` restores every note |
| Early-finishing child | Parent's `join_splits` receives its summary and notes |
| Cancel during finish | Final status stays `cancelled`; no competing `done` behind it |
| MCP env value changed | Trust revoked; server refuses to spawn |
| Secret in step output | Absent from `operation_outputs.output` |
| `runToken` after redaction | Still validates and round-trips |
| Newline in note title | `index.md` mermaid parses as one block |
| Mixed-case tag | Search and `--tag` both hit, either case |
| Write before projection | No stale revision reported to the model |
| Cancelled run via CLI | `run finished: cancelled`, exit 0 |
| Empty memory listing | Prints a sentinel, not zero bytes |
| Rebuild | Reproduces revision and provenance exactly |
| Full suite / typecheck / audit | Zero failures, diagnostics, vulnerabilities |

## Not in this plan

Four audited items with real ceilings but no present bite, recorded as `docs/IDEAS.md` entries 4–7: MCP grants binding the process rather than the tool surface; `index.md` rendering every note body on every event; test-helper connection pools never closed (measured 38/100, ~2.5× headroom); and `buildRuntime` leaking the projector and Surreal socket if `createDbosPort` throws (bounded in practice by `process.exit`).
