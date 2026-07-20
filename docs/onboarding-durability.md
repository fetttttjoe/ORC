# Onboarding: Durability Guarantees

This is a code-grounded walkthrough of how `orc` guarantees that work is never silently lost,
duplicated, or left in an unknown state — even across a `kill -9`. It complements
[`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) (the canonical system map); read that first for the
big picture. This doc drills into the mechanics with file paths so you can go read the real code.

The one-sentence version, taken from `docs/ARCHITECTURE.md`: **the Postgres event log is the
only truth**. The operation journal, SurrealDB, the vault markdown, and DBOS's own system
database are all either a rebuildable index over that log or a disposable projection of it. All
state is `fold(events)`.

## 1. The event log — the append-only ground truth

**File:** `packages/kernel/src/storage/event-log.ts` (table schema:
`packages/kernel/src/schema.ts`, `events` table).

`EventLog.append()` is the *only* write path into the `events` Postgres table. One call does all
of the following inside a single database transaction:

1. Takes a per-project Postgres advisory lock (`PostgresStore.withProjectLock`, in
   `packages/kernel/src/storage/postgres.ts`, via `pg_advisory_xact_lock(hashtextextended(projectId, 0))`).
   This serializes writers *within one project* while unrelated projects stay fully concurrent.
2. JSON-round-trips the payload (drops `undefined` keys so a replayed idempotent write compares
   byte-identical to the stored row).
3. Redacts it — `packages/kernel/src/redact.ts` is the single storage-boundary normalizer: it
   strips NUL bytes (Postgres `jsonb` rejects `\u0000`) and blanks out secret-shaped keys
   (`apiKey`, `password`, `Authorization`, …) and secret-shaped `*_KEY`/`*_TOKEN`/`*_SECRET`/
   `*_PASSWORD` environment-variable values wherever they appear, recursively, in both keys and
   values.
4. Validates the *redacted* payload against `PAYLOAD_SCHEMAS[kind]` (from `@orc/contracts`) — validating
   after redaction means a Zod error can never quote a raw secret back at you.
5. Inserts with `ON CONFLICT (project_id, idempotency_key) DO NOTHING`.
6. `pg_notify`s an `orc_events` channel for live tailing.
7. Commits.

**Idempotent retries, safely.** If the insert hits a conflicting `(projectId, idempotencyKey)`,
`append()` re-reads the existing row and returns it *only if the new call's data is deep-equal* to
what's already stored; otherwise it throws (`idempotency key '...' reused with different event
data`). This is what makes a workflow retry (see §3) safe to call `append` again after a crash: it
gets back the same committed record instead of duplicating the event.

**Lossless live tail.** `EventLog.subscribe({ fromSeq }, handler)` is a `LISTEN/NOTIFY`-driven
stream, but the `NOTIFY` is only a wake-up — the authoritative read is always a catch-up SQL query
(`WHERE seq > cursor ORDER BY seq`), and the cursor only advances *after* the handler resolves
successfully, so a crash mid-handler never loses an event. A dropped `LISTEN` connection
reconnects with bounded backoff (`[100, 200, 400, 800, 1600, 3000]` ms) and always catches up
*before* resuming live delivery. `orc run`/`orc new --strategy grounded-plan`'s live tail
(`tailUntilDone` in `packages/cli/src/main.ts`) and `packages/vault-projector` both consume this
stream.

**Reads are cheap and project-scoped.** `byTask`, `byTaskSince`, `after`, `all`, and the
count-only `countAfter` (used by health probes so they never materialize whole payloads) all
filter on `project_id` and bypass the write lock — they're ordinary indexed queries
(`idx_events_project_seq`, `idx_events_project_task_seq`, `idx_events_project_kind_seq`).

## 2. The operation journal — durable before/after nodes for external effects

**File:** `packages/kernel/src/storage/operation-journal.ts` (table: `operations` in
`packages/kernel/src/schema.ts`).

Every model call and every tool call an agent makes is wrapped in an **operation**: a durable
node that is written *before* the external effect runs and resolved *after*. This is what turns
"did that model call actually happen?" from a guess into a fact you can query.

- `beginOperation(context, spec)` commits an `operation_started` event (idempotency key
  `<operationId>:<attempt>:started`) and upserts a `started` row into `operations` — **before**
  the model/tool call is made. If a node for this `operationId` is already `completed`, it's
  reused and the effect is never re-run (`{ reused: true, value: existing.after }`). If it was
  merely `started` or `failed`, this begins a new attempt (`attempts + 1`) — an explicit,
  visible, at-least-once retry.
- `completeOperation(context, spec, attempt, value, drafts)` commits `operation_completed` plus
  any additional drafted events, in the same locked transaction. Re-entering with the *same*
  attempt number that's already completed is a no-op re-entry (returns the stored value — a
  "lost ack" after the effect succeeded but before the caller learned about it). Re-entering with
  a *stale* attempt throws a `terminalError` so the caller never re-fires an effect over a newer
  attempt.
- `failOperation` records `operation_failed`, but is a deliberate no-op if the node is already
  `completed` — a completed node can never be regressed by a straggling failure from an earlier,
  ambiguous attempt.

**Node and history can never disagree.** Every one of these calls appends its transition event
*through the same `EventLog`* inside the *same* `withProjectLock` transaction that writes the
`operations` row. There is no window where the row says one thing and the log says another.

**The journal is a rebuildable index, not truth.** `rebuildOperations()` deletes all
project-scoped rows and refolds them from `operation_started`/`_completed`/`_failed` events via
`foldOperations()` — the exact same `applyOperationEvent()` transition function
(`packages/kernel/src/projections.ts`) that the live path uses. Live writes and a from-scratch
rebuild are structurally guaranteed to agree.

**What a crash looks like here.** A process death between `beginOperation` and
`completeOperation`/`failOperation` leaves a node with `status: 'started'` — an honest,
queryable "unresolved" state, never a silent gap. You can see it in three places:
- `orc status <taskId>` (`packages/cli/src/main.ts`) prints every operation with its
  `kind`/`name`/`status`/`attempts`.
- `orc replay <taskId> --at <seq>` folds the log only up to a chosen sequence, so you can watch a
  node go from `started` to `completed` event-by-event.
- `vault/tasks/<id>/execution.md` (rendered by `renderExecution()` in
  `packages/vault-projector/src/render.ts`) draws every operation as a mermaid node; an
  unresolved one gets a visually distinct dashed amber style (`classDef unresolved ...
  stroke-dasharray: 5 5`).

## 3. Crash and resume — DBOS durable workflows

**File:** `packages/kernel/src/execution/dbos-port.ts`.

`orc run`/`orc retry` execute plans as [DBOS](https://docs.dbos.dev/) durable workflows with
**deterministic workflow IDs**:
- Run: `` `run:${taskId}:v${approvedPlanVersion}` `` (or `:r${retryIndex}` for a retry).
- Step: `` `step:${taskId}:${stepId}:a${attempt}` ``.

Because the ID is deterministic, re-running `orc run <taskId>` after a crash doesn't start a
second, competing run — DBOS recognizes the same workflow ID and attaches to (or resumes) the
existing one.

Two wrapper primitives sit between the workflow body and durability:

- **`checkpoint` (`Checkpoint` type, `packages/contracts/src/execution.ts`)** wraps
  `DBOS.runStep`, with a retry policy of up to 4 attempts, exponential backoff (rate 2, 1s base),
  and `shouldRetry: !isTerminalError` — a `terminalError()` (e.g. a validation failure) is never
  retried. Any events a checkpoint drafts (via its `toEvents` callback) are appended in one
  transaction with a deterministic idempotency key (`` `${runToken}:${name}:${i}:${kind}` `` by
  default), so a checkpoint retry after a crash re-appends nothing — it gets the already-committed
  rows back.
- **`operation` (`OperationCheckpoint` type)** is the same idea, specialized to route through the
  operation journal from §2: on recovery, a `completed` node short-circuits with its stored,
  already-redacted value — **the model/tool call itself is never re-run.**

**A subtle but important redaction detail.** DBOS persists every step's return value into its
*own* system database (`operation_outputs` table, same Postgres cluster, but a database DBOS owns
directly — not behind `EventLog`'s redactor). `redactStepResult()` in `dbos-port.ts` scrubs every
value on the way out of a checkpoint/operation specifically because of this — it's the one place
raw tool/model output would otherwise leave the process unredacted.

**Step completion is one atomic transaction.** When a step signals success, the `finish`
checkpoint verifies its declared output files (`verifyArtifacts`, §4) and commits the resulting
`artifact_produced` receipts *and* the terminal `step_completed` event together — a step can
never be marked `completed` without its receipts existing, and vice versa. If that transaction
already landed before an earlier crash (detected by checking whether `step_completed` for this
`runToken` is already in the log), verification is skipped rather than re-hashing a workspace that
may have changed since — re-verifying could otherwise flip a durably-recorded success into a
failure.

**How resume actually triggers.** `port.launch()` calls `DBOS.launch()`
(`packages/kernel/src/execution/dbos-port.ts`, wired from `packages/cli/src/runtime.ts`'s
`buildRuntime`) — this is a DBOS SDK call, and DBOS's own recovery logic re-attaches to every
pending workflow the moment it launches. There is no bespoke "resume" code in this repo; resume
*is* what DBOS does at startup, on top of the checkpoint/operation primitives above making that
resume safe (no double-billed model calls, no duplicated events).

**Wave scheduling replay determinism.** The run workflow launches every *ready* step of a wave,
awaits the whole wave, then recomputes readiness — deliberately not a continuous
first-one-back-triggers-the-next scheduler. The comment in `dbos-port.ts` explains why: DBOS binds
child workflow handles *positionally* (by call-site slot, not by the ID you pass), so replay order
must be a pure function of `(plan, done, failed)` — identical on first run and on every replay — or
two steps finishing out of order could swap handles on recovery.

**This is proven by an actual `kill -9` test.** `packages/kernel/src/execution/resume.test.ts`
("kill -9 resume (spec §10/§11 — the crown jewel)") spawns a real child process running a step,
waits until it's stalled mid-operation, sends `SIGKILL`, then re-spawns the same command and
asserts: the task reaches `done`; the operation journal shows exactly 2 `operation_started`
events and 1 `operation_completed` (attempt 1 vanished, attempt 2 finished — an honest gap, never
a blind one); domain events like `agent_call` and cost usage appear exactly once (not double
billed); and `fold()` over the reopened log matches folding the pre-crash state exactly. A second
test in the same file exercises two independent steps finishing out of plan order, to catch the
positional-binding scheduling bug described above.

## 4. Output receipts — verified, hashed artifacts

**File:** `packages/kernel/src/execution/artifacts.ts`.

`verifyArtifacts(workspaceDir, paths)` is called *only* from the trusted `finish` checkpoint
inside `dbos-port.ts` — never by agent/tool-controlled code. It:

1. Runs `validateOutputPaths` (shared with the executor's own pre-flight check, from
   `@orc/contracts`) to enforce workspace containment, that each path is a regular file, and no
   duplicates.
2. Reads each file's bytes itself and computes `sha256` + byte size.

The agent supplies *paths*; it never supplies a hash — the receipt is derived by trusted code.
Receipts land as `artifact_produced` events (`{ path, sha256, size }`, keyed
`` `${runToken}:artifact:${path}` ``) committed in the same transaction as `step_completed` (§3),
so a completed step can never be missing its receipts.

`state.artifacts` (`fold()` in `packages/kernel/src/projections.ts`) accumulates these per task.
You can see them via:
- `orc status <taskId>`: `out <stepId> <path> · sha256:<12 hex chars> · <size>B`
- `vault/tasks/<id>/lineage.md` (`renderLineage()` in `packages/vault-projector/src/render.ts`):
  a mermaid graph from producing step → receipt node.

## 5. Replay — `fold(events)` is pure, deterministic, and lenient

**File:** `packages/kernel/src/projections.ts`.

`fold(events: EventRecord[]): State` is the **one** function that rebuilds all derived state
(tasks, plans, per-step run status, runs, token/cost usage, splits, operations, artifacts) from an
ordered event array. Properties that make this a real durability guarantee rather than just a
convenience function:

- **Pure and total.** No I/O, no throwing on bad input. Every event kind's payload is parsed with
  `.safeParse()` against a *looser* read-side `View` schema (deliberately looser than the
  write-time `PAYLOAD_SCHEMAS`, so an old event shape from a prior schema version still folds
  instead of crashing the whole replay) — a malformed or historical payload just skips that one
  case.
- **Crash-deduplicated.** `crashDedupKey(e)` computes a stable key
  (`` `${runToken}:${kind}:${iteration}:${toolCallId}:${name}:${splitId}:${path}` ``) for
  events whose kind could plausibly be re-appended by a workflow retry after a crash, and `fold`
  skips any event whose key it's already seen. `task_status_changed` and operation-journal
  transition events are excluded from this — they're protected by other means (DB idempotency
  keys, explicit attempt semantics) that would otherwise collide legitimately (e.g. attempt 1 and
  attempt 2 of the same operation must both count).
- **Operation and event-log transitions share one function.** `applyOperationEvent()` (also in
  this file) is called both by `fold()` directly for `operation_*` events and by
  `OperationJournal`'s live path and `rebuildOperations()` — one transition function, three
  callers, guaranteed to agree.

**Replay is not a separate subsystem — it's just calling `fold` with a slice of events.**
`orc replay <taskId> [--at <seq>]` (`packages/cli/src/main.ts`) filters `kernel.eventsFor(taskId)`
down to `seq <= at` and folds that. `orc status` folds the whole log. Reopening a `Kernel` against
the same rows after `.close()` (simulating process death) and folding again reproduces the exact
same `State` object — proven in `packages/kernel/src/replay.test.ts` ("replay guarantee (spec
§10)"), which explicitly frames one test as the "kill -9" scenario: create tasks/plans/approvals
in one `Kernel` instance, close it, open a *fresh* `Kernel` against the same database, and assert
`k2.state()` equals the pre-close state. Another case in that file walks a full operation
started → completed lifecycle and checks that the folded state, the durable `operations` row, a
replay truncated to the start-only sequence (showing an honestly `started` node), and a
freshly-reopened log all agree on one history.

## 6. Where to look next

| Question | File |
|---|---|
| How does a write actually commit? | `packages/kernel/src/storage/event-log.ts`, `postgres.ts` |
| What gets redacted, and when? | `packages/kernel/src/redact.ts` |
| How is a model/tool call made crash-safe? | `packages/kernel/src/storage/operation-journal.ts` |
| How does `orc run` resume after a crash? | `packages/kernel/src/execution/dbos-port.ts` |
| How are output files verified? | `packages/kernel/src/execution/artifacts.ts` |
| How is state rebuilt from history? | `packages/kernel/src/projections.ts` |
| Where's the proof this all works? | `packages/kernel/src/replay.test.ts`, `packages/kernel/src/execution/resume.test.ts` |
| CLI surface for inspecting durability | `orc status`, `orc replay`, `orc log` in `packages/cli/src/main.ts` |
| The full system map | [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) |

Feedback delivery (`feedback_provided` as a durable outbox) and grounded-plan approval hashing are
close cousins of this durability story but are their own topic — see the "Feedback delivery and
grounded approval" section of `docs/ARCHITECTURE.md`.
