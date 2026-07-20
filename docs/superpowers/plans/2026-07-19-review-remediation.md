# Review remediation implementation plan

**Design:** `docs/superpowers/specs/2026-07-19-review-remediation-design.md`
**Approach:** Vertical TDD slices; work in the current checkout as requested
**Compatibility:** Not required; extension grants intentionally require re-trust

## Plan: Fix every selected correctness, security, UX, and reliability finding

### Phase 1 — Leaf safety and resource bounds

1. **Migration diagnostics distinguish an empty schema from an unreachable database**
   - **Why:** `assertMigrated()` currently converts every query failure into “0 migrations,” hiding connection, authentication, and permission failures.
   - **Files:** `packages/kernel/src/storage/migrate.ts`, `packages/kernel/src/storage.test.ts`
   - **RED:** Add an integration assertion that a fresh unmigrated database reports `0/<expected>` while `openStorage('postgresql://postgres:orc@127.0.0.1:59999/orc', …)` preserves an `ECONNREFUSED`-detectable cause. Run the focused test and confirm the unreachable case fails with the current schema message.
   - **GREEN:** Replace `.catch(() => 0)` with a helper that recursively reads wrapped PostgreSQL error codes and returns zero only for `42P01` or `3F000`; rethrow every other error.
   - **Verify:** `bun test packages/kernel/src/storage.test.ts` → all storage tests pass and the unreachable assertion identifies connection refusal.

2. **Common credential keys are redacted at the canonical storage boundary**
   - **Why:** `client_secret`, `private_key`, prefixed API keys, and credentials currently persist raw.
   - **Files:** `packages/kernel/src/redact.ts`, `packages/kernel/src/storage.test.ts`
   - **RED:** Extend the real EventLog redaction test with `client_secret`, `private_key`, `x_api_key`, `servicePassword`, and `credentials`; assert none of their values appears in event or operation JSON. Confirm the focused test fails.
   - **GREEN:** Normalize case/separators and match exact/suffix credential compounds (`authorization`, `apikey`, `password`, `secret`, `privatekey`, `credentials`, `accesstoken`, `refreshtoken`, `cookie`) without treating every word ending in plain `key` as secret.
   - **Verify:** `bun test packages/kernel/src/storage.test.ts --test-name-pattern redacts` → pass.

3. **MCP stderr cannot accumulate or leak through startup errors**
   - **Why:** A long-lived noisy server retains every stderr chunk, and a crashing server's raw stderr is interpolated into the thrown error.
   - **Files:** `plugins/mcp-client/src/index.ts`, `plugins/mcp-client/src/index.test.ts`
   - **RED:** Strengthen the crashing-server test to assert the error identifies the server but does not contain `fixture: crashing on purpose`. Confirm it fails against the current buffered detail.
   - **GREEN:** Set the stdio transport's `stderr` to `'ignore'`; delete `stderrChunks` and all raw-detail interpolation.
   - **Verify:** `bun test plugins/mcp-client/src/index.test.ts` → all MCP tests pass.

4. **Extension fingerprints cover executable local dependencies and reload rechecks trust**
   - **Why:** Editing an imported `./dep.ts` currently leaves the entry-only grant trusted; `reload()` also re-imports without reevaluating trust.
   - **Files:** `packages/kernel/src/plugins/trust.ts`, `packages/kernel/src/plugins/trust.test.ts`, `packages/kernel/src/plugins/extensions.ts`, `packages/kernel/src/plugins/extensions.test.ts`
   - **RED:** Extend trust tests with an entry importing `./dep`: grant it, edit only the dependency, and require `isExtensionTrusted` to become false. Write an old entry-byte-only fingerprint into `trust.json` and require it to fail closed. Change the project `bun.lock` fixture and require invalidation. Extend reload coverage so a changed dependency is skipped until a new grant. Confirm all four assertions fail against current behavior.
   - **GREEN:** Use `Bun.Transpiler.scanImports()` plus `Bun.resolveSync()` to walk literal relative `import`, dynamic-import, and `require` references recursively. Hash a sorted sequence of resolved path + file bytes and the nearest project `bun.lock` when present. Treat unresolved local references as untrusted. Store the trust predicate/base directory in `ExtensionHost` and recheck each declaration before reload activation.
   - **Verify:** `bun test packages/kernel/src/plugins/trust.test.ts packages/kernel/src/plugins/extensions.test.ts packages/kernel/src/plugins/host.test.ts` → pass.

5. **Memory-note inputs and complete read responses are bounded**
   - **Why:** `budget: 1` can currently return tens of thousands of metadata characters because only `body` is truncated.
   - **Files:** `packages/contracts/src/memory.ts`, `packages/contracts/src/memory.test.ts`, `plugins/memory/src/budget.ts`, `plugins/memory/src/budget.test.ts`, `plugins/memory/src/tools.ts`, `plugins/memory/src/tools.test.ts`
   - **RED 1:** Add contract tests for these limits: categories/tags ≤50 items of ≤64 chars; links/paths/rules/uncertainty ≤100 items; path/rule/uncertainty strings ≤1,000 chars; body ≤100,000 chars; rationale ≤20,000 chars. Confirm oversized inputs fail.
   - **GREEN 1:** Export one `MEMORY_LIMITS` constant from contracts and apply it to `MemoryNoteBase`; mirror `maxItems`/`maxLength` in the advertised memory-write JSON schema.
   - **RED 2:** Add a public tool test returning a note with 1,000 rules and call `memory_read({id:'auth', budget:1})`; require `truncated:true` and serialized output ≤1,024 characters. Confirm current output violates both assertions.
   - **GREEN 2:** Add `fitMemoryNoteToBudget(note, budget)` in `budget.ts`. Keep identity/title/kind/scope/provenance, initialize optional summary/arrays/body/rationale empty, reserve the exact `{note,truncated,next}` JSON wrapper overhead, add bounded metadata items in schema order while the complete serialized response remains within `max(1024, budget*4)` characters, then fill rationale/body with the remaining characters. Search budgeting measures `JSON.stringify(summary)` rather than title+summary only.
   - **Verify:** `bun test packages/contracts/src/memory.test.ts plugins/memory/src/budget.test.ts plugins/memory/src/tools.test.ts` → pass.

6. **Projection file swaps use process-unique temporary files**
   - **Why:** Concurrent `run` and `reply` processes share `<path>.tmp`; the vault manifest is also replaced non-atomically.
   - **Files:** `packages/vault-projector/src/write.ts`, `packages/vault-projector/src/write.test.ts`, `plugins/memory/src/write-note.ts`, `plugins/memory/src/write-note.test.ts`
   - **RED:** Pre-create a stale `<projection>.tmp` directory (the same collision shape left by another/crashed writer), call the public vault and memory write functions, and require both writes to succeed with complete content and no newly-created temp files. Confirm the current fixed temp path throws `EISDIR`.
   - **GREEN:** Reuse `atomicWriteFileSync` from `@orc/kernel` for vault content, memory content, and `.orc-manifest.json`; retain skip-unchanged, containment, and plan write-once behavior.
   - **Verify:** `bun test packages/vault-projector/src/write.test.ts plugins/memory/src/write-note.test.ts` → pass.

7. **The load-sensitive DBOS test has explicit integration timeout headroom**
   - **Why:** The full suite failed at Bun's 5-second default while five isolated reruns completed around 3.3 seconds.
   - **Files:** `packages/kernel/src/execution/dbos-port.test.ts`
   - **Change:** Give `runs a 2-step DAG to done` a 15,000 ms timeout, matching other DBOS workflow tests. No production code changes.
   - **Verify:** `for i in 1 2 3 4 5; do bun test packages/kernel/src/execution/dbos-port.test.ts --test-name-pattern 'runs a 2-step DAG' || exit 1; done` → five passes.

### Phase 2 — CLI discovery, bootstrap, and local project setup

8. **Default config lookup discovers the nearest initialized ancestor**
   - **Why:** Commands from `src/nested` currently report an uninitialized project.
   - **Files:** `packages/kernel/src/config.ts`, `packages/kernel/src/config.test.ts`
   - **RED:** Create `project/.orc/config.json`, call `loadConfig()` with `process.chdir(project/src/nested)` inside a `try/finally`, and assert `config.dir === project`. Also assert `loadConfig(explicitDir)` remains anchored even when an ancestor has config. Confirm the default lookup test fails.
   - **GREEN:** Add `findProjectDir(start)` that walks parents to filesystem root and returns the nearest directory containing `.orc/config.json`, falling back to `start`; use it only when `loadConfig` receives no explicit directory.
   - **Verify:** `bun test packages/kernel/src/config.test.ts` → pass.

9. **Fresh users can run help and an explicit migration before project startup**
   - **Why:** The documented migration command is missing and help currently requires identity plus a migrated database.
   - **Files:** create `packages/cli/src/bin.test.ts`; modify `packages/cli/src/bin.ts`, `packages/cli/src/main.ts`, `packages/cli/src/main.test.ts`
   - **RED:** In `bin.test.ts`, spawn the real bin from an uninitialized temp directory with an unreachable `ORC_DATABASE_URL`; require `--help`, `new --help`, and `help new` to exit 0. Create a fresh database with `createTestDb({migrate:false})`; require `db migrate` to exit 0 and a subsequent initialized `tasks` command to reach the empty-task output. Confirm help and migration fail before implementation.
   - **GREEN:**
     - Add `runMigrate(dir?)`, which calls `migrateDatabase(loadConfig(dir).databaseUrl)` and prints `database migrated`.
     - Register `db migrate` in the Commander tree so help documents it.
     - In `bin.ts`, dispatch `init`, exact `db migrate`, and help arguments before `requireProject`, plugin creation, or `openStorage`; construct the existing command tree with an inert Kernel only for help parsing, where no action can execute.
   - **Verify:** `bun test packages/cli/src/bin.test.ts packages/cli/src/main.test.ts` → pass.

10. **CLI input and not-found behavior is explicit and script-safe**
   - **Why:** Invalid versions produce `vNaN`, unknown audit IDs exit successfully, and missing memory notes look like successful `cat` operations.
   - **Files:** `packages/cli/src/main.ts`, `packages/cli/src/main.test.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/bin.test.ts`
   - **RED:** Add tests that `plan/approve --version nope` reject as invalid integers; `log/replay <unknown>` reject with `no task`; `memory cat missing` sets non-zero status; and `tasks` prints `_no tasks_`. Add a subprocess assertion that an empty title reports `task.title: Too small` without printing a JSON issue array.
   - **GREEN:**
     - Use one Commander `InvalidArgumentError` integer parser for versions and replay sequence values.
     - Validate task existence before log/replay.
     - Throw for a missing memory note and print `_no tasks_` for an empty list.
     - Add `formatCliError` in `bin.ts` that detects an `issues` array and joins `path: message`; keep ordinary Error rendering unchanged.
   - **Verify:** `bun test packages/cli/src/main.test.ts packages/cli/src/bin.test.ts` → pass.

11. **`orc init` installs required first-party skills without overwriting user files**
    - **Why:** Grounded-plan fails in a fresh target project because `codebase-analysis` and `plan-authoring` are absent.
    - **Files:** `packages/cli/src/main.ts`, `packages/cli/src/main.test.ts`
    - **RED:** Extend the init tests to assert `codebase-analysis`, `plan-authoring`, and `documentation` `SKILL.md` files exist under the resolved `skillsDir`; pre-create one target file and assert init preserves its bytes. Confirm current init only writes config.
    - **GREEN:** Resolve the shipped `vault/skills` directory from `import.meta.url`, create the target skill directories, and `copyFileSync` each missing `SKILL.md`. Run this after identity initialization so an existing config's custom `vaultDir`/`skillsDir` is honored.
    - **Verify:** `bun test packages/cli/src/main.test.ts --test-name-pattern init` → pass.

### Phase 3 — Hook and process lifecycle

12. **Detached async hooks are tracked and drained**
    - **Why:** A short successful CLI command exits before asynchronous `event_appended` handlers finish.
    - **Files:** `packages/kernel/src/plugins/hooks.ts`, `packages/kernel/src/plugins/hooks.test.ts`, `packages/kernel/src/plugins/host.ts`, `packages/cli/src/bin.ts`, `packages/cli/src/runtime.ts`, `packages/cli/src/bin.test.ts`
    - **RED 1:** Add a HookBus test: `dispatch(event_appended, event)` starts a delayed handler; before `drain()` the marker is absent, after `await drain()` it is present. Confirm methods do not exist.
    - **GREEN 1:** Add `dispatch()` that records the `emit()` promise in a pending set and removes it in `finally`; add `drain()` that waits until the set is empty. `PluginHost.shutdown()` drains before emitting `session_shutdown` and deactivating extensions.
    - **RED 2:** In the real-bin test, trust a temp extension whose event hook waits 200 ms then writes a marker; run `orc new`, wait for process exit, and require the marker immediately. Confirm current bin exits without it.
    - **GREEN 2:** Replace both `void hooks.emit(event_appended)` call sites with `hooks.dispatch`. Refactor bin success/error paths into shared `finally` cleanup. In runtime shutdown, stop DBOS/router first, then close memory/vault projectors, drain hooks/deactivate extensions, close MCP, and let bin close Postgres storage; remove the duplicate memory-projector close.
    - **Verify:** `bun test packages/kernel/src/plugins/hooks.test.ts packages/cli/src/bin.test.ts packages/cli/src/runtime.test.ts` → pass.

### Phase 4 — Durable feedback and trusted grounded approval

13. **Plan-graph hashing is canonical and part of feedback contracts**
    - **Why:** Approval must bind to exactly what the human reviewed.
    - **Files:** `packages/contracts/src/analysis.ts`, `packages/contracts/src/analysis.test.ts`, `packages/kernel/src/execution/strategies/grounded-plan.ts`, `packages/kernel/src/execution/strategies/grounded-plan.test.ts`
    - **RED:** Add tests that `planGraphHash(notes)` is independent of note-array order, changes when body/link/order/uncertainty changes, and yields 64 lowercase hex characters. Add contract coverage for optional `planHash` on `feedback_provided` with a strict SHA-256 shape.
    - **GREEN:** Implement `planGraphHash` with `createHash('sha256')` over `JSON.stringify` of notes sorted by `(scope,id)` while preserving each note's internal link/array order. Add `planHash?: /^[a-f0-9]{64}$/` to `FeedbackProvidedPayload`.
    - **Verify:** `bun test packages/contracts/src/analysis.test.ts packages/kernel/src/execution/strategies/grounded-plan.test.ts` → pass.

14. **Reply events carry delivery and approval provenance**
    - **Why:** Current events lose the destination run token and cannot prove which graph was approved.
    - **Files:** `packages/kernel/src/kernel.ts`, `packages/kernel/src/kernel.test.ts`, `packages/cli/src/main.test.ts`
    - **RED:** Add kernel tests asserting:
     1. `feedback_provided` carries the requesting `stepId`/`runToken` envelope and a deterministic event idempotency key;
     2. exact trimmed/case-insensitive `approve` on a grounded plan request stores the current graph hash;
     3. ordinary consent/non-approve replies have no `planHash`;
     4. `approvedPlanHash(taskId, runToken)` ignores another attempt.
    Confirm current code fails all provenance assertions.
    - **GREEN:** Extend the injected send signature to `(workflowId, message, topic, idempotencyKey)`. Inside the project-locked reply transaction, pair the latest request, fold task-scoped plan notes when approval applies, append `feedback_provided` directly with the request envelope and `feedback:<requestSeq>:provided` idempotency key, then send using `feedback:<providedEventSeq>`.
    - **Verify:** `bun test packages/kernel/src/kernel.test.ts packages/cli/src/main.test.ts` → pass.

15. **Feedback delivery replays from the event log after a failed/crashed send**
    - **Why:** A committed reply must eventually resume its waiting DBOS workflow even if the immediate send fails.
    - **Files:** `packages/kernel/src/execution/signal-router.ts`, `packages/kernel/src/execution/signal-router.test.ts`, `packages/kernel/src/execution/dbos-port.ts`, `packages/kernel/src/execution/feedback-gate.test.ts`, `packages/cli/src/runtime.ts`
    - **RED:** Add router tests for live and startup delivery of `feedback_provided`: destination=`event.runToken`, topic=`feedback:<payload.topic>`, key=`feedback:<event.seq>`. Add the original review regression: Kernel send throws after append, then router startup with a healthy sender delivers the stored reply exactly through the idempotent key. Confirm current router ignores feedback.
    - **GREEN:** Mark feedback events router-relevant; inject `sendFeedback` alongside split `send`; replay feedback only for tasks still running, route live events immediately, and contain/log send failures. Pass the fourth DBOS idempotency argument through `dbosSend`. Update the feedback-gate integration test to resume through `kernel.replyFeedback` rather than a raw `DBOS.send`.
    - **Verify:** `bun test packages/kernel/src/execution/signal-router.test.ts packages/kernel/src/execution/feedback-gate.test.ts` → pass.

16. **`finalize_plan` rejects missing, stale, and cross-attempt approval**
    - **Why:** The auditor model currently auto-approves a child without any trusted human event.
    - **Files:** `packages/kernel/src/execution/finalize-plan-tool.ts`, `packages/kernel/src/execution/finalize-plan-tool.test.ts`, `packages/cli/src/runtime.ts`
    - **RED:** Change the fake kernel to expose `approvedPlanHash`; add tests that finalize fails with no approval, fails with a mismatched graph hash, fails when approval belongs to another run token, and succeeds only with the matching hash. Confirm the current tool succeeds without approval.
    - **GREEN:** Before `proposeSplit`, load notes, compute `planGraphHash`, request `kernel.approvedPlanHash(taskId, runToken)`, and return an `isError` result unless hashes match. Keep the existing auditor-role gate and deterministic split path.
    - **Verify:** `bun test packages/kernel/src/execution/finalize-plan-tool.test.ts` → pass.

17. **Grounded end-to-end flow proves approval, mutation invalidation, and replayed feedback**
    - **Why:** Unit boundaries must compose under DBOS, event log, memory projection, and recursive execution.
    - **Files:** `packages/kernel/src/execution/grounded-plan.integration.test.ts`
    - **RED/GREEN:** Update existing reply expectations for idempotency-aware sending. Add one assertion that direct finalize before the plan feedback gate is rejected and one cycle where approval is followed by a note mutation, finalize rejects, the agent asks again, and a second approval succeeds. Correct the directly affected stale comments that incorrectly say production has no `analysis_completed` emitter.
    - **Verify:** `bun test packages/kernel/src/execution/grounded-plan.integration.test.ts` → all three grounded scenarios pass within their existing 60-second limits.

### Phase 5 — Atomic grounded setup and workspace propagation

18. **Grounded task creation is atomic and uses title as omitted spec**
    - **Why:** Validation failure currently leaves an orphan draft task, and a title-only grounded task gives agents an empty task brief.
    - **Files:** `packages/kernel/src/kernel.ts`, `packages/kernel/src/kernel.test.ts`, `packages/cli/src/main.ts`, `packages/cli/src/exec-commands.test.ts`
    - **RED:** Add a rejecting `refValidator`, call `createGroundedTask`, and assert both the promise rejects and task/event counts are unchanged. Add a title-only assertion that the stored task spec equals its title. Confirm the current separate transactions leave a task and empty spec.
    - **GREEN:** Extract transaction-scoped task creation and approval helpers used by existing public methods. Implement grounded create/propose/approve in one `log.transaction`; normalize blank spec to title before constructing the task and analyzer input.
    - **Verify:** `bun test packages/kernel/src/kernel.test.ts packages/cli/src/exec-commands.test.ts` → pass.

19. **Grounded bootstrap and recursive children use the intended workspace**
    - **Why:** Grounded analysis starts in an empty hidden workspace and children currently force `cwd:null`.
    - **Files:** `packages/cli/src/main.ts`, `packages/cli/src/exec-commands.test.ts`, `packages/kernel/src/execution/dbos-port.ts`, `packages/kernel/src/execution/dbos-port.test.ts`, `packages/kernel/src/execution/split-run.test.ts`
    - **RED 1:** Update the grounded CLI stub test to require `startRun(taskId,{cwd: projectDir})`; confirm current call records an empty cwd.
    - **GREEN 1:** Pass `plugin?.config.dir ?? process.cwd()` to grounded `startRun`.
    - **RED 2:** Run the split e2e parent with an absolute temp `--cwd`; have the child fake assert `ctx.workspaceDir` equals the same path. Confirm current child receives its hidden per-step workspace.
    - **GREEN 2:** In `startChildRun`, fold project state, locate the child task's parent, read that parent's latest persisted `RunRecord.cwd`, and pass it into the deterministic child workflow. Nested children inherit recursively because each parent run now persists the inherited cwd.
    - **Verify:** `bun test packages/cli/src/exec-commands.test.ts packages/kernel/src/execution/split-run.test.ts packages/kernel/src/execution/dbos-port.test.ts` → pass.

### Phase 6 — Documentation and whole-system verification

20. **Document the repaired user and security contracts**
    - **Why:** Quickstart and extension-trust guarantees must match executable behavior.
    - **Files:** `README.md`, `docs/ARCHITECTURE.md`, `docs/EXTENDING.md`, `docs/superpowers/specs/2026-07-19-review-remediation-design.md`
    - **Change:**
     - Quickstart: `docker compose up` → `orc db migrate` → `orc init`; release-notes run uses `--cwd .`.
     - State that init seeds first-party skills without overwriting them.
     - State extension grants bind entry + local dependency closure + lockfile and require re-trust after changes.
     - Document feedback events as the idempotent outbox and grounded approval as plan-hash-bound.
     - Mark the design status implemented only after all verification passes.
   - **Verify:** Run `grep -RIn "orc db migrate\|plan-hash\|dependency closure" README.md docs/ARCHITECTURE.md docs/EXTENDING.md docs/superpowers/specs/2026-07-19-review-remediation-design.md`; each new contract appears in its intended document.

21. **Run final verification and inspect the complete diff**
    - **Why:** Completion requires evidence across packages and the clean-user path.
    - **Files:** all files listed below; no additional implementation scope
    - **Verify matrix execution:**
     1. `bun run typecheck` → exit 0, no diagnostics.
     2. `bun test` → zero failures; live provider tests remain the only skips.
     3. `bun audit` → no vulnerabilities.
     4. `bun test packages/cli/src/bin.test.ts` → clean database migration/help/init/nested/hook smoke passes without provider API calls.
     5. Repeat the DBOS two-step test five times → five passes.
     6. `git diff --check` → no whitespace errors.
     7. `git status --short` and `git diff --stat` → only planned files changed; no `.tmp`, generated workspace, trust file, or test database artifact in the tree.
     8. Query `SELECT count(*) FROM pg_database WHERE datname LIKE 'orc_test_%'` before and after the final targeted smoke; counts are equal. Existing stale databases are not removed.

## Verification matrix

| Test | Expected result |
|---|---|
| Fresh DB `orc db migrate` | Exit 0 before project initialization; normal commands open afterward |
| Help with no project/DB | Root and subcommand help exit 0 |
| Nested command | Uses nearest ancestor project |
| Invalid CLI inputs | Non-zero, concise actionable message |
| Secret storage regression | No representative raw credential appears in event/journal JSON |
| Extension dependency edit | Existing grant becomes untrusted before activation/reload |
| Delayed event hook | Marker exists when CLI process exits |
| Tiny memory budget | `truncated:true`; bounded serialized output |
| Concurrent projection stress | All writers exit 0; complete file; no temp artifacts |
| Feedback send failure | Committed event re-delivers on router startup with stable key |
| Grounded finalize | No approval→reject; matching approval→success; mutation→reject |
| Grounded workspace | Analyzer/root child sees project root; recursive child inherits cwd |
| Grounded validation failure | No task or lifecycle event remains |
| Full suite | Zero failures |
| Typecheck/audit | Both exit 0; audit reports no vulnerabilities |

## Files touched

### Create

- `packages/cli/src/bin.test.ts`
- `docs/superpowers/plans/2026-07-19-review-remediation.md`

### Modify

- `README.md`
- `docs/ARCHITECTURE.md`
- `docs/EXTENDING.md`
- `docs/superpowers/specs/2026-07-19-review-remediation-design.md`
- `packages/cli/src/bin.ts`
- `packages/cli/src/main.ts`
- `packages/cli/src/main.test.ts`
- `packages/cli/src/exec-commands.test.ts`
- `packages/cli/src/runtime.ts`
- `packages/contracts/src/analysis.ts`
- `packages/contracts/src/analysis.test.ts`
- `packages/contracts/src/memory.ts`
- `packages/contracts/src/memory.test.ts`
- `packages/kernel/src/config.ts`
- `packages/kernel/src/config.test.ts`
- `packages/kernel/src/kernel.ts`
- `packages/kernel/src/kernel.test.ts`
- `packages/kernel/src/redact.ts`
- `packages/kernel/src/storage/migrate.ts`
- `packages/kernel/src/storage.test.ts`
- `packages/kernel/src/plugins/hooks.ts`
- `packages/kernel/src/plugins/hooks.test.ts`
- `packages/kernel/src/plugins/host.ts`
- `packages/kernel/src/plugins/trust.ts`
- `packages/kernel/src/plugins/trust.test.ts`
- `packages/kernel/src/plugins/extensions.ts`
- `packages/kernel/src/plugins/extensions.test.ts`
- `packages/kernel/src/execution/dbos-port.ts`
- `packages/kernel/src/execution/dbos-port.test.ts`
- `packages/kernel/src/execution/signal-router.ts`
- `packages/kernel/src/execution/signal-router.test.ts`
- `packages/kernel/src/execution/feedback-gate.test.ts`
- `packages/kernel/src/execution/finalize-plan-tool.ts`
- `packages/kernel/src/execution/finalize-plan-tool.test.ts`
- `packages/kernel/src/execution/strategies/grounded-plan.ts`
- `packages/kernel/src/execution/strategies/grounded-plan.test.ts`
- `packages/kernel/src/execution/grounded-plan.integration.test.ts`
- `packages/kernel/src/execution/split-run.test.ts`
- `packages/vault-projector/src/write.ts`
- `packages/vault-projector/src/write.test.ts`
- `plugins/mcp-client/src/index.ts`
- `plugins/mcp-client/src/index.test.ts`
- `plugins/memory/src/budget.ts`
- `plugins/memory/src/budget.test.ts`
- `plugins/memory/src/tools.ts`
- `plugins/memory/src/tools.test.ts`
- `plugins/memory/src/write-note.ts`
- `plugins/memory/src/write-note.test.ts`

Optional ponytail deletions and destructive cleanup of existing `orc_test_*` databases remain out of scope.

Ready to execute when you say go.
