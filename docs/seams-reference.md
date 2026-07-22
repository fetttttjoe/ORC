# Seams Reference Guide — Component Interactions & Debugging

This guide maps the component interactions described in `ARCHITECTURE.md` to concrete call paths, data flows, and debugging strategies. Use it to understand how parts of the system communicate and to diagnose issues.

## Call paths by scenario

### Scenario 1: A step executes and calls a model

**Starting point:** User calls `orc run <task>`

**Tier 1 (application):**
1. `packages/cli/src/main.ts` `run` command → `kernel.startRun(taskId, opts)`

**Tier 2 (kernel/business logic):**
2. `packages/kernel/src/kernel.ts` `startRun` → finds the approved plan, calls `dbosPort.launch({ task, plan })`
3. `packages/kernel/src/execution/dbos-port.ts` `launch` → calls DBOS `workflow(...)` to start a durable workflow

**Tier 3 (data-access services):**
4. DBOS internally calls `ctx.operation(spec, fn)` provided by the port
5. `dbos-port.ts` `ctx.operation` → calls `operationJournal.begin(spec, idempotencyKey)` to record `operation_started` in Postgres (see "Storage service" below)

**Tier 1 again (executor plugin):**
6. `packages/kernel/src/execution/dbos-port.ts` injects the executor at `createDbosPort(...executor)` — likely `plugins/executor-api-loop/`
7. `plugins/executor-api-loop/src/index.ts` iterates: call model via `ctx.operation`, then call tools (also via `ctx.operation`), until `signal(success)` or terminal error

**Tier 2 again (storage):**
8. Each model call wraps via `ctx.operation(spec, async () => providerPlugin.call(...))`
9. Storage layer writes journal nodes atomically per step 4

**Outcome:** Events in Postgres: `operation_started`, `agent_call`, `operation_completed` (or `operation_failed`)

**How to trace:**
- `orc log <task> --json` shows every event in order
- `orc status <task>` shows the execution breakdown: steps, their operations, operation status
- `orc replay <task> --at <seq>` freezes the state at any event sequence

---

### Scenario 2: A plan is approved by a human

**Starting point:** User calls `orc approve <task>`

**Tier 2 (kernel):**
1. `packages/kernel/src/kernel.ts` `approvePlan(taskId)` computes SHA-256 of the plan-note graph
2. Creates `feedback_provided` event with the plan hash and the human approval
3. Writes to Postgres via `storage.events.append(...)` (see Storage service below)

**Tier 1 (signal router):**
4. `packages/kernel/src/execution/signal-router.ts` sees the `feedback_provided` event and starts any approved child splits via `task_split` calls

**How to debug approval issues:**
- `orc log <task> --json | grep feedback_provided` to see approval events
- If approval is rejected: check `orc plan <task>` for the exact plan graph, ensure human copied it exactly when calling `approve`
- `finalize_plan` (at propose time) recomputes the hash and must match exactly

---

### Scenario 3: Memory writes a note; it becomes searchable

**Starting point:** A step calls `memory_write(note)` via the memory tool

**Tier 1 (plugin):**
1. `plugins/memory/src/tools.ts` `memory_write` tool → calls `memory.writeNote(note)` and records `memory_accessed` event

**Tier 2 (memory business logic):**
2. `plugins/memory/src/gateway.ts` `writeNote` → calls `storage.events.append(note)` to write `memory_written` event, then calls `surreal.writeNote(note)` to project to the read model

**Tier 3 (data-access services):**
3. `storage.events.append` → calls `PostgresStore`, which:
   - Acquires the per-project advisory lock (`withProjectLock`)
   - Jsonb-shapes and redacts the payload
   - Inserts into `events` table (atomic, one transaction)
   - Sends `pg_notify` to all subscribers
   - Commits

4. `surreal.writeNote` → opens a Surreal session scoped to the project-derived database, inserts/upserts the note row

**Tier 2 again (memory projector):**
5. `plugins/memory/src/projector.ts` sees the `memory_written` event in the subscription, calls `refreshIndex()` to rebuild `vault/memory/index.md`

**Outcome:** 
- Note is in Postgres (canonical)
- Note is queryable in Surreal (read model)
- `vault/memory/index.md` is updated (human projection)
- Next `memory_search` or `memory_neighbors` sees it

**How to debug memory issues:**
- `orc memory ls` lists all notes; `hits` column shows access count
- `orc memory cat <id>` shows the full note
- SurrealDB down? → `memory_write` tool returns `memory unavailable` but the event still writes to Postgres; vault/memory rebuilds when SurrealDB comes back up
- `orc status <task>` shows `memory: unavailable` if Surreal is down at startup
- Check `vault/memory/index.md` — if empty, SurrealDB projector has not run yet; restart the CLI

---

### Scenario 4: Task splits into children

**Starting point:** A plan step contains `task_split(plan)`

**Tier 1 (executor):**
1. `plugins/executor-api-loop/src/index.ts` sees the `task_split` call in the plan and invokes `ctx.split(plan)` (a method injected by the port)

**Tier 2 (kernel):**
2. `packages/kernel/src/execution/dbos-port.ts` `ctx.split` → validates the plan, creates `task_created` events for each child, writes them via `storage.events.append`
3. Writes `split_approved` event marking the split as immediate (no human approval between parent and children)
4. Signal router sees `split_approved` and starts each child via `startRun` on the same DBOS port

**Tier 3 (storage):**
5. Events written to Postgres (canonical history)

**Outcome:** 
- Each child is a new task in `state.tasks`
- Children appear in `vault/index.md` under their parent's tree
- Each child can be `orc run` independently, or they start automatically after parent approval

**How to debug splits:**
- `orc log <parent> --json | grep -E "task_created|split_approved"` to see the split trigger
- `orc status <parent>` shows children under "Splits"
- `vault/index.md` shows the task tree with nesting

---

### Scenario 5: An artifact is produced; its receipt is verified

**Starting point:** A step signals success with `outputs: ["file.txt"]`

**Tier 1 (executor):**
1. `plugins/executor-api-loop/src/index.ts` calls `ctx.signal(success, { outputs: [...] })`

**Tier 2 (kernel execution port):**
2. `packages/kernel/src/execution/dbos-port.ts` `signal` → calls `verifyArtifacts(workspace, outputs)`
   - Resolves each path relative to the workspace
   - Computes SHA-256 of each file's content
   - Records the verification in memory

**Tier 3 (storage):**
3. Writes `artifact_produced` events (one per artifact), each with `{ path, size, hash }`, atomically with `step_completed`

**Outcome:**
- Artifact is recorded with a content hash receipt
- `vault/tasks/<id>/lineage.md` lists all artifacts with their hashes
- Audit trail is complete; a later replay can verify the receipt matches

**How to debug artifact issues:**
- `orc log <task> --json | grep artifact_produced` shows all produced artifacts with their hashes
- `vault/tasks/<id>/lineage.md` shows which step produced each artifact
- Artifact validation failure? Check workspace permissions, symlinks, and file encoding (only UTF-8 for text is captured; binary is size + hash only)

---

## Storage service call paths

The `Storage` facade (described in ARCHITECTURE.md) is the one place Postgres reads/writes happen. Every caller uses one of two interfaces:

### EventLog interface (`storage.events`)

| Method | Effect | Transaction |
|---|---|---|
| `append(eventKind, payload, opts)` | Acquires project lock → jsonb-shape → redact → validate → INSERT → pg_notify → commit | ONE lock-held transaction |
| `subscribe({ fromSeq }, cb)` | Opens PG client, LISTEN, retries on reconnect | No transaction; async callback on each event |
| `all()` | SELECT all events for project, ordered by seq | Read-only, no lock |
| `byTask(taskId)` | SELECT events for one task | Read-only, no lock |
| `countAfter(seq)` | Count events after a given sequence | Read-only, no lock |

### OperationJournal interface (`storage.operations`)

| Method | Effect | Via EventLog |
|---|---|---|
| `begin(spec, idempotencyKey)` | Records `operation_started` in log AND journal table | Appends through `EventLog`, same lock |
| `complete(operationId, result)` | Records `operation_completed` + the result (`agent_call`, `tool_result`, etc.) | Appends through `EventLog` |
| `fail(operationId, error)` | Records `operation_failed` + the error | Appends through `EventLog` |
| `rebuild(events)` | Reconstructs the live journal from the log (used at startup after a crash) | Read-only over events |

### How the lock prevents corruption

A crash **during an append** leaves the project lock held for ~30s (Postgres resets it). Concurrent writers see the lock busy and queue. After timeout, a new writer acquires it and proceeds. Reads bypass the lock entirely and see whatever was last committed.

The journal uses idempotency keys (`DBOS__IDEMPOTENCY_KEY` or a deterministic hash of the operation spec) so a crash during `begin → fn → complete` can safely retry: the second attempt reuses the same journal row, avoiding duplicates.

---

## Memory subsystem interaction

The memory system is **event-first**: the Postgres event log is the source of truth; SurrealDB and vault/memory are disposable projections.

```
Event log (Postgres)
    ↓ (memory_written, memory_deleted, memory_accessed events)
SurrealDB (live notes + edges, project-scoped database)
    ↓ (every note, every link, ranked by hits/updatedAt)
vault/memory/index.md (deterministic markdown rendering)
    ↓ (mermaid graph, notes list)
Human reader / future agent
```

**Degraded mode:** If SurrealDB is down:
- `memory_write` tool returns `memory unavailable`
- Events still append to Postgres (so the data is not lost)
- Search/neighbors/cat tools return `memory unavailable`
- On next CLI startup, the projector reconnects and rebuilds vault/memory from events (this may take a few seconds for a large graph)

**Repair on data loss:** If the Surreal database is corrupted or deleted:
```bash
docker exec orc-surreal surreal remove --namespace default --database orc-<projectId>
orc status <any-task>  # triggers a rebuild
```

---

## Knowledge graph structure

The knowledge graph is a DAG of `MemoryNote` objects, each with:
- `id` — stable identifier (lowercase alphanumeric + hyphens)
- `scope` — namespacing: `"project"` (the default), or a custom scope like `"architecture"`, `"glossary"`
- `kind` — one of `fact`, `decision`, `architecture_current`, `architecture_target`, `documentation`, `plan`, `research`
- `links` — typed edges to other notes: `refines`, `supersedes`, `contradicts`, `depends_on`, `example_of`, `derived_from`, `relates_to`, `decomposes_into`
- `body` — the note content (up to 100 KB)
- `sources` — for `research` kind only, citations with `url` and optional `title`
- `tags` — for filtering and discovery
- `retention` — `durable` (default) or `expirable` (may be swept in future; see `docs/IDEAS.md` entry 1)

**Access pattern:** `memory_search(query, limit, tags, category)` uses full-text search + tag/kind filters; `memory_neighbors(seedId, kinds, depth)` does a graph traversal; `memory_read(id)` fetches one note.

---

## Vault projections — read-only human views

The vault is **deterministic** — same input events produce the same markdown every time. It lives in the workspace at `vault/`:

### `vault/index.md`

The task tree + status for the project:
- Recursive nesting of parent → children (from `split_approved` events)
- Status for each task (from `task_status` in the fold)
- Links to `execution.md` and `lineage.md` for each task
- Last update timestamp

**Rebuild trigger:** any `task_*` or `split_approved` event

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

**Rebuild trigger:** any `artifact_produced` event for this task

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
   Look for `operation_started` without a matching completion.

2. Examine the operation:
   ```bash
   orc log <task> --json | jq '.[] | select(.kind == "operation_started")'
   ```
   Note the `operationId`.

3. Check the operation journal in Postgres (optional, requires direct access):
   ```sql
   SELECT * FROM operations WHERE task_id = '<task-id>' AND id = '<operationId>';
   ```

4. Decide:
   - **If it's a dead provider call:** `orc retry <task>` — DBOS will retry unresolved operations
   - **If the step code is genuinely hung:** kill the `bun run` process and retry (DBOS detects the crash and retries)
   - **If you want to skip it:** a skip mechanism is deferred (entry 3 in `IDEAS.md`); for now, `orc cancel <parent>` and fix the plan

### "Memory says unavailable"

1. Check SurrealDB:
   ```bash
   docker ps | grep surreal  # is it running?
   docker logs orc-surreal  # any errors?
   ```

2. Restart SurrealDB:
   ```bash
   docker restart orc-surreal
   ```

3. The projector will reconnect and rebuild vault/memory on the next CLI command.

4. If SurrealDB lost data, remove the project's database:
   ```bash
   docker exec orc-surreal surreal remove --namespace default --database orc-<projectId>
   orc status <task>  # rebuilds from events
   ```

### "I can't find a note I wrote"

1. Check that it's in the Postgres log:
   ```bash
   orc log <task> --json | jq '.[] | select(.kind == "memory_written")'
   ```
   If it's not there, it was never written — check the task's step output for errors.

2. Check the Surreal cache:
   ```bash
   orc memory ls  # does it show?
   orc memory cat <id>  # full note
   ```
   If not, SurrealDB is stale. Restart and wait for the rebuild.

3. Check vault/memory/index.md — if the graph is not there, the projector hasn't run yet.

### "The task tree is wrong in vault/index.md"

1. Check the `task_created` and `split_approved` events:
   ```bash
   orc log <parent> --json | jq '.[] | select(.kind | match("task_created|split_approved"))'
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

---

## Reference: event kinds involved in each seam

| Seam | Events Written | Events Read | Data-Access Service |
|---|---|---|---|
| Step execution | `operation_started`, `agent_call` / `tool_result`, `operation_completed` | all above (live status) | `EventLog`, `OperationJournal` |
| Plan approval | `feedback_provided`, plan hash stored | `feedback_provided` for gating | `EventLog` |
| Memory write | `memory_written`, `memory_accessed` | all above for projector + search | `EventLog`, Surreal |
| Task split | `task_created`, `split_approved` | same + plan lookup | `EventLog` |
| Artifact receipt | `artifact_produced` | same (for lineage) | `EventLog`, verify via filesystem |
| Vault render | many reads, no writes | above (sink only) | `EventLog` (read-only) |

---

## Performance notes

| Ceiling | Current Impact | Ponytail Comment |
|---|---|---|
| Per-event refold for `ProjectSessions` | O(events) per event — invisible at <1k events | Swap for incremental kernel `applyEvent` when the log gets large |
| index.md graph size (mermaid) | Renders break at ~500 edges; currently ~0 | Will need step 5 from graph-ui plan when notes exceed ~200 |
| Vault projector I/O | One file per projection task; ~1 commit per event | Batches per drain naturally; no issue observed |
| Postgres advisory lock | Global per project, 30s timeout | Only serializes **writers**; reads are always concurrent. High contention (many simultaneous orc runs) may see queue. Raise with `ORC_LOCK_TIMEOUT` (not yet exposed). |

---

## See Also

- `docs/ARCHITECTURE.md` — system map and invariants
- `docs/EXTENDING.md` — how to add a seam
- `vault/memory/index.md` — knowledge graph of architectural decisions
- `docs/IDEAS.md` — deferred improvements with triggers
