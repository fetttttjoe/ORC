# Review remediation design

**Status:** Implemented and verified on 2026-07-19
**Scope:** Every correctness, security, UX, and reliability finding from the 2026-07-19 full review
**Excluded:** Optional ponytail deletions; destructive cleanup of existing local `orc_test_*` databases
**Backwards compatibility:** Not required. Existing event histories remain readable where that is cheaper than breaking them, but extension trust grants intentionally fail closed and require re-trust.

## Goal

A new user can initialize infrastructure, discover the CLI, run the documented task lifecycle, and use grounded planning without hidden prerequisites. Human approval, feedback delivery, extension trust, secret redaction, memory budgets, hooks, and projection writes must hold at their actual trust/failure boundaries rather than relying on prompts or process timing.

## Decisions

1. Database migration remains explicit through a standalone `orc db migrate` command.
2. `orc reply <task> approve` remains the grounded approval UX, but approval is bound to a hash of the exact plan-note graph.
3. Grounded runs use the initialized project root automatically. Recursive children inherit their parent run's `cwd`. Ordinary runs retain per-step isolation unless `--cwd` is supplied.
4. Required first-party skills are copied into a project by `orc init` without overwriting project edits.
5. Extension fingerprints cover the entry file and its literal local `import`, dynamic `import`, and `require` dependency closure. Existing entry-only grants fail closed.
6. Existing local test databases are not deleted by implementation or tests.

## Design

### 1. CLI bootstrap and database migration

`bin.ts` handles infrastructure-independent paths before project startup:

- `init`
- `db migrate`
- root and subcommand help

`orc db migrate` resolves the same environment/config database URL as normal commands, calls the committed Drizzle migrator, reports the applied schema, and exits without requiring project identity, plugins, or an already-migrated store. The Quickstart runs it after `docker compose up` and before normal commands.

`assertMigrated` maps only PostgreSQL's missing-table (`42P01`) and missing-schema (`3F000`) failures to “0 migrations”; connection, authentication, permission, and transient errors propagate to the existing diagnostic path.

Default config loading walks from the current directory to the nearest ancestor containing `.orc/config.json`. Explicit `loadConfig(dir)` calls remain anchored to the supplied directory for tests and initialization.

Commander parses integer options through one strict non-negative/positive integer parser. `log`, `replay`, and `memory cat` reject missing records with non-zero status. Empty task listings print an explicit empty state. Zod boundary errors are rendered as concise path/message lines rather than raw issue arrays.

### 2. Durable feedback and hash-bound grounded approval

A `feedback_provided` event becomes the durable outbox record:

- Its envelope carries the requesting step's `stepId` and `runToken`.
- Delivery to DBOS uses a deterministic idempotency key derived from the committed event.
- The live router sends newly committed feedback events.
- Router startup re-sends historical feedback events; DBOS idempotency absorbs duplicates.
- The reply command still attempts immediate delivery, but a crash between append and send is healed by the live router or the next runtime startup.

When the latest open request belongs to a grounded task's plan step and the normalized reply is exactly `approve`, the kernel computes a canonical SHA-256 hash over the current task-scoped plan-note graph inside the same project-serialized transaction and stores it on `feedback_provided`.

`finalize_plan` requires a matching approval event for its task and run token, recomputes the current graph hash, and rejects when:

- no human approval exists;
- approval belongs to another run;
- the graph changed after approval; or
- the graph cannot instantiate a valid frozen plan.

Thus the model may request approval but cannot manufacture it, and post-approval edits require another human approval.

### 3. Grounded task setup and workspace propagation

`orc init` copies the shipped `codebase-analysis`, `plan-authoring`, and documentation skills into `vault/skills`, skipping files that already exist.

Grounded task creation becomes one event-log transaction: task creation, plan validation/proposal, policy approval, and status transitions either all commit or all roll back. Validation failure leaves no draft task.

For grounded creation:

- an omitted `--spec` uses the task title;
- the bootstrap run receives the resolved project root as `cwd`;
- analysis and plan steps therefore see the working tree;
- a split child resolves the latest parent run and inherits its persisted `cwd`, recursively.

Ordinary `orc run` keeps the existing isolated per-step default. The Quickstart's release-notes example uses `--cwd .` because it needs project files.

### 4. Extension trust and secret redaction

Extension fingerprinting recursively scans literal local module references with Bun's native transpiler, resolves them with Bun's resolver, and hashes a canonical sorted list of path-plus-content records. Package imports are represented by the project lockfile hash when a lockfile exists. Unresolvable local dependencies fail closed. A dependency edit invalidates trust before import/activation.

Secret-key matching normalizes separators/case and covers common credential compounds including client secrets, private keys, API keys with prefixes, credentials, authorization, cookies, and access/refresh tokens. Regression tests write representative payloads through the real storage boundary and assert raw values never enter events or operation rows.

### 5. Hook and process lifecycle

`HookBus` gains a detached dispatch method that tracks pending asynchronous emissions and a drain method. Event append callbacks dispatch without blocking database transactions; shutdown drains all pending hooks before `session_shutdown` and extension deactivation.

CLI success and error paths share orderly cleanup. DBOS stops before projectors perform their final sync; then extensions/hooks, MCP, and Postgres storage close. Explicit `process.exit` happens only after cleanup, so asynchronous hook work is not truncated.

### 6. Bounded memory output

Memory-note input arrays and individual metadata strings receive explicit, conservative maximums at the model/CLI trust boundary. `memory_read` budgets the complete serialized response, not only `body`: it keeps a bounded identity/provenance envelope, then fills summary/metadata and rationale/body until the character approximation is exhausted, reporting truncation plus a next-step hint.

Search budgeting measures the serialized summaries it actually returns. A one-token budget may exceed four characters for the irreducible identity envelope, but cannot return unbounded metadata.

### 7. Concurrent projection writes

Vault and memory projectors reuse the existing unique atomic-file writer for content and manifest swaps. Temporary paths include process identity, so simultaneous `run`, `reply`, and projection processes cannot clobber one another's temp files. Plan files remain write-once and non-plan projection behavior remains unchanged.

### 8. MCP stderr handling

MCP child stderr is ignored rather than accumulated or interpolated into errors. Startup failures report command/server context without raw child stderr, preventing unbounded memory growth and accidental secret disclosure.

### 9. Reliability and tests

Implementation follows vertical TDD slices. Each reproduced review failure gets one public-behavior regression before its fix. The load-sensitive two-step DBOS integration test receives the same explicit timeout headroom already used by slower workflow tests.

Final verification:

- fresh throwaway Postgres database: `orc db migrate` then normal lifecycle;
- uninitialized and database-free help;
- nested-directory project discovery;
- grounded run sees project files and child inherits workspace;
- finalize rejected before approval, accepted after approval, rejected after graph mutation;
- feedback send failure recovered by replay;
- imported extension dependency edit revokes trust;
- representative secret keys absent from stored JSON;
- delayed async hook completes before CLI exit;
- tiny memory budget remains bounded;
- concurrent projector smoke test leaves no temp files;
- noisy MCP server does not retain/echo stderr;
- `bun run typecheck`;
- `bun test` with zero failures;
- `bun audit` with no vulnerabilities;
- clean git diff check.

## Success criteria

All review reproductions have passing regressions, the documented clean-user journey works without a real model API call, no existing local test database is deleted, and optional ponytail-only removals remain untouched.
