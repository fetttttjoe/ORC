# Seams Reference Guide — Component Interactions & Debugging

This guide maps the component interactions described in `ARCHITECTURE.md` to concrete call paths, data flows, and debugging strategies. Use it to understand how parts of the system communicate and to diagnose issues.

Tier numbers below are ARCHITECTURE.md's three tiers, not a call depth: **①** application (CLI, kernel, plugins — never touches a DB directly), **②** data-access services (`openStorage`, `openKnowledge`, the vault writer), **③** the databases and files themselves. The kernel is tier ①; it takes an `EventLog`, not a pool.

## Call paths by scenario

### Scenario 1: A step executes and calls a model

**Starting point:** User calls `orc run <task>`

A client never starts a run. It **records the ask** and watches the stream; the supervisor turns that
ask into a workflow. This is what lets a run outlive the terminal that asked for it.

**Tier ① (application — CLI):**
1. `packages/cli/src/main.ts` `run` command → `kernel.requestRun(taskId, { cwd })`, which appends `run_requested` and returns its seq. There is no `kernel.startRun`. The CLI then tails the log from that seq; `ctrl-c` ends the watch, not the run
2. Before recording, it enforces the same drivable-status admission `startRunAt` does — a `run_requested` naming a draft or terminal task would otherwise sit in the log forever with nobody able to serve it

**Tier ① (application — supervisor):**
3. `packages/kernel/src/execution/signal-router.ts` sees `run_requested` over `LISTEN/NOTIFY` and calls the port's `startRunAt`, which starts the run workflow under the deterministic id `run:<taskId>:v<planVersion>` (`:r<n>` on retry). `port.launch()` is the boot-time `DBOS.launch()`, not a per-run call
4. The run workflow launches each dependency **wave** of ready steps and awaits the wave whole, then recomputes readiness — DBOS binds child handles positionally, so launch order must be a pure function of `(plan, done, failed)`
5. `packages/kernel/src/execution/dbos-port.ts` runs each step as its own workflow (`step:<taskId>:<stepId>:a<attempt>`) and hands the injected executor a `ctx` carrying `checkpoint`, `operation`, and `memory`

**Tier ① (application — executor plugin):**
6. `plugins/executor-api-loop/` iterates: `ctx.checkpoint('preload', () => memory.recall(budget))` before the first prompt (so a replay reuses the recorded notes), then model and tool calls — each wrapped in `ctx.operation(spec, fn)` — until `signal(success)` or a terminal error

**Tier ② (data-access service):**
7. `ctx.operation` → `operationJournal.beginOperation(...)` records `operation_started` *before* the external call, then `completeOperation` commits `operation_completed` plus the drafted `agent_call` / `tool_result` in ONE locked transaction (see "Storage service" below)

**Outcome:** Events in Postgres: `run_requested`, `run_started`, `step_started`, then per call `operation_started`, `agent_call` / `tool_result`, `operation_completed` (or `operation_failed`)

**How to trace:**
- `orc log <task> --json` shows every event in order
- `orc status <task>` shows the execution breakdown: steps, their operations, operation status
- `orc replay <task> --at <seq>` freezes the state at any event sequence

---

### Scenario 2: A plan is approved by a human

There are **two** approval gates and they write different events. Confusing them is the usual reason
a grep here comes back empty.

**Gate A — `orc approve <taskId>`, the ordinary plan gate. No hash.**

**Tier ① (application — kernel):**
1. `packages/kernel/src/kernel.ts` `approvePlan(taskId, version?)` requires status `awaiting_approval`, and rejects a stale `--version` with `version_conflict`
2. In ONE transaction it appends `plan_approved` (`approvedBy: human | policy | mcp`) and `task_status_changed → approved`. It does NOT append `feedback_provided` and computes no plan hash

**Tier ① (application — signal router):**
3. `packages/kernel/src/execution/signal-router.ts` sees `plan_approved` for a task with a pending split and calls `port.startChildRun(childTaskId)`. Approving only *unblocks* a child — something still has to execute it, which is why the CLI ensures a supervisor exists before appending the approval that supervisor has to react to

**Gate B — `orc reply <taskId> approve`, the grounded-plan gate. This one is bound to a point in the log.**

4. `kernel.replyFeedback` answers the open `feedback_requested`. When the task is `grounded` and the reply is exactly `approve` on the plan step, it stamps `planHash` — `planGraphHash(foldPlanNotes(...))`, SHA-256 over the canonical plan-note graph — onto the `feedback_provided` payload. That hash is the audit record of what was approved, and the marker `approvedPlanHash` uses to tell a plan approval from any other `approve`; the gate itself does not compare it. Its value is reproducible only by the build that stamped it, so it attests *that an approval happened over some graph*, never *that it was this graph* — do not compare it against a freshly computed one
5. The plan-authoring agent then calls `finalize_plan`, which locates the approval with `kernel.approvedPlanHash(taskId, runToken)` and refuses the freeze when `kernel.planNotesChangedSince(taskId, approvedSeq)` is non-empty — any plan-tier write or any delete in the task's plan scope after the approval — *naming the ids*, so the agent learns which edit cost it the gate instead of only that something moved. That is equivalent to "the graph is unchanged", since `foldPlanNotes` reads exactly those events, and unlike comparing two content hashes it cannot disagree with itself when the approving process and the executor are different builds. Missing, cross-run, or stale approval fails before any child split

**How to debug approval issues:**
- Ordinary gate: `orc log <task> --json | jq '.[] | select(.kind == "plan_approved")'` — check `approvedBy`
- Grounded gate: `orc log <task> --json | jq '.[] | select(.kind == "feedback_provided") | .payload.planHash'`
- `cannot approve while task is '<status>'` means the task is not at `awaiting_approval` — check `orc status <task>`
- `the plan-note graph changed after approval` from `finalize_plan`: the notes it names moved between the human's `approve` and the freeze. Re-approve, then call `finalize_plan` without editing in between

---

### Scenario 3: Memory writes a note; it becomes searchable

**Starting point:** A step calls `memory_write(note)` via the memory tool

**Tier ① (application — memory tool):**
1. `plugins/memory/src/tools.ts` `memory_write` tool → parses the draft, then calls `store.write(draft, author, opts)`. It records NO `memory_accessed`: a write is not a read. `addClaims` / `invalidates` are parsed off the call here and never become note fields.

**Tier ① (application — memory business logic):**
2. `plugins/memory/src/store.ts` `createMemoryStore().write` → inside ONE `log.transaction`: reads the merge base with `tx.latestNoteEvent(scope, id)` (one indexed row, migration 0004 — not a fold), resolves the live claim set through `resolveClaims(live, addClaims, invalidates, revision)`, then `tx.append`s `memory_written` with `{ note, author, invalidates }`. The store never touches Surreal — it is the single writer, and the read model is the projector's job.

**Tier ② (data-access service — Postgres):**
3. `tx.append` → calls `PostgresStore`, which:
   - Acquires the per-project advisory lock (`withProjectLock`)
   - Jsonb-shapes and redacts the payload
   - Validates the *redacted* payload against `PAYLOAD_SCHEMAS[kind]`
   - Inserts into `events` table (atomic, one transaction)
   - Sends `pg_notify` to all subscribers
   - Commits

**Tier ① again (application — memory projector, writing through tier ②):**
4. `plugins/memory/src/projector.ts` sees the `memory_written` event in the subscription and calls `surreal.applyEvent(e)` — note row, typed edges, `claim` rows and the cursor commit in ONE Surreal transaction, gated on `e.seq > cursor` so redelivery is a no-op. `validFrom` is stamped here, from the committed event.
5. Only after an accepted apply: the note's markdown file is written, and `renderMemoryIndex` rebuilds `vault/memory/index.md`. A crash between the two heals on the next start/catchUp/rebuild.
6. If the drain accepted any `memory_written`/`memory_deleted` (i.e. the claim set could have changed), `surreal.refreshTopics()` recomputes the whole `topic` table — stage 3, outside the event transaction, best-effort: a grouping failure leaves the previous topic table readable and never fails the drain.

**Outcome:** 
- Note is in Postgres (canonical)
- Note and its claims are queryable in Surreal (read model); topics are repartitioned
- `vault/memory/index.md` is updated (human projection)
- Next `memory_search` (both arms), `memory_neighbors`, `memory_topics` or `memory_recheck` sees it

**How to debug memory issues:**
- `orc memory ls` lists all notes; `hits` column shows access count
- `orc memory cat <id>` shows the full note
- `orc memory claims <id>` shows a note's live claims; `--history` folds the log instead, which is the only way to see a RETIRED claim and the write that retired it (the tombstone lives on the event, never on the note). `--json` prints the raw claim array of whichever form you asked for — pretty-printed, no envelope — and an empty result is `[]` with exit 0, so a script reads absence as data instead of parsing the human throw
- `orc memory topics` lists the derived groups (as tab/space-separated human rows); `orc memory topics --json` prints the same inventory as pretty-printed JSON. "no topics" with claims present means stage 3 has not run or the embedder is down; with `--json` an empty inventory prints `[]`. "no topics" on a pre-claims corpus is correct — see the note under the pipeline above
- SurrealDB down? → `memory_write` tool returns `memory unavailable` but the event still writes to Postgres; vault/memory rebuilds when SurrealDB comes back up
- `orc status <task>` prints `memory: unreachable` if Surreal is down, and `memory: catching_up` while the projector is behind — those are different problems, and collapsing them used to light the degraded badge on every burst of note writes
- Check `vault/memory/index.md` — if empty, SurrealDB projector has not run yet; restart the CLI

---

### Scenario 4: Task splits into children

**Starting point:** A running step calls the `task_split` tool

**Tier ① (application — executor):**
1. The model emits a `task_split` tool call; the loop executes it like any other resolved tool. There is no `ctx.split` — the tool is `packages/kernel/src/execution/split-tool.ts` (`ref: kernel/task_split`), handed to the step by the port. It is withheld from a scout (`ANALYZE_STEP_ROLE`): a scout orients, it does not decompose.

**Tier ① (application — kernel):**
2. `split-tool.ts` `execute` → `kernel.proposeSplit(...)`, keyed by the provider's real `toolCallId` so a checkpoint replay reuses the same `splitId` instead of splitting twice
3. `packages/kernel/src/kernel.ts` `proposeSplit` → in ONE transaction: `task_created` for the child, `split_proposed` on the PARENT's stream, then `plan_proposed` for the child's expanded plan. There is no `split_approved` event — that name is not in `EventKind`
4. Whether the child is gated is the project's `approvalPolicy`: an auto-approving rule appends `plan_approved` (`approvedBy: policy`) in that same transaction; otherwise the child parks at the human gate
5. `packages/kernel/src/execution/signal-router.ts` sees `plan_approved` for a task with a pending split and calls `port.startChildRun(childTaskId)` — idempotently, and again at startup for an approved child whose run never started
6. When the child reaches a terminal status the router composes the join payload and appends `split_resolved`, which is what unblocks the parent's `join_splits`

**Tier ② (data-access service):**
7. Events written to Postgres (canonical history)

**Outcome:** 
- Each child is a new task in `state.tasks`
- Children appear in `vault/index.md` under their parent's tree
- Each child can be `orc run` independently, or they start automatically once approved

**How to debug splits:**
- `orc log <parent> --json | grep -E "task_created|split_proposed|plan_approved|split_resolved"` to see the split trigger, its approval, and its join
- A split that never starts is almost always a gated child: `orc status <parent>` prints `awaiting approval: <title>  (orc approve <childTaskId>)` for each one
- A parent stuck in `step_started` for hours with a `split_proposed` and no `split_resolved` is waiting on a child that will never finish. There is no timeout — the gate is human. If the child is unrecoverable, `orc cancel <childTaskId>`: the router composes the join from any TERMINAL child status, so the parent's `join_splits` unblocks with `outcome: 'cancelled'` instead of hanging. Cancelling the *parent* strands nothing but tells you nothing either
- `vault/index.md` shows the task tree with nesting

---

### Scenario 5: An artifact is produced; its receipt is verified

**Starting point:** A step signals success with `outputs: ["file.txt"]`

**Tier ① (application — executor):**
1. `plugins/executor-api-loop/src/index.ts` calls `ctx.signal(success, { outputs: [...] })`

**Tier ① (application — kernel execution port):**
2. `packages/kernel/src/execution/dbos-port.ts`'s trusted `finish` checkpoint — never agent- or tool-controlled code — calls `verifyArtifacts(workspace, outputs)` (`packages/kernel/src/execution/artifacts.ts`)
   - `validateOutputPaths` enforces workspace containment, regular-file-ness, and no duplicates
   - Reads each file's bytes *itself* and computes SHA-256 + byte size. The agent supplies paths; it never supplies a hash

**Tier ② (data-access service):**
3. Writes `artifact_produced` events (one per artifact), each `{ path, sha256, size }`, keyed `<runToken>:artifact:<path>`, in the SAME transaction as `step_completed` — so a completed step can never be missing its receipts, and vice versa
4. If that transaction already landed before a crash, verification is skipped rather than re-hashing a workspace that may have changed since — re-verifying could flip a durably-recorded success into a failure

**Outcome:**
- Artifact is recorded with a content hash receipt
- `vault/tasks/<id>/lineage.md` lists all artifacts with their hashes
- Audit trail is complete; a later replay can verify the receipt matches

**How to debug artifact issues:**
- `orc log <task> --json | grep artifact_produced` shows all produced artifacts with their hashes
- `vault/tasks/<id>/lineage.md` shows which step produced each artifact
- To check a receipt by hand: `sha256sum <path>` and compare against `lineage.md`. A mismatch means the workspace changed *after* the step completed — the receipt is not wrong, the file is no longer the one that was signed
- Artifact validation failure? Check workspace permissions, symlinks, and file encoding (only UTF-8 for text is captured; binary is size + hash only)

---

## Storage service call paths

The `Storage` facade (described in ARCHITECTURE.md) is the one place Postgres reads/writes happen. Every caller uses one of two interfaces:

### EventLog interface (`storage.events`)

| Method | Effect | Transaction |
|---|---|---|
| `append(input)` | ONE `EventInput` object (`{ kind, payload, taskId, stepId, runToken, usage?, idempotencyKey? }`), typed as a discriminated union over `kind` so the compiler holds `payload` to the schema that kind names. Acquires project lock → parse the envelope with an opaque payload → jsonb-shape → redact → validate the *redacted* payload → INSERT `ON CONFLICT (project_id, idempotency_key) DO NOTHING` → pg_notify → commit. Validation runs on the redacted payload so a zod error can never quote a secret back | ONE lock-held transaction |
| ⮑ on conflict | A key that already committed is **not** silently absorbed. The stored row is re-read and returned only if kind, taskId, stepId, runToken, payload and usage are all deep-equal; anything else throws `idempotency_conflict` (`idempotency key '<k>' reused with different event data`). A replay that absorbed a *changed* payload would rewrite history under the cover of a retry | — |
| ⮑ payload shaping | The jsonb round-trip drops `undefined`-valued keys before the redact-and-compare, so a byte-identical keyed replay still deep-compares equal; `\u0000` is stripped from every string because Postgres jsonb cannot store it. A tool result carrying binary comes back NUL-free — that is the storage boundary, not a bug in the tool | — |
| `transaction(fn)` | Runs `fn(tx)` under one project lock; every read+append inside is atomic. This is how a read that decides a write stays safe | ONE lock-held transaction |
| `subscribe({ fromSeq }, cb)` | Opens PG client, LISTEN, retries on reconnect. NOTIFY is only a wake-up — the authoritative read is a catch-up `WHERE seq > cursor`, and the cursor advances only after the handler resolves | No transaction; async callback on each event |
| `all()` | SELECT all events for project, ordered by seq | Read-only, no lock |
| `byTask(taskId)` / `byTaskSince(taskId, afterSeq)` | SELECT events for one task | Read-only, no lock |
| `after(seq, kinds?)` | SELECT events after a sequence, optionally filtered by kind — how every projector drains | Read-only, no lock |
| `countAfter(seq, kinds?)` | Count only, so a health probe never materializes payloads | Read-only, no lock |
| `latestNoteEvent(scope, id)` | Newest `memory_written`/`memory_deleted` naming one note — one indexed row (migration 0004), the memory store's merge base | Read-only, no lock |
| `earliestSeq()` | Oldest surviving seq, so a cached reader can detect a TRUNCATED log (purge, delete chat), which no event announces | Read-only, no lock |

### OperationJournal interface (`storage.operations`)

| Method | Effect | Via EventLog |
|---|---|---|
| `beginOperation(context, spec)` | Records `operation_started` in log AND journal table, keyed `<operationId>:<attempt>:started`. An already-`completed` node is reused (`{ reused: true }`) and the effect never re-runs | Appends through `EventLog`, same lock |
| `completeOperation(context, spec, attempt, value, drafts)` | Records `operation_completed` + the drafted result events (`agent_call`, `tool_result`, …). Same attempt already completed = no-op re-entry; a *stale* attempt throws `terminalError` | Appends through `EventLog`, one transaction |
| `failOperation(context, spec, attempt, error)` | Records `operation_failed` — a deliberate no-op if the node is already `completed`, so a straggling failure can never regress a success | Appends through `EventLog` |
| `operationsFor(taskId)` | Read the durable nodes for one task (what `orc status` prints) | Read-only |
| `rebuildOperations()` | Deletes the project's rows and refolds them from the log via the same `applyOperationEvent` the live path uses | Read-only over events |

### How the lock prevents corruption

The lock is `pg_advisory_xact_lock`, which is **transaction-scoped**: it is released the instant the transaction ends — commit, rollback, or the backend dying with it. So a crash during an append does not strand it, and there is no timeout to wait out. Concurrent writers block on `pg_advisory_xact_lock` until the holder's transaction ends, then proceed. Reads bypass the lock entirely and see whatever was last committed.

The journal uses idempotency keys (`DBOS__IDEMPOTENCY_KEY` or a deterministic hash of the operation spec) so a crash during `begin → fn → complete` can safely retry: the second attempt reuses the same journal row, avoiding duplicates.

---

## Memory subsystem interaction

The memory system is **event-first**: the Postgres event log is the source of truth; SurrealDB and vault/memory are disposable projections.

```
Event log (Postgres)
    ↓ (memory_written, memory_deleted, memory_accessed — MEMORY_KINDS, the drained set)
SurrealDB — per-event, in one transaction (note + link + claim tables, project-scoped database)
    ↓ (stateless recompute from the claim table, outside the event transaction)
SurrealDB — topic table (claims grouped by embedding cosine)
    ↓ (every note, every link, ranked by hits/updatedAt)
vault/memory/index.md (deterministic markdown rendering)
    ↓ (mermaid graph, notes list)
Human reader / future agent
```

Three stages, in that order: append → project per event → derive by stateless recompute. Stage 3
may never be the only writer of a fact — the `topic` table is derivable from the `claim` table,
which is derivable from the log, and `orc memory rebuild` drops and reproduces both. A note that
states no claims contributes no claim rows, and a rebuild does not invent them.
See [claims and topics](ARCHITECTURE.md#claims-—-the-addressable-unit-of-knowledge).

`memory_topic_accessed` is deliberately NOT in that drained set (`MEMORY_KINDS` in
`plugins/memory/src/projector.ts`). It projects to nothing: it is pure measurement, the signal
`MEMORY_CLUSTER_THRESHOLD` is calibrated against, and it survives in the log alone — which is the
point, since the topic it names is derived and a rebuild can reshape it.

**Degraded mode:** If SurrealDB is down:
- `memory_write` tool returns `memory unavailable`
- Events still append to Postgres (so the data is not lost)
- Search/neighbors/cat tools return `memory unavailable`
- On next CLI startup, the projector reconnects and rebuilds vault/memory from events (this may take a few seconds for a large graph)

**Repair on data loss:** If the Surreal database is corrupted or stale, rebuild it from the log —
this is the supported route, and it is a first-class command, not a docker incantation:
```bash
orc memory rebuild   # clear() drops note/link/claim/topic + cursor in ONE transaction, then replays
```
`clear()` is atomic on purpose: `applyEvent` gates replay on `e.seq <= cursor`, so a clear that
dropped content while leaving the cursor ahead of it would be unrecoverable — "no events after the
cursor" would be true. Note that a corpus written before claims existed comes back with zero claims
and therefore zero topics; that is correct, not a broken rebuild.

Surreal's own database name is `projectDatabaseName(base, projectId)` = `<base>_<projectSuffix>` —
derived, never `orc-<projectId>`. Reach for `surreal remove` only if the rebuild itself cannot open
the database.

---

## Knowledge graph structure

The knowledge graph is a DAG of `MemoryNote` objects. Every note, whatever tier, carries:
- `id` — stable identifier (lowercase alphanumeric + hyphens)
- `scope` — namespacing: `"project"` (the default), or a per-task plan scope (`planScope(taskId)`)
- `links` — typed edges to other notes: `refines`, `supersedes`, `contradicts`, `depends_on`, `example_of`, `derived_from`, `relates_to`, `decomposes_into`
- `title`, `summary`, `body` — the note content (`body` up to `MEMORY_LIMITS.bodyChars` = 100,000 chars stored; only the first `searchableBodyChars` = 7,000 reach the embedder)
- `tags` — for filtering and discovery (lowercased at the boundary)
- `sourceRevision` — the Git HEAD the store stamped at write time; an agent cannot supply one

The **tier** decides which further fields a note may carry, structurally — a step note cannot grow claims, and a claim cannot smuggle a write-fence (`NOTE_TIERS` in `packages/contracts/src/memory.ts`):
- `semantic` (default) — durable project knowledge, and the only tier with the retrieval surface: `kind` (one of `fact`, `decision`, `architecture_current`, `architecture_target`, `documentation`, `research` — `plan` is a TIER, not a kind), `categories`, `paths`, `sources` (citations with `url` + optional `title`, required for `kind=research`), `retention` (`durable` default, or `expirable`), and `claims`
- `episodic` — the trail a run leaves behind. Core fields only, `retention` PINNED `expirable`
- `plan` — one node of a decomposition: `rationale`, `uncertainty`, `zone`

**Claims** are the addressable unit on a semantic note: each is a statement whose id IS its content (`claimId(text)` = sha256 of the whitespace-normalized text, first 12 hex chars). Writers add and retire them by name (`addClaims` / `invalidates`) — supplying the array is deliberately impossible. `validFrom` is stamped by the projector. **Topics** group claims by embedding cosine and are derived, never authored.

**Access pattern:** `memory_search(query, category, tag, mode, limit, budget)` is hybrid (vector ⊕ keyword, falling back to keyword with no embedder) and returns TWO arms — matched claims first, then summaries of notes that matched without asserting one; `memory_neighbors(seed, kinds, depth, scope)` does a graph traversal; `memory_read(id)` fetches one note; `memory_topics()` lists the derived groups and `memory_topics(topic)` fetches one group's claims; `memory_recheck(limit, budget)` returns the corpus drift verdict — exact counts plus the drifted/unknown note lists.

---

## Vault projections — read-only human views

The vault is **deterministic** — same input events produce the same markdown every time. It lives in the workspace at `vault/`:

### `vault/index.md`

The task tree + status for the project:
- Recursive nesting of parent → children (from each `task_created` payload's `parentId`)
- Status for each task (from `task_status_changed` in the fold)
- Links to `execution.md` and `lineage.md` for each task
- Last update timestamp

**Rebuild trigger:** any event carrying a `taskId`, coalesced to one render per task per 50 ms. The root index itself folds only `task_created` + `task_status_changed` — it must never scan the whole log.

### `vault/tasks/<task-id>/execution.md`

The steps in the approved plan + their execution status:
- Each step from the plan (title, role, instructions, skill/tool refs, depends-on list)
- Run status for each step (pending, running, completed, failed)
- Operation nodes: begin/complete/fail sequence with timestamps and counts
- Unresolved operations (started but not completed; a crash indicator)

**Rebuild trigger:** any event for this task

### `vault/tasks/<task-id>/lineage.md`

Artifact outputs + who produced them:
- Each artifact with path, size, SHA-256 receipt
- Which step produced it
- Links to `execution.md` for context

**Rebuild trigger:** any event for this task — `renderTaskFiles` writes `execution.md` and `lineage.md` from one pass over `log.byTask(taskId)`, so they can never disagree about a run

### `vault/memory/index.md`

The knowledge graph as a mermaid graph + a text list:
- Nodes grouped by scope + kind (e.g., "Architecture — Current", "Decisions")
- Typed edges drawn between notes (colored by edge kind)
- Below the graph, a sortable list (by date, access count, kind)

**Rebuild trigger:** any `memory_written` or `memory_deleted` event

---

## Debugging workflows

### "My step is stuck in 'running' state"

1. Check unresolved operations:
   ```bash
   orc status <task>
   ```
   Look for `operation_started` without a matching completion. The `op` lines print `attempts N`:
   **`attempts` above 1 on a still-`started` node is the ambiguity marker, not noise.** It means a
   previous process committed `operation_started`, then died before `operation_completed` — so the
   external effect *may already have run*. The journal records that rather than hiding it, which is
   the whole point of writing the start before the call.

2. Examine the operation:
   ```bash
   orc log <task> --json | jq '.[] | select(.kind == "operation_started")'
   ```
   Note the `operationId`. Two `operation_started` events sharing one `operationId` with a single
   completion is the same story read from the log side.

3. Check the operation journal in Postgres (optional, requires direct access):
   ```sql
   -- rows are project-scoped, and the key is (project_id, operation_id) — there is no `id` column
   SELECT * FROM operations
    WHERE project_id = '<project-id>' AND task_id = '<task-id>' AND operation_id = '<operationId>';
   ```

4. Decide:
   - **If it's a dead provider call:** `orc retry <task>` — DBOS will retry unresolved operations
   - **If the step code is genuinely hung:** kill the `bun run` process and retry (DBOS detects the crash and retries)
   - **If you want to skip it:** there is no skip mechanism — `orc cancel <parent>`, fix the plan, and re-run

### "Memory says unavailable"

The tool error is `memory unavailable: <reason>`. `orc status <task>` reports the read model's health
as one of three states, not a boolean: `ok`, `catching_up` (the projector is mid-drain — a healthy
system under write load) and `unreachable` (a real fault). Only the third one is this workflow.

1. Check SurrealDB — the compose service is `surrealdb`, and it has no `container_name`, so address
   it through compose rather than guessing a container name:
   ```bash
   docker compose ps surrealdb
   docker compose logs surrealdb
   ```

2. Restart SurrealDB:
   ```bash
   docker compose restart surrealdb
   ```

3. The projector will reconnect and rebuild vault/memory on the next CLI command.

4. If SurrealDB lost data, replay the log into it:
   ```bash
   orc memory rebuild  # atomic clear + replay from events
   ```

### "I can't find a note I wrote"

1. Check that it's in the Postgres log:
   ```bash
   orc log <task> --json | jq '.[] | select(.kind == "memory_written")'
   ```
   If it's not there, it was never written — check the task's step output for errors.

2. Check the Surreal cache:
   ```bash
   orc memory ls          # does it show?
   orc memory cat <id>    # full note
   orc memory claims <id> # its live claims, if it is a semantic note
   ```
   If not, SurrealDB is stale — `orc memory rebuild`.

3. Check vault/memory/index.md — if the graph is not there, the projector hasn't run yet.

### "The task tree is wrong in vault/index.md"

1. Check the `task_created` and `split_proposed` events:
   ```bash
   orc log <parent> --json | jq '.[] | select(.kind | match("task_created|split_proposed"))'
   ```

2. Re-trigger the vault projector:
   ```bash
   orc status <parent>  # forces a re-render
   ```
   The vault is projector-driven, not event-driven; a storage replay does not automatically rebuild it.

3. If stale, reset the whole vault:
   ```bash
   rm -rf vault/
   orc status <any-task>  # full rebuild from events
   ```

### "The step stopped mid-loop and the provider reported nothing"

Look for a `step_failed` whose class is `budget_exceeded`, message `budget exhausted before iteration <n>`.
The loop checks the remaining budget *before* each model call, so an exhausted step dies without a
provider error to point at — there is nothing wrong upstream to find.

```bash
orc log <task> --json | jq '.[] | select(.kind == "step_failed") | .payload'
orc status <task>   # cost line at the bottom is the spend that got you here
```

The envelope is the **tightest** remaining budget over the whole ancestor chain — for each ancestor
that set one, `budgetUSD − subtreeUsage(ancestor)`, minimised. That is why a child with its own
generous `--budget` still stops: an ancestor's cap binds it. Enforcing at the spend point across
ancestors is what stops N sibling splits, each handed the full remaining budget before any of them
spends, from together overrunning the parent. Raise the cap on the *binding* ancestor, not the leaf.

### "Every command fails before it does anything"

```
database schema is behind (3/5 migrations applied) (checked localhost:5433/orc) — run 'orc db migrate'
```

`assertMigrated` reads drizzle's bookkeeping table on every `openStorage` and refuses to run against
a database it does not recognise. The host is printed with the password stripped, so the message is
safe to paste into an issue. Migration is never implicit and never automatic on startup:

```bash
orc db migrate
```

`orc db migrate` (like `orc init`) runs before Postgres, plugins and identity are wired up, so it
still works when nothing else does.

---

## Reference: event kinds involved in each seam

| Seam | Events Written | Events Read | Data-Access Service |
|---|---|---|---|
| Step execution | `operation_started`, `agent_call` / `tool_result`, `operation_completed` | all above (live status) | `EventLog`, `OperationJournal` |
| Plan approval (ordinary) | `plan_approved`, `task_status_changed` | `plan_approved` for routing | `EventLog` |
| Plan approval (grounded) | `feedback_provided` carrying `planHash` | `feedback_provided` for the approval + its seq, then `memory_written` / `memory_deleted` after it for `finalize_plan`'s gate | `EventLog` |
| Memory write | `memory_written` only (note + live claims, plus event-level `invalidates`). NOT `memory_accessed` — a write is not a read | `memory_written` / `memory_deleted` / `memory_accessed` for the projector + search | `EventLog`, Surreal |
| Memory read | `memory_accessed` — on a HIT only, from `memory_read`, `memory_neighbors` (against its seed), `recall` (`mode: preload`, one per owning note) and `orc memory cat`. `memory_search` records nothing | — | `EventLog`, Surreal |
| Topic fetch | `memory_topic_accessed` (topicKey + resolved label). Fetch only — listing records nothing. Projected by nothing; it lives in the log as measurement | the `topic`/`claim` tables | `EventLog`, Surreal |
| Task split | `task_created`, `split_proposed`, `plan_proposed`, then `plan_approved` (policy or human) and `split_resolved` on join | same + plan lookup | `EventLog` |
| Artifact receipt | `artifact_produced` | same (for lineage) | `EventLog`, verify via filesystem |
| Vault render | many reads, no writes | above (sink only) | `EventLog` (read-only) |

---

## Performance notes

| Ceiling | Current Impact | Ponytail Comment |
|---|---|---|
| Per-event refold for `ProjectSessions` | O(events) per event — invisible at <1k events | Swap for incremental kernel `applyEvent` when the log gets large |
| index.md graph size (mermaid) | Renders break at ~500 edges; currently ~0 | Will need step 5 from graph-ui plan when notes exceed ~200 |
| Vault projector I/O | One file per projection task; ~1 commit per event | Batches per drain naturally; no issue observed |
| Postgres advisory lock | Global per project, transaction-scoped, no timeout — a writer waits as long as the holder's transaction runs | Only serializes **writers**; reads are always concurrent. High contention (many simultaneous orc runs) queues. There is no timeout knob and none is exposed; the upgrade is a finer-grained lock, not a longer wait. The pool is capped at `max: 4` for the same reason — extra connections cannot buy write throughput past one lock |
| Whole-corpus topic repartition | O(n²) cosines over every claim, on interactive paths (`catchUp` is awaited by CLI commands) | Only runs on drains that touched the claim set. A refresh past 1,000 ms warns and names `cluster.ts`'s revisit trigger — that warning IS the scaling trigger |

---

## See Also

- `docs/ARCHITECTURE.md` — system map and invariants
- `docs/EXTENDING.md` — how to add a seam
- `vault/memory/index.md` — knowledge graph of architectural decisions
- `docs/IDEAS.md` — deferred improvements with triggers
