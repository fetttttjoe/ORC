# Neuron-like memory lifecycle and sourced web-research implementation plan

> **SUPERSEDED 2026-07-20 — do not execute.** Split into
> `docs/superpowers/plans/2026-07-20-sourced-research.md` (the sourced-research
> half, 5 slices, active) and `docs/IDEAS.md` entries 1–2 (the lifecycle half,
> deferred until real usage justifies it — with three known design fixes
> recorded there). Kept for the reasoning behind the deferred slices.

**Design:** `docs/superpowers/specs/2026-07-19-neuron-memory-web-research-design.md`
**Approach:** Vertical TDD slices; preserve Postgres as truth and SurrealDB as the only knowledge read model
**Compatibility:** Tool/application contracts may break. Historical memory events are decoded as protected durable notes to avoid needless data loss.
**Expected shape:** Two focused production modules (`activity.ts`, `lifecycle.ts`), removal of direct Surreal read counters, no dependency or SQL migration, and one explicit CLI adapter reusable by a future scheduler.

## Plan: Add event-derived note/link activation, explicit safe sweeps, restorable archives, and a sourced web-research skill

### Phase 1 — Contracts and pure foundations

1. **Define retention, citations, activation envelopes, and the clean read API**
   - **Why:** Every later slice needs one strict vocabulary, and activation must stay separate from authored note content so traffic cannot invalidate grounded-plan approval hashes.
   - **Files:** `packages/contracts/src/memory.ts`, `packages/contracts/src/memory.test.ts`, `packages/contracts/src/analysis.test.ts`
   - **RED:** Add contract tests requiring new writes to include `retention`, accepting `durable | expirable`, requiring at least one citation for `kind: research`, and rejecting more than 20 citations, non-HTTP(S) URLs, URL credentials, URLs over 2,048 characters, and titles over 300. Add assertions that stored citations carry `retrievedAt`, while `MemoryNote` itself has no activation fields.
   - **RED:** Add shape tests for `ActivationState`, `MemoryEntry { note, activation }`, `MemoryLaneRef`, depth (`shallow | normal | deep`), activation-bearing summaries, and neighbor results with an exact `path`.
   - **GREEN:** Introduce these concrete contracts (names stay fixed for every later task):
     ```ts
     export const RETENTION_CLASS = { durable: 'durable', expirable: 'expirable' } as const
     export const MEMORY_DEPTH = { shallow: 'shallow', normal: 'normal', deep: 'deep' } as const
     export const MemorySourceInput = z.object({ url: HttpUrl, title: z.string().max(300).optional() })
     export const MemorySource = MemorySourceInput.extend({ retrievedAt: z.string().datetime() })
     export const ActivationState = z.object({
       strength: z.number().nonnegative(), reinforcedAt: z.string().datetime(),
       hits: z.number().int().nonnegative(), effectiveStrength: z.number().nonnegative(), dormant: z.boolean(),
     })
     export const MemoryEntry = z.object({ note: MemoryNote, activation: ActivationState })
     ```
     Split strict writer input from stored note shape so the projector can stamp citation timestamps. Keep `retention`/`sources` in authored content; do not put activation in `MemoryNote`.
   - **Verify:** `bun test packages/contracts/src/memory.test.ts packages/contracts/src/analysis.test.ts` passes.

2. **Add canonical lifecycle/access events and close exhaustive event switches**
   - **Why:** Adapter traffic, retirement, and restore must be durable semantics before any projector or CLI code can use them.
   - **Files:** `packages/contracts/src/memory.ts`, `packages/contracts/src/events.ts`, `packages/contracts/src/events.test.ts`, `packages/contracts/src/execution.test.ts`, `packages/kernel/src/projections.ts`, `packages/kernel/src/projections.test.ts`, `packages/kernel/src/execution/signal-router.ts`, `packages/kernel/src/execution/signal-router.test.ts`
   - **RED:** Require `PAYLOAD_SCHEMAS` coverage for `memory_accessed`, `memory_retired`, and `memory_restored`. Reject access payloads with unsafe scope/id, over 100 notes/lanes, or a lane with an invalid kind. Reject retirement without a full note/activation/depth/reason/revision snapshot and restore without `retiredSeq` plus a full restored note.
   - **GREEN:** Add:
     ```ts
     MemoryAccessedPayload = { notes, lanes, mode: 'read' | 'neighbors', author }
     MemoryRetiredPayload = { note, activation, depth, classification, reasonCode, reason, asOf, author }
     MemoryRestoredPayload = { retiredSeq, note, author }
     ```
     Add all three kinds to `EventKind`/`PAYLOAD_SCHEMAS`. Kernel execution fold treats them as knowledge-only no-ops; the signal-router relevance map marks them false. Preserve exhaustive compiler checks.
   - **Verify:** `bun test packages/contracts/src/events.test.ts packages/contracts/src/execution.test.ts packages/kernel/src/projections.test.ts packages/kernel/src/execution/signal-router.test.ts` passes.

3. **Decode historical notes as durable and migrate every first-party writer/fixture to the strict contract**
   - **Why:** New callers must be explicit, while old append-only history must not become unreadable or accidentally sweepable.
   - **Files:** `packages/contracts/src/memory.ts`, `packages/contracts/src/memory.test.ts`, `packages/contracts/src/analysis.test.ts`, `packages/cli/src/main.ts`, `packages/cli/src/runtime.test.ts`, `packages/kernel/src/kernel.test.ts`, `packages/kernel/src/execution/finalize-plan-tool.test.ts`, `packages/kernel/src/execution/grounded-plan.integration.test.ts`, `packages/kernel/src/execution/memory-reuse.test.ts`, `packages/kernel/src/execution/split-run.test.ts`, `packages/kernel/src/execution/strategies/grounded-plan.test.ts`, `packages/vault-projector/src/render.test.ts`, `plugins/memory/src/budget.test.ts`, `plugins/memory/src/memory-index.test.ts`, `plugins/memory/src/note-md.test.ts`, `plugins/memory/src/project-isolation.test.ts`, `plugins/memory/src/reuse.integration.test.ts`, `plugins/memory/src/store.test.ts`, `plugins/memory/src/surreal.test.ts`, `plugins/memory/src/tools.test.ts`
   - **RED:** Add a fixture containing a pre-feature `memory_written` payload with no retention/sources and assert the event decoder yields `retention: durable`, `sources: []`. Confirm strict `MemoryNoteInput.parse()` still rejects a new write with omitted retention.
   - **GREEN:** Give `MemoryWrittenPayload` a legacy replay transform only; keep `MemoryNoteInput` strict. Add `retention: durable` and `sources: []` to every typed first-party note fixture/writer listed above. CLI `memory add` supplies durable unless its later explicit option overrides it.
   - **Verify:** `bun run typecheck` passes and `bun test packages/contracts/src/memory.test.ts plugins/memory/src/store.test.ts packages/kernel/src/execution/grounded-plan.integration.test.ts` passes.

4. **Implement deterministic activation math under a fake clock**
   - **Why:** Decay, reinforcement, saturation, and depth floors are the policy kernel; they must be pure before storage/routing code depends on them.
   - **Files:** create `plugins/memory/src/activity.ts`, create `plugins/memory/src/activity.test.ts`, modify `plugins/memory/src/index.ts`
   - **RED:** Test: strength `1` becomes `0.5` after 30 days and `0.125` after 90; reinforcement decays first then adds the impulse; repeated hits saturate at `8`; timestamps before/equal reinforcement do not increase strength; dormant begins below `0.125`; routing floors are shallow `0.5`, normal `0.125`, deep `0`.
   - **GREEN:** Export a plain `DEFAULT_ACTIVATION_POLICY`, `effectiveStrength(state, asOf, policy)`, `reinforce(state, at, impulse, policy)`, and `routingFloor(depth, policy)`. Use milliseconds and `2 ** (-elapsed / halfLifeMs)`; never call `Date.now()` inside a pure function.
   - **Verify:** `bun test plugins/memory/src/activity.test.ts` passes with exact/close-to assertions and no database.

5. **Return exact canonical lanes from graph ranking and blend lane/node activation**
   - **Why:** Reverse traversal currently loses authored edge identity, making exact lane reinforcement impossible.
   - **Files:** `plugins/memory/src/rank.ts`, `plugins/memory/src/rank.test.ts`, `packages/contracts/src/memory.ts`, `packages/contracts/src/memory.test.ts`
   - **RED:** Extend the existing `a → b → d` test to require the ordered canonical path. Add reverse traversal and require it to return the same `{fromId,toId,kind}` lane identity as forward traversal. Add tests that selected-depth floors remove weak lanes/nodes, deep includes them, and authored confidence still affects order.
   - **GREEN:** Extend internal `Edge` with one canonical `lane: MemoryLaneRef`; forward/reverse adjacency records share that lane. Carry `path` in each frontier/best result. Keep current typed-link weight, confidence, graph-distance decay, best-path, floor, and cap behavior; multiply by activation capped at `1` only after depth filtering.
   - **Verify:** `bun test plugins/memory/src/rank.test.ts packages/contracts/src/memory.test.ts` passes.

### Phase 2 — Rebuildable activation and depth-aware memory tools

6. **Replace projection-only read counters with note/lane activation tables**
   - **Why:** `readCount`/`lastReadAt` cannot authorize deletion because a Surreal rebuild erases them; one transaction must apply content, traffic, and cursor.
   - **Files:** `plugins/memory/src/surreal.ts`, `plugins/memory/src/surreal.test.ts`, `plugins/memory/src/store.ts`, `plugins/memory/src/store.test.ts`
   - **RED:** Replace the `bumpRead` test with event-driven assertions: a write creates note/link activation at strength `1`; a later `memory_accessed` direct read decays then reinforces the note; a neighbors access reinforces each deduplicated note/lane by `0.5`; saturation is `8`; deleting a note removes incident live activation. Assert a plain `get()` performs no Surreal write.
   - **GREEN:** Remove `readCount`, `lastReadAt`, and `bumpRead()`. Add separate note/lane activation tables keyed by scoped note and canonical lane. In `applyEvent`, read/decay/reinforce/upsert activation inside the same transaction that applies content/links and advances `meta.cursor`. Preserve lane activation for retained authored links; delete activation only when a link disappears or an incident note leaves the live graph.
   - **GREEN:** Add `getEntry(id, scope, asOf)`, activation-bearing `list/search`, `allEntries(asOf)`, and a transactionally consistent `lifecycleSnapshot(asOf)` returning `{throughSeq, notes, lanes}`.
   - **Verify:** `bun test plugins/memory/src/surreal.test.ts plugins/memory/src/store.test.ts` passes against throwaway Surreal/Postgres databases.

7. **Extract agent traffic from successful tool results and project it in event order**
   - **Why:** Agent reads are already durable; duplicating them as new access events would bloat history. The projector needs one tested parser that cannot turn malformed output into traffic.
   - **Files:** `plugins/memory/src/activity.ts`, `plugins/memory/src/activity.test.ts`, `plugins/memory/src/projector.ts`, `plugins/memory/src/projector.test.ts`, `plugins/memory/src/index.ts`
   - **RED:** Build real `EventRecord` fixtures for successful/failed/malformed/unrelated tool results. Require only successful `memory_read` and `memory_neighbors` outputs to yield traffic; a neighbor result includes/reinforces its seed plus returned notes and paths; deduplicate identities; old neighbors without a path may reinforce identifiable notes but must yield zero lanes.
   - **RED:** Project write → read → neighbors, snapshot activation, call `rebuild()`, and require identical stored strength/reinforcedAt/hits and exact lanes at the same `asOf`. Spy that `log.all()` is never called.
   - **GREEN:** Add `activityFromEvent()`. Expand `MEMORY_KINDS` to writes/deletes/accesses/retirements/restores/tool results. `applyOne` passes extracted traffic into the Surreal transaction; unrelated tool results only advance the cursor. Keep subscription/drain serialization unchanged.
   - **Verify:** `bun test plugins/memory/src/activity.test.ts plugins/memory/src/projector.test.ts` passes.

8. **Make search/read/neighbors depth-aware without self-reinforcing search**
   - **Why:** Dormant memory must leave normal routing but remain explicitly recoverable, and tool output must carry enough identity/path data for the projector.
   - **Files:** `packages/contracts/src/memory.ts`, `plugins/memory/src/store.ts`, `plugins/memory/src/surreal.ts`, `plugins/memory/src/tools.ts`, `plugins/memory/src/tools.test.ts`, `plugins/memory/src/budget.ts`, `plugins/memory/src/budget.test.ts`, `plugins/memory/src/rank.ts`
   - **RED:** Require `memory_search` and `memory_neighbors` JSON/Zod inputs to advertise/parse `depth` with normal default. Seed hot and dormant notes/lanes: shallow returns only `≥0.5`, normal only `≥0.125`, deep returns all matching nodes. Direct read returns a dormant `{note,activation}`. Invoke search repeatedly and assert no access event/activation change.
   - **RED:** Require successful read output to preserve its scoped identity outside truncatable body text; require neighbor output to include its seed and exact bounded paths; keep complete response budgets enforced.
   - **GREEN:** Change `MemoryStore.get` to return `MemoryEntry | null`; add depth to filters/neighbors. Filter before rank and compute deterministic search relevance as: exact title `4`, title substring `3`, exact tag `2`, summary substring `1`, body substring `0.5` (take the maximum); final score is `relevance * (0.5 + 0.5 * min(1, effectiveStrength))`. Expose effective strength/dormant. Tool execution only reads; later canonical `tool_result` projection performs agent reinforcement.
   - **Verify:** `bun test plugins/memory/src/tools.test.ts plugins/memory/src/budget.test.ts plugins/memory/src/surreal.test.ts plugins/memory/src/rank.test.ts` passes.

9. **Add bounded non-agent access recording and honest degraded health**
   - **Why:** CLI/API consumption is not represented by agent tool events, while sweep must refuse to act on an unreachable or behind projection.
   - **Files:** `plugins/memory/src/store.ts`, `plugins/memory/src/store.test.ts`, `plugins/memory/src/index.ts`, `packages/cli/src/runtime.test.ts`
   - **RED:** Record one CLI read and require one `memory_accessed` event with safe scoped identity and deterministic optional idempotency key. Re-submit the same key and require one event. Assert failed/missing read records nothing.
   - **RED:** Append an unprojected activity-bearing `tool_result` and require `probeMemory()` to report pending events; a non-memory tool result may advance the cursor but creates no activation.
   - **GREEN:** Expose `recordAccess(payload, {idempotencyKey?})` from `createMemory()`/store. Include every activity-bearing kind in the health `countAfter` set. Keep degraded tools read-only failures and do not offer lifecycle mutation when knowledge is unavailable.
   - **Verify:** `bun test plugins/memory/src/store.test.ts packages/cli/src/runtime.test.ts` passes.

### Phase 3 — Safe sweep, archive, and restore

10. **Implement the pure sweep selector and every protection guard**
    - **Why:** Destructive eligibility must be deterministic, explainable, and independently testable before it can append events.
    - **Files:** create `plugins/memory/src/lifecycle.ts`, create `plugins/memory/src/lifecycle.test.ts`, modify `plugins/memory/src/index.ts`
    - **RED:** Table-test the approved policy at a fixed `asOf`:
      - shallow: only superseded expirable `<1/8`;
      - normal: superseded `<1/2`, unique `<1/32`;
      - deep: superseded `<1`, unique `<1/2`;
      - all require one-half-life minimum age.
    - **RED:** Require blocked reasons for durable retention, protected kind, CLI-created note, recent note, live durable incoming `depends_on`, and another strong incoming lane. Require incoming `supersedes` to classify rather than protect. Require deterministic `(scope,id)` output order.
    - **GREEN:** Export `selectSweep(snapshot, {depth, asOf, policy})` returning `{candidates, blocked}`. Use reason-code constants rather than matched strings; include revision, throughSeq, effective strength, classification, and human reason in each candidate.
    - **Verify:** `bun test plugins/memory/src/lifecycle.test.ts` passes without I/O.

11. **Project retirement/restoration and keep grounded-plan folds correct**
    - **Why:** Retirement must be one canonical state transition; restored/retired notes must fold consistently anywhere memory history is read directly from Postgres.
    - **Files:** `plugins/memory/src/surreal.ts`, `plugins/memory/src/surreal.test.ts`, `plugins/memory/src/projector.ts`, `plugins/memory/src/projector.test.ts`, `packages/kernel/src/execution/strategies/grounded-plan.ts`, `packages/kernel/src/execution/strategies/grounded-plan.test.ts`, `packages/kernel/src/kernel.ts`, `packages/kernel/src/kernel.test.ts`
    - **RED:** Apply `memory_retired` and require live note, incident links, and activation gone. Apply `memory_restored` and require content back at the payload revision with fresh write/lane impulses. Redeliver both and require cursor idempotency.
    - **RED:** Fold write → retire → restore through `foldPlanNotes` and require the restored note; write → retire remains absent. Update kernel event-kind filters to include retirement/restore and prove plan hashes still ignore activation.
    - **GREEN:** Add exact handlers in `SurrealMemory.applyEvent`; retirement uses the full event snapshot only for audit and removes live state, restoration recreates note/links/provenance. Extend log-fold code with retirement-as-delete and restore-as-write semantics.
    - **Verify:** `bun test plugins/memory/src/surreal.test.ts packages/kernel/src/execution/strategies/grounded-plan.test.ts packages/kernel/src/kernel.test.ts` passes.

12. **Render deterministic archives and active/dormant vault views**
    - **Why:** The selected deletion semantics require a human-readable archive rebuilt from canonical events, without introducing an archive database.
    - **Files:** `plugins/memory/src/note-md.ts`, `plugins/memory/src/note-md.test.ts`, `plugins/memory/src/memory-index.ts`, `plugins/memory/src/memory-index.test.ts`, `plugins/memory/src/projector.ts`, `plugins/memory/src/projector.test.ts`
    - **RED:** Render a retired event and require `archive/<scope>/<id>-seq-<seq>.md` with note body, citations, activation/asOf, depth, reason, revision, and retirement sequence. Require no raw MCP response field. Require active and dormant live-index sections.
    - **RED:** Delete vault memory, rebuild from Surreal live entries plus scoped retirement events, and require live files, historical archives, and index to reappear; restoring keeps the archive and recreates the live file. No `.tmp` remains.
    - **GREEN:** Add `archiveRelPath()` and `renderArchivedNote()`. Change `rebuildVaultMemory` to accept a fixed `asOf` plus parsed retirement records from `log.after(0, [memory_retired])`; never call `log.all()`. Project retirement by writing archive after the accepted Surreal transaction, then deleting the live file.
    - **Verify:** `bun test plugins/memory/src/note-md.test.ts plugins/memory/src/memory-index.test.ts plugins/memory/src/projector.test.ts` passes.

13. **Build event-first lifecycle preview/apply with stale-traffic revalidation**
    - **Why:** A note read after preview must survive; checking only Surreal before append leaves a race.
    - **Files:** `plugins/memory/src/lifecycle.ts`, create `plugins/memory/src/lifecycle.integration.test.ts`, modify `plugins/memory/src/index.ts`
    - **RED:** Against real Postgres/Surreal: preview is mutation-free; apply emits one retirement per valid candidate; repeating apply creates no duplicate; one candidate can retire while another stale candidate is skipped.
    - **RED:** After preview, append (a) a write and (b) a reinforcing memory tool result for the candidate before apply. Require both to be reported stale and zero retirement events. Append unrelated traffic and require the candidate still retires. Stop/lag the projector and require fail-closed behavior. Open two project identities against shared deployments and prove neither preview/apply can see or retire the other's notes.
    - **GREEN:** `createMemoryLifecycle({log, knowledge, projector, policy})` implements:
      1. `projector.catchUp()`;
      2. one transactional Surreal snapshot with `throughSeq/asOf`;
      3. pure selection;
      4. per-candidate `log.transaction()` checking relevant events after `throughSeq` with `activityFromEvent()`;
      5. an idempotent `memory-retire:<scope>:<id>:r<revision>` append only if untouched.
      Return event seqs/stale reasons; never infer success from projector timing.
    - **Verify:** `bun test plugins/memory/src/lifecycle.test.ts plugins/memory/src/lifecycle.integration.test.ts` passes.

14. **Add explicit restore through the same lifecycle service**
    - **Why:** Archived memory must be recoverable without editing Postgres or copying Markdown back by hand.
    - **Files:** `plugins/memory/src/lifecycle.ts`, `plugins/memory/src/lifecycle.test.ts`, `plugins/memory/src/lifecycle.integration.test.ts`, `plugins/memory/src/index.ts`
    - **RED:** Retire then restore and require one `memory_restored` event referencing the latest retirement seq, a live note at revision `retired.revision + 1`, original citations/content, CLI update provenance, and fresh activation. Reject restore when live, when no archive exists, or when the latest matching archive belongs to another scope.
    - **GREEN:** Add `restore(id, scope, author)` to the lifecycle facade. Fold scoped retirement/restore/write events to find the latest currently archived snapshot, append with deterministic `memory-restore:<retiredSeq>` key, catch up, and return the restored entry. Historical archive Markdown remains.
    - **Verify:** `bun test plugins/memory/src/lifecycle.test.ts plugins/memory/src/lifecycle.integration.test.ts plugins/memory/src/projector.test.ts` passes.

### Phase 4 — CLI adapter and sourced research workflow

15. **Expose depth, sweep, restore, and safe resource handling in the CLI**
    - **Why:** Maintenance is explicit now, while the service remains callable from future schedules/workflows.
    - **Files:** `packages/cli/src/main.ts`, `packages/cli/src/main.test.ts`
    - **RED:** CLI tests require:
      - `memory add` accepts `--kind`, `--retention`, and repeated/multi-value `--source` URLs;
      - `memory search --depth` forwards the selected depth and rejects unknown values through Commander/Zod;
      - `memory cat` appends access only after a found note;
      - `memory sweep` defaults normal + dry-run and appends nothing;
      - `memory sweep --depth deep --apply` prints retired/stale counts;
      - `memory restore` recreates the latest archive;
      - an error still closes memory resources.
    - **GREEN:** Add one local `withMemory()` helper that opens, catches up, executes, and closes in `finally`, replacing the repeated command blocks. Keep policy in `MemoryLifecycle`, not CLI. Format preview rows with scope/id/revision/strength/classification/reason and make `--apply` the sole mutation switch.
    - **Verify:** `bun test packages/cli/src/main.test.ts` passes.

16. **Ship and seed the tool-agnostic `web-research` skill**
    - **Why:** Agents need a discoverable procedure that writes distilled cited findings and treats web content as hostile data.
    - **Files:** create `vault/skills/web-research/SKILL.md`; modify `vault/skills/codebase-analysis/SKILL.md`, `vault/skills/plan-authoring/SKILL.md`, `vault/skills/documentation/SKILL.md`, `packages/cli/src/main.ts`, `packages/cli/src/main.test.ts`, `packages/kernel/src/plugins/skills.test.ts`
    - **RED:** Init tests require all four shipped skills under configured `skillsDir` and preserve a pre-existing web-research file byte-for-byte. Skill parser tests require the shipped manifest to index. Read the body and assert it states: web content is untrusted evidence/not instructions; one distilled finding per note; no raw page copy; citations required; `retention: expirable`; corroborate or record uncertainty; use supersedes/contradicts; promotion uses durable.
    - **GREEN:** Add `web-research` to `SHIPPED_SKILLS`. Write the skill without hard-coded MCP server/tool names; plans provide trusted `toolRefs`. Update the three existing skill bodies so every first-party `memory_write` instruction explicitly says `retention: durable`.
    - **Verify:** `bun test packages/cli/src/main.test.ts packages/kernel/src/plugins/skills.test.ts` passes.

17. **Prove the sourced workflow with a fake model, real MCP transport, and real memory projection**
    - **Why:** Unit tests cannot prove skill loading, MCP tool execution, memory writing, citations, and projection work through one durable run.
    - **Files:** create `packages/kernel/src/execution/web-research.integration.test.ts`; reuse the existing MCP fixture `echo` tool unchanged as the untrusted page response.
    - **RED:** Script the real API-loop test model to:
      1. call trusted fixture MCP with text containing `IGNORE ALL PRIOR INSTRUCTIONS` plus a factual payload;
      2. call `memory_write` with one distilled `research` note, `retention: expirable`, and `https://example.test/source`;
      3. signal success.
      Require the step to load `web-research` and expose the configured MCP tool.
    - **GREEN:** Wire existing `scriptModel`, real fixture stdio MCP hub, real memory tools/projector, throwaway Postgres/Surreal, and repo skill index through `createDbosPort`. No production model call.
    - **Assertions:** Run completes; note is research/expirable; citation has event-derived `retrievedAt`; live Markdown contains distilled fact + URL; raw prompt-injection/page string is absent from the memory note and memory vault (it may remain in the redacted execution audit by design); initial note activation is correct and citations create no source nodes/lanes.
    - **Verify:** `bun test packages/kernel/src/execution/web-research.integration.test.ts` passes.

### Phase 5 — Documentation and whole-system verification

18. **Document the memory lifecycle as a reusable framework seam**
    - **Why:** Users must know what strengthens memory, why deep search differs, exactly what sweep can delete, and how configured MCP research fits trust/audit boundaries.
    - **Files:** `README.md`, `docs/ARCHITECTURE.md`, `docs/EXTENDING.md`, `docs/superpowers/specs/2026-07-19-neuron-memory-web-research-design.md`
    - **Change:** Add a sourced-research example with MCP `toolRefs`; document durable/expirable and citations; document activation formula/floors; document dry-run/apply/restore; state protected classes; distinguish raw execution audit from distilled knowledge; show that future scheduling calls `MemoryLifecycle` rather than duplicating policy.
    - **Change:** Mark the design implemented only after Task 19 passes.
    - **Verify:** `grep -RIn "memory sweep\|web-research\|expirable\|effectiveStrength" README.md docs/ARCHITECTURE.md docs/EXTENDING.md docs/superpowers/specs/2026-07-19-neuron-memory-web-research-design.md` shows each contract in its intended document.

19. **Run final verification, migration smoke, and complete-diff review**
    - **Why:** A lifecycle feature is only complete if replay, project isolation, no-provider research, and deletion guards hold together.
    - **Files:** all files below; no extra implementation scope
    - **Verify matrix execution:**
      1. `bun run typecheck` exits 0 with no diagnostics.
      2. `bun test` reports zero failures; live Anthropic/Ollama tests remain the only skips.
      3. `bun audit` reports no vulnerabilities.
      4. `bun test packages/contracts/src/memory.test.ts plugins/memory/src/activity.test.ts plugins/memory/src/rank.test.ts plugins/memory/src/surreal.test.ts plugins/memory/src/projector.test.ts plugins/memory/src/lifecycle.test.ts plugins/memory/src/lifecycle.integration.test.ts packages/cli/src/main.test.ts packages/kernel/src/execution/web-research.integration.test.ts` passes.
      5. Rebuild a throwaway project containing a legacy memory event; verify it is live, `durable`, and not a sweep candidate.
      6. Run shallow/normal/deep dry-runs at a fixed clock; verify no events appended. Apply deep; verify only eligible ids retire. Rebuild Surreal/vault; verify identical live/archived membership. Restore one id and rebuild again.
      7. Stop/use an invalid Surreal endpoint and run apply; verify non-zero exit and no `memory_retired` event.
      8. `git diff --check` plus no-index checks for new files report no whitespace errors.
      9. `git status --short`/`git diff --stat` show only planned files and no trust/temp/generated project artifacts.
      10. Record `SELECT count(*) FROM pg_database WHERE datname LIKE 'orc_test_%'` before/after the final targeted smoke; counts match. Do not remove existing stale test databases.

## Verification matrix

| Test | Expected result |
|---|---|
| Strict new write | Missing retention fails before append |
| Historical event | Missing retention replays as durable with no data loss |
| Source boundary | Only bounded credential-free HTTP(S) citations pass |
| Research note | Requires at least one citation; retrievedAt comes from event time |
| Decay | 30-day half-life, saturation 8, deterministic fixed-clock result |
| Reinforcement | Writes/reads/consumed paths strengthen; search display does not |
| Lane identity | Forward/reverse traversal reinforces the same canonical authored edge |
| Rebuild | Same history + asOf yields identical note/lane activation |
| Routing depths | Shallow hot-only; normal active; deep recovers dormant |
| Sweep preview | Mutation-free and explains candidates/blocks |
| Sweep guards | Durable/user/protected/dependency/recent/strong-inbound notes survive every depth |
| Race | Post-preview write/read makes only that candidate stale |
| Retirement | One idempotent event removes live state and creates archive |
| Restore | Latest archive returns live at next revision and remains auditable |
| Degraded memory | Apply fails before retirement append |
| Web research | Real MCP + fake model stores distilled cited note, no raw page in memory/vault |
| Project isolation | One project cannot rank/sweep/archive/restore another project's memory |
| Full suite/typecheck/audit | Zero failures/diagnostics/vulnerabilities; only production-provider skips |

## Files touched

### Create

- `docs/superpowers/specs/2026-07-19-neuron-memory-web-research-design.md`
- `docs/superpowers/plans/2026-07-19-neuron-memory-web-research.md`
- `plugins/memory/src/activity.ts`
- `plugins/memory/src/activity.test.ts`
- `plugins/memory/src/lifecycle.ts`
- `plugins/memory/src/lifecycle.test.ts`
- `plugins/memory/src/lifecycle.integration.test.ts`
- `packages/kernel/src/execution/web-research.integration.test.ts`
- `vault/skills/web-research/SKILL.md`

### Modify

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/EXTENDING.md`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/memory.test.ts`
- `packages/contracts/src/events.ts`
- `packages/contracts/src/events.test.ts`
- `packages/contracts/src/execution.test.ts`
- `packages/contracts/src/analysis.test.ts`
- `packages/cli/src/main.ts`
- `packages/cli/src/main.test.ts`
- `packages/cli/src/runtime.test.ts`
- `packages/kernel/src/projections.ts`
- `packages/kernel/src/projections.test.ts`
- `packages/kernel/src/kernel.ts`
- `packages/kernel/src/kernel.test.ts`
- `packages/kernel/src/execution/signal-router.ts`
- `packages/kernel/src/execution/signal-router.test.ts`
- `packages/kernel/src/execution/finalize-plan-tool.test.ts`
- `packages/kernel/src/execution/grounded-plan.integration.test.ts`
- `packages/kernel/src/execution/memory-reuse.test.ts`
- `packages/kernel/src/execution/split-run.test.ts`
- `packages/kernel/src/execution/strategies/grounded-plan.ts`
- `packages/kernel/src/execution/strategies/grounded-plan.test.ts`
- `packages/kernel/src/plugins/skills.test.ts`
- `packages/vault-projector/src/render.test.ts`
- `plugins/memory/src/index.ts`
- `plugins/memory/src/store.ts`
- `plugins/memory/src/store.test.ts`
- `plugins/memory/src/projector.ts`
- `plugins/memory/src/projector.test.ts`
- `plugins/memory/src/surreal.ts`
- `plugins/memory/src/surreal.test.ts`
- `plugins/memory/src/rank.ts`
- `plugins/memory/src/rank.test.ts`
- `plugins/memory/src/tools.ts`
- `plugins/memory/src/tools.test.ts`
- `plugins/memory/src/budget.ts`
- `plugins/memory/src/budget.test.ts`
- `plugins/memory/src/note-md.ts`
- `plugins/memory/src/note-md.test.ts`
- `plugins/memory/src/memory-index.ts`
- `plugins/memory/src/memory-index.test.ts`
- `plugins/memory/src/project-isolation.test.ts`
- `plugins/memory/src/reuse.integration.test.ts`
- `vault/skills/codebase-analysis/SKILL.md`
- `vault/skills/plan-authoring/SKILL.md`
- `vault/skills/documentation/SKILL.md`

No dependency, Postgres migration, second database, scheduler, bundled web provider, or raw-web knowledge store is added.

Ready to execute when you say go.
