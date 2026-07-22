# Architectural Seams Reference Guide

This guide documents the critical architectural boundaries (seams) where data flows between major system components. Each seam enforces specific invariants to maintain durability, project isolation, and observability. This is essential for onboarding, incident response, and reasoning about system behavior under failure.

**Read time: ~30 minutes. Audience: developers, SREs, oncall engineers.**

---

## Quick Navigation

- [System Context](#system-context) — three-tier architecture overview
- [The Five Critical Seams](#the-five-critical-seams)
  1. [Event Log Seam](#1-event-log-seam) — append-only audit trail
  2. [Operation Journal Seam](#2-operation-journal-seam) — before/after durability
  3. [Execution Flow Seam](#3-execution-flow-seam) — durable step workflows
  4. [Memory/Knowledge Seam](#4-memory-knowledge-seam) — raw evidence vs distilled notes
  5. [Feedback & Approval Seam](#5-feedback--approval-seam) — human decisions as durable events
- [Failure Modes & Recovery](#failure-modes--recovery)
- [Testing Guide](#testing-guide)
- [Troubleshooting](#troubleshooting)

---

## System Context

### The Three-Tier Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ ① Application Layer (business logic — never touches DB)        │
│   • kernel.ts (task/plan API, feedback events)                 │
│   • memory gateway (knowledge store/access)                    │
│   • vault-projector (markdown renders)                         │
│   • executor-api-loop (model/tool loop)                        │
│   • signal router (split resolution)                           │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│ ② Data-Access Service Layer (DB mechanics encapsulated)        │
│   • PostgresStore (pool, project lock, redaction, migration)  │
│   • EventLog facade (append/subscribe/query)                  │
│   • OperationJournal facade (begin/complete/fail)             │
│   • SurrealMemory service (knowledge notes & edges)           │
│   • Vault writer (atomic markdown)                            │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────┐
│ ③ Databases & Files (Postgres=truth; others=rebuilds)          │
│   • Postgres (events + operations) ← CANONICAL SOURCE          │
│   • Postgres (DBOS system DB)                                  │
│   • SurrealDB (knowledge read model) ← disposable              │
│   • vault/ directory (markdown) ← disposable                   │
└─────────────────────────────────────────────────────────────────┘
```

**Golden rule:** The Postgres event log is the only truth. Everything else—operations journal, SurrealDB, vault, DBOS system database—is either a rebuilding index or a disposable projection of that log.

---

## The Five Critical Seams

### 1. Event Log Seam

**Location:** `packages/kernel/src/storage/event-log.ts` → Postgres `events` table  
**Direction:** Append-only, single-threaded per project  
**Data:** Typed event payloads (events.ts), redacted at boundary  

#### Data Flow & Format

Every state change is appended to an immutable log. Writes are ordered by a monotonic sequence number and carry a project scope.

```typescript
// Input: EventInput (contracts/execution.ts)
{
  taskId: string | null          // which task triggered this
  stepId: string | null          // which step (during execution)
  runToken: string | null        // which workflow run (DBOS run id)
  kind: EventKind                // one of 25 discriminated event types
  payload: Record<...>           // type-validated per kind
  idempotencyKey?: string        // optional stable key for replay absorption
  usage?: Usage                  // token count + cost (optional, per call)
}

// Output: EventRecord (stored row)
{
  seq: number                    // monotonic per project (starts at 1)
  projectId: string              // from project config
  idempotencyKey: string | null  // null if caller didn't provide one
  ...input fields...
  ts: string                     // ISO 8601 timestamp (UTC)
}
```

#### Invariants Enforced

1. **Append-only:** Once written, an event is never modified or deleted
2. **Monotonic sequence:** `seq` increases by 1 for every append within a project
3. **Project isolation:** Every query filters by `projectId`; two projects cannot read each other's events
4. **Payload validation:** No event is stored unless its payload matches the schema for its kind (Zod validation in `PAYLOAD_SCHEMAS`)
5. **Idempotency (replay absorption):** Same `(projectId, idempotencyKey)` pair → stored once; replayed appends return the original sequence number and fail if payload differs
6. **Atomic transactions:** Each append is a single locked transaction: redact → validate → insert → notify → commit (all or nothing)
7. **No NUL bytes:** Postgres JSONB cannot store `\u0000`; all strings are sanitized at the storage boundary (see redact.ts)

#### Error Handling & Recovery

| Scenario | Handling |
|----------|----------|
| **Connection failure** | `openStorage` fails loudly; no retry at this layer |
| **Schema behind** | `assertMigrated` fails with version count; explicit `orc db migrate` required |
| **Payload validation fails** | Append rejects before insert; transaction rolls back; caller sees the validation error |
| **Same key + different payload** | Duplicate key error with context; caller must reconcile or use a new key |
| **Lock timeout (shouldn't happen)** | Per-project advisory lock should never block >1 sec; if it does, another writer has crashed. Check `orc status` for hung steps |
| **Connection reset mid-append** | Caller sees an error; the lock is released. Idempotency key absorbs the next attempt |

#### Performance Characteristics

- **Append latency:** ~10–50 ms (Postgres + notify overhead), worst-case 100 ms under contention
- **Throughput:** 1–10 appends per second per project (limited by lock contention, not I/O)
- **Ordering:** Guaranteed total order within a project; between projects, concurrent appends are simultaneous
- **Query latency:** ~5–20 ms for `byTask(taskId)` (indexed on `(project_id, task_id)`)
- **Subscription reconnection:** LISTEN/NOTIFY re-established on error; live tail resumes from the last seen sequence

#### Testing Coverage

See `packages/kernel/src/storage.test.ts`:
- **Idempotency:** `idempotency: same key + same input returns the original seq` (line ~200)
- **Isolation:** `isolates projects sharing one database` (line ~240)
- **Atomicity:** `transaction rolls back atomically on error` (line ~150)
- **NUL stripping:** `strips \u0000 from payload strings` (line ~160)
- **Concurrency:** `concurrent transactions serialize per project; unrelated projects stay concurrent` (line ~250)

#### Failure Mode Example

**Scenario:** Step appends `signal_received` with idempotency key `r1:signal:1`, then crashes before confirming write.

```
Attempt 1:
  → append(signal_received, key=r1:signal:1) → seq=42, commit, notify
  → step code crashes before reading the echo
Attempt 2 (recovery):
  → append(signal_received, key=r1:signal:1, same payload) → returns seq=42 (reused)
  → recovery uses the original success flag
```

No double-execution; no duplicate events.

---

### 2. Operation Journal Seam

**Location:** `packages/kernel/src/storage/operation-journal.ts` → Postgres `operations` table  
**Direction:** Before/after durable graph; transitions append through EventLog  
**Data:** OperationSpec (before), results (after), error details  

#### Data Flow & Format

External effects (model calls, tool invocations) are guarded by a durable journal. A node is created **before** the effect and resolved **after** it, leaving an explicit unresolved marker if a crash occurs.

```typescript
// OperationSpec (the "before" node)
{
  operationId: string            // deterministic within the run: 'run:step:attempt:model:1'
  kind: 'model' | 'tool'
  name: string                   // model ref (e.g. 'anthropic/claude-sonnet-5') or tool name
  before: unknown                // the redacted request/input
}

// Operations table row (persistent graph node)
{
  operationId: string
  taskId, stepId, runToken: string
  status: 'started' | 'completed' | 'failed'
  kind: 'model' | 'tool'
  name: string
  attempts: number               // count of begins (ambiguous retries after crash = +1)
  before: unknown                // redacted request
  after: unknown | null          // redacted response (null while started)
  error: unknown | null          // exception details (null while started/completed)
  startedSeq: number             // event log seq of operation_started event
  finishedSeq: number | null     // event log seq of completion/failure (null while started)
  startedAt, finishedAt: string  // ISO 8601 timestamps (UTC)
}

// Transitions (appended to event log inside the same locked transaction as the row update)
{
  kind: 'operation_started'
  payload: OperationStartedPayload
}
// ... (model/tool calls and results from the executor)
{
  kind: 'operation_completed' | 'operation_failed'
  payload: OperationCompletedPayload | OperationFailedPayload
}
```

#### Invariants Enforced

1. **Before-the-effect guarantee:** `operation_started` event is committed to the log BEFORE external code (model call, tool invocation) runs
2. **Deterministic operation IDs:** Same (stepId, attemptIndex, operationIndex) → same operationId (allows reuse detection)
3. **Attempt tracking:** Reuse of an already-started node counts as attempt 2 (explicit ambiguity, not silent failure)
4. **Atomic transitions:** The operation row update AND its event log entry (operation_completed/failed) are in the same transaction—journal and log can never disagree
5. **No drift after completion:** Once status is 'completed' or 'failed', a re-entry to `completeOperation` with the same (operationId, attempt) is idempotent (returns the stored value, not an error)
6. **Stale attempt rejection:** Completion with a higher attempt number than the current row is a terminal error (`isTerminalError = true`); executor must not retry the external effect
7. **Error/result redaction:** Secrets stripped from before, after, and error fields at the storage boundary

#### Error Handling & Recovery

| Scenario | Handling |
|----------|----------|
| **Crash between `beginOperation` and effect** | Node status stays 'started'; next attempt sees the same operationId, increments attempts to 2, re-runs the effect |
| **Crash after effect, before `completeOperation`** | Node status stays 'started'; re-entry returns `{ reused: true, value }` (executor reuses the cached result) |
| **Lost ACK after `completeOperation`** | Executor re-enters with same (operationId, attempt) → idempotent return of the stored result |
| **Concurrent writes to same operationId** | Per-project lock serializes; no race condition possible |
| **Completion with stale attempt** | Terminal error; durable-step wrapper sees it and does NOT retry |

#### Performance Characteristics

- **Begin latency:** ~5–10 ms (Postgres insert + EventLog append)
- **Complete latency:** ~10–20 ms (row update + event append + draft event appends)
- **Journal rebuild:** O(events.count) — scans all events once, groups by operationId, builds final row state
- **Reuse detection:** O(1) lookup by (operationId, attempt) in the operations table

#### Testing Coverage

See `packages/kernel/src/storage.test.ts`:
- **Before-the-effect:** `beginOperation commits a started node and its transition` (line ~520)
- **Completion atomicity:** `completeOperation stores after and appends completion plus drafts atomically` (line ~530)
- **Reuse:** `beginOperation after completion reuses the stored value` (line ~540)
- **Ambiguous retry:** `beginOperation on a still-started node records the ambiguous retry as attempt 2` (line ~550)
- **Stale rejection:** `stale attempt is rejected` (line ~585)
- **Rebuild:** `rebuildOperations reproduces the journal byte-for-byte` (line ~610)

#### Failure Mode Example

**Scenario:** Model call starts, returns a response, executor crashes before calling `completeOperation`.

```
Event log:
  seq=10 operation_started { operationId: 'step:t1:s1:a1:model:1', ... }
  // crash here
  
Operations table (row still exists):
  { operationId: 'step:t1:s1:a1:model:1', status: 'started', attempts: 1, before: {...}, after: null, error: null }

Recovery:
  → beginOperation(same spec) → sees operationId exists, status=started, attempts→2
  → effect runs again (idempotent key in model call absorbs duplicate)
  → completeOperation(attempt: 2) → succeeds, stores after
  → log now has operation_started (seq=10) and operation_started (seq=11) and operation_completed (seq=12)
```

The ambiguity is preserved in the log; tracing code can see both starts and only one completion.

---

### 3. Execution Flow Seam

**Location:** `packages/kernel/src/execution/dbos-port.ts` → DBOS SDK → Postgres DBOS system DB  
**Direction:** Step-by-step durable workflow execution  
**Data:** Checkpoints, signal results, output receipts  

#### Data Flow & Format

The DBOS durable-execution framework coordinates step lifecycle. The `ExecutorContext` provides two checkpoint wrappers:

```typescript
// ExecutorContext from dbos-port.ts
{
  step: PlanStep              // the step spec from the approved plan
  taskSpec: string            // the task description
  depOutputs: Record<...>     // outputs from dependency steps (verified receipts)
  skills: LoadedSkill[]       // environment (skill code + metadata)
  extraTools: ResolvedTool[]  // tools merged from MCP + extensions
  model: LM                   // the language model (from provider)
  runToken: string            // the workflow id (deterministic, DBOS-managed)
  workspaceDir: string        // --cwd for this run
  checkpoint: Checkpoint      // generic checkpointing (name, fn, toEvents)
  operation: OperationCheckpoint  // operation journal wrapper (spec, fn, toEvents)
  budgetRemainingUSD: () => Promise<number | null>
}

// Checkpoint generic form
checkpoint(name, async () => {
  const result = await someExternalCall()
  return result  // stored in DBOS checkpoint + optionally in event log
}, (result) => [
  { kind: 'agent_call', payload: { stepId, runToken, iteration, request, response: result } }
])

// OperationCheckpoint form (before/after journal + log)
operation(
  { operationId, kind: 'model', name: 'anthropic/claude-sonnet-5', before: request },
  async () => { return await model.generateText(...) },
  (result) => [
    { kind: 'agent_call', payload: {...} },
    // possibly: memory_written, artifact_produced, etc.
  ]
)
```

#### Invariants Enforced

1. **Deterministic workflow IDs:** Same (taskId, planVersion, retryIndex) → same workflowId across reruns
2. **Run isolation:** Each workflow run is bound to one task, one plan version, one retryIndex
3. **At-least-once semantics:** Completed checkpoints are reused from DBOS state; unresolved nodes are retried
4. **Step ordering:** Dependency steps must complete (successfully or terminally fail) before dependents start
5. **Output receipt verification:** Declared outputs are verified against workspace (SHA-256 hash computed), then stored atomically with step_completed
6. **Signal absorption:** A step is blocked by a split until `split_resolved` resolves the child task; parent step resumes with the child result
7. **Cost budget enforcement:** Each step is cancelled (terminalError) if the run's remaining budget ≤ 0

#### Error Handling & Recovery

| Scenario | Handling |
|----------|----------|
| **Step crashes mid-execution** | DBOS workflow resumes from the last committed checkpoint |
| **Dependency fails** | Dependent step is never started; the run fails at the plan level (cascading) |
| **Output file missing at signal** | Verification fails; step_failed (validation_error); run terminates |
| **Split child blocked** | Parent step remains suspended in the signal router's queue; no timeout (human-gated) |
| **Budget exceeded mid-step** | terminalError('budget_exceeded'); step fails; run fails |
| **Model/tool failure** | Caught by operation journal; retried according to maxIterations; if exhausted, terminalError |

#### Performance Characteristics

- **Checkpoint latency:** ~20–50 ms (DBOS state persistence + event log append)
- **Step startup:** ~100–500 ms (skill loading, tool resolution, model instantiation)
- **Model loop iteration:** ~500 ms – several seconds (depends on model, tool invocation latency)
- **Output verification:** ~10–50 ms (stat + SHA-256 hash for each declared file)
- **Resume after crash:** Checkpoint replay (sub-second for most steps); effect reuse (idempotent keys in operations)

#### Testing Coverage

See `packages/kernel/src/kernel.test.ts`, `packages/kernel/src/replay.test.ts`:
- **Checkpoint reuse:** (see DBOS SDK tests; not duplicated in orc tests)
- **Output receipt:** verified atomically with step_completed
- **Signal routing:** resolveAllSplits() awaits child task completion
- **Step failure cascade:** parent run fails if dependency fails

#### Failure Mode Example

**Scenario:** Step signals success with outputs, executor crashes before reading the receipt verification.

```
Operations table & Event log:
  seq=50 step_started { stepId: 's1', runToken: 'step:t1:s1:a1', attempt: 1 }
  seq=51–100 agent_call, tool_call, tool_result × N
  seq=101 signal_received { outcome: 'success', outputs: ['build/app.js'] }
  // crash here (before verifying outputs)

Recovery:
  → DBOS resumes from the last checkpoint (the signal)
  → verifyArtifacts(workspace, ['build/app.js']) runs again
  → if file exists + hash matches: step_completed with receipt, run continues
  → if file missing: step_failed(validation_error), run terminates
```

No double-output declaration; idempotent replay.

---

### 4. Memory/Knowledge Seam

**Location:** `plugins/memory/src/` → SurrealDB (project-scoped database)  
**Direction:** Event-first writing; read-only knowledge graph queries  
**Data:** Notes (typed kinds), edges (typed relationships), citations (URLs)  

#### Data Flow & Format

Raw evidence (from the event log: model calls, tool results, fetched pages) flows into an event-first write path. A memory note is written **only** if an agent decides to distill a finding into the knowledge graph.

```typescript
// Memory write flow (from memory gateway)
// 1. Agent calls memory_write tool
// 2. Tool records a memory_written event (in EventLog)
// 3. Projector reads the event, distills it to Surreal note
// 4. vault/memory/index.md re-renders from the graph

// MemoryWrittenPayload (event log)
{
  note: {
    id: string                  // stable slug for the note
    title: string
    kind: 'fact' | 'decision' | 'architecture_current' | 'architecture_target' | 'documentation' | 'plan' | 'research'
    body?: string               // markdown; optional for indexed notes
    summary?: string            // one-line summary
    categories?: string[]       // topic grouping
    tags?: string[]             // fine-grained search
    links?: Array<{             // typed edges to related notes
      id: string                // target note id
      kind?: 'refines' | 'supersedes' | 'contradicts' | 'depends_on' | 'example_of' | 'derived_from' | 'relates_to' | 'decomposes_into'
      confidence?: number       // 0.0–1.0
    }>
    sources?: Array<{ url: string; title?: string }>  // citations (URLs only, for research kind)
    paths?: string[]            // code references (e.g. 'packages/kernel/src/storage/event-log.ts:100–200')
    retention?: 'durable' | 'expirable'  // sweep policy
  }
  author: { source: 'cli' | 'agent'; ref?: string }  // who wrote it
  gitRevision?: string          // commit hash (stamped by gateway)
}

// SurrealDB row (knowledge graph)
{
  id: string                    // note id
  type: string                  // note kind (discriminator)
  // All fields from the note (flattened for indexing)
  projectId: string
  createdAt: string
  updatedAt: string
  hits: number                  // access count (from memory_accessed events)
  lastAccessedAt?: string       // timestamp of last read
}

// Relationship row (edge in the graph)
{
  from: string                  // source note id
  to: string                    // target note id
  kind: string                  // edge kind (refines, derives_from, etc.)
  confidence: number            // optional weight
}

// MemoryAccessedPayload (event log, when a note is actually read)
{
  noteId: string
  accessKind: 'memory_read' | 'memory_neighbors' | 'memory_cat'  // which tool accessed it
}
```

#### Invariants Enforced

1. **Event-first writes:** A note is never stored directly to Surreal; only via memory_written events (preserves lineage)
2. **Project isolation:** SurrealDB database name is derived from (projectDbName, projectId); native query-time isolation
3. **Raw evidence in audit trail:** Model calls, tool results, fetched pages stay in the event log (redacted once at the boundary) and never reach vault/memory
4. **Research citation requirement:** A note with kind='research' MUST have at least one source URL; no unsourced claims
5. **Retrieved-at stamped by system:** Memory_written event contains a note; the projector stamps `retrievedAt` from the event timestamp (not supplied by the writer)
6. **Graph coherence:** All edge targets must be valid note IDs (no dangling references); invalid links fail at write time
7. **Access is measurement, not policy:** `memory_accessed` events record fact; no expiration or ranking happens on the counter
8. **Vault rebuild from events:** vault/memory/\*\* is deterministic; deleting vault/memory/ and rebuilding yields the same output

#### Error Handling & Recovery

| Scenario | Handling |
|----------|----------|
| **SurrealDB unavailable** | Event is appended to log (succeeds); projector skips this note on the next rebuild. On restart, it re-processes all memory_written events from the log |
| **Citation missing in research note** | memory_write tool rejects the request (validation error); note is not stored |
| **Dangling edge reference** | memory_write tool rejects (referential integrity); caller must fix the target note ID or create the target first |
| **Duplicate note ID (same id, different note)** | Surreal upsert updates the existing note; old version overwritten. For immutable notes, use unique IDs (e.g. with timestamp) |
| **Vault/memory/ corrupted** | Delete the directory; next re-render produces a clean vault/memory/ from the event log. The graph is preserved in Surreal (and rebuilds if Surreal is wiped) |
| **Network partition to Surreal** | Degraded-memory mode: memory tools return errors, but execution continues. The event log is unaffected |

#### Performance Characteristics

- **Note write latency:** ~30–100 ms (Surreal upsert + event log append)
- **Edge write latency:** ~5–20 ms per edge (Surreal inserts)
- **Graph query latency:** 
  - `memory_read(id)`: ~5 ms (single-row lookup)
  - `memory_neighbors(seed)`: ~50–200 ms (BFS with depth limit; 1–5 hops)
  - `memory_search(query)`: ~100–500 ms (full-text search + ranking)
- **Vault rebuild:** O(memory_written events count); ~1 sec per 1000 events
- **SurrealDB recovery:** On restart, replay all memory_written events; O(event count)

#### Testing Coverage

See `plugins/memory/src/` test files (if present):
- **Event-first flow:** writes to EventLog, then projects to Surreal
- **Citation validation:** research kind rejects missing sources
- **Edge validation:** links to non-existent notes fail
- **Degraded mode:** tool returns error when Surreal is down

#### Failure Mode Example

**Scenario:** Agent writes a research note citing a fetched URL, then Surreal crashes before the note is indexed.

```
Event log:
  seq=200 memory_written { note: { id: 'postgres-vs-mysql', kind: 'research', sources: [{url: 'https://example.com/...'}] }, author: { source: 'agent' } }
  
SurrealDB (before crash):
  // note row started to insert but connection reset

Recovery:
  → Surreal restarts
  → Memory projector reads from log starting at the last applied seq
  → Processes seq=200 memory_written event again
  → Inserts the note row (idempotent)
  → vault/memory/ re-renders
```

No data loss; deterministic rebuild.

---

### 5. Feedback & Approval Seam

**Location:** `packages/kernel/src/kernel.ts` (feedback API) → EventLog → signal router  
**Direction:** Human/policy decisions become durable events; then routed to waiting steps  
**Data:** Approval/denial decisions, plan-graph SHA-256, feedback replies  

#### Data Flow & Format

When a step or workflow awaits human input (approvals, plan annotations, feedback), the event is persisted first, then routed asynchronously. This ensures decisions survive a crash between append and delivery.

```typescript
// FeedbackRequestedPayload (waiting step asks for input)
{
  stepId: string
  runToken: string
  topic: string                 // "plan_approval", "feedback_request", "plan_annotation"
  question: string              // human-readable prompt
  gateOn?: SplitResult[]       // (optional) splits to await before asking
}

// FeedbackProvidedPayload (human reply)
{
  feedbackId: string            // from feedback_requested (idempotency)
  reply: z.union([
    z.object({ kind: z.literal('approve'), planSha: z.string() }),  // plan hash for finalize_plan
    z.object({ kind: z.literal('deny'), reason: z.string() }),
    z.object({ kind: z.literal('annotate'), targetNote: z.string(), update: {...} }),
    z.object({ kind: z.literal('respond'), text: z.string() }),  // for ask_human
  ])
  approvedAt: string
  approvedBy: 'human' | 'policy'
  ruleIndex?: number            // which ApprovalPolicy matched
}

// Storage: feedback_requested & feedback_provided events in EventLog
// Delivery: signal-router picks up feedback_provided, matches to waiting step, unblocks

// PlanAnnotatedPayload (human edits an approved plan's note)
{
  targetNote: string            // which ADR/note to edit
  update: {                     // what changed
    title?: string
    body?: string
    links?: Array<{ id, kind?, confidence? }>
  }
  approvedAt: string
  approvedBy: 'human' | 'policy'
}
```

#### Invariants Enforced

1. **Feedback is append-only:** A decision is never retracted; amendments are new events
2. **Plan approval is hash-bound:** The approval event carries SHA-256(plan graph at approval time); `finalize_plan` recomputes and rejects if they differ
3. **Idempotency on retry:** Same feedback ID + same reply payload → returns the original event seq (deduped on reapply)
4. **Approval must come from the approval request:** feedback_provided references the feedbackId from feedback_requested; orphan feedback is rejected
5. **Policy-based auto-approval:** If an ApprovalPolicy rule matches, the event carries `approvedBy: 'policy'` and auto-approves without waiting
6. **Live + startup delivery:** The signal router delivers feedback to running steps (live) and to still-waiting tasks on startup (healing a crash after append but before send)
7. **Durable outbox pattern:** Events are written first; router retries delivery (exponential backoff in DBOS) until the step receives it

#### Error Handling & Recovery

| Scenario | Handling |
|----------|----------|
| **Plan edited after approval** | finalize_plan compares current plan hash to approval; mismatch returns an error. Human must re-approve |
| **Feedback arrives before split_resolved** | Feedback is queued; step resumes only after the split is resolved (gateOn condition) |
| **Step crashes after feedback delivered** | Step resumes from the last checkpoint; feedback is re-read from the log (idempotent) |
| **Router crashes before sending feedback** | Signal router replays on startup, re-sends all unacknowledged feedback |
| **Duplicate feedback submitted** | Same feedbackId + same payload → idempotent return; different payload → rejected (ambiguity) |
| **Timeout waiting for approval** | No timeout at the system level; step remains blocked until human responds (or task is cancelled) |

#### Performance Characteristics

- **Request write latency:** ~5–10 ms (EventLog append only, not delivered yet)
- **Approval write latency:** ~10–20 ms (EventLog append + router notification)
- **Delivery latency:** ~0–100 ms (live) or ~1–10 sec (on startup, if many pending)
- **Plan hash computation:** ~50–200 ms (depends on plan graph size; cached between finalize_plan calls)

#### Testing Coverage

See `packages/kernel/src/kernel.test.ts`:
- **Hash-bound approval:** finalize_plan verifies plan SHA-256 matches approval
- **Idempotency:** Replaying the same feedback ID + payload re-enters safely
- **Policy auto-approval:** ApprovalPolicy rules evaluated at request time, auto-approves if matched

#### Failure Mode Example

**Scenario:** Human approves a plan, the approval event is written, but the step crashes before routing the approval.

```
Event log:
  seq=30 feedback_requested { feedbackId: 'f:t1:plan', stepId: 's1', runToken: 'step:t1:s1:a1', question: 'Approve plan?' }
  seq=31 feedback_provided { feedbackId: 'f:t1:plan', reply: { kind: 'approve', planSha: 'abc...' }, approvedAt: T, approvedBy: 'human' }
  // crash here (before router sends signal_received to the step)

Recovery:
  → Signal router starts
  → Scans for unresolved feedback_provided events
  → Finds seq=31, routes it to step 's1'
  → step_started is appended
  → execution resumes from the last checkpoint (plan was not finalized yet, so it re-runs finalize_plan)
```

No lost approval; durable outbox ensures delivery.

---

## Failure Modes & Recovery

### Common Failure Patterns

#### 1. Unresolved Operation Node

**What:** Operation status is 'started' but has not progressed for >10 seconds.

**Diagnosis:**
```bash
# In vault/tasks/<task-id>/execution.md or via orc status
orc replay <task-id> --at <seq>   # Look for operation_started with no matching completion/failure
```

**Likely cause:** External service (model API, tool server) hung; executor crashed between the effect and completion.

**Recovery:**
- If the effect is idempotent (operation journal confirms reuse), retry the step: `orc retry <task-id>`
- If the effect is not idempotent, check the external service (model provider, tool server logs) to confirm the call succeeded
- If the external call succeeded but result is lost, manually record a completion:
  - Reconstruct the result (from tool/model logs)
  - Create a new step with the reconstructed output (no need to re-run the external effect)

#### 2. Hung Split (Parent Waiting for Child)

**What:** Parent step remains in step_started (not moving to step_completed) for hours.

**Diagnosis:**
```bash
orc status <parent-task-id>          # Look for pending splits
# In vault/tasks/<parent-task-id>/execution.md:
#   split_proposed { childTaskId: 'child-123' }
#   (no split_resolved event)
orc status <child-task-id>           # Check child progress
```

**Likely cause:** Child task is blocked on approval, or crashed with an error.

**Recovery:**
- Unblock the child: `orc approve <child-task-id>` or `orc run <child-task-id>`
- If the child has an unrecoverable error: `orc cancel <child-task-id>`, then parent will receive `outcome: 'cancelled'`

#### 3. Stale Step Attempt

**What:** Executor tries to complete an operation with a higher attempt number than exists in the journal.

**Diagnosis:**
```bash
# In event log or vault execution.md
orc log <task-id> --json | grep -A 5 'operation_started'
# If you see multiple operation_started events for the same operationId with different attempts,
# the last one succeeded and a higher attempt is invalid
```

**Likely cause:** Executor lost track of attempt number due to a crash; attempted to retry an already-completed effect.

**Recovery:**
- DBOS recovery is automatic (checkpoints reused, stale attempts rejected)
- No action needed; the rejection is by design (prevents duplicate external effects)

#### 4. Vault Rebuild Latency Spike

**What:** vault/memory/ or vault/tasks/ takes >30 sec to re-render.

**Diagnosis:**
```bash
# Monitor logs for vault-projector activity
# Check event log size
orc log <task-id> --json | wc -l
# Large counts = slow rebuild
```

**Likely cause:** Many memory_written events or large task expansion (deep recursion).

**Recovery:**
- This is expected for large projects; rebuild is deterministic and safe to interrupt
- If rebuild stalls (not just slow), restart the projector: `docker compose restart orc-vault` (or equivalent)
- Vault/ is a projection; loss of a stale vault/ file is not data loss

#### 5. Project Isolation Violation (Saw Another Project's Data)

**What:** A query or log returned events from the wrong projectId.

**Diagnosis:**
```bash
# Confirm your project ID
cat .orc/config.json | jq .projectId
# Check if the event log has multiple projectIds
orc log <task-id> --json | jq '.projectId' | sort | uniq
```

**Likely cause:** This should never happen; if observed, it is a bug in the query layer.

**Recovery:**
- Report as a security issue (data isolation breach)
- Verify the config.json is not corrupted; `orc init` was run only once
- Wipe and reinitialize if suspicion persists: `rm .orc/trust.json && orc init --name <project>`

---

## Testing Guide

### Testing a Custom Seam (Example: Adding a New Event Kind)

1. **Add the event kind and schema** (contracts/events.ts):
   ```typescript
   export const EventKind = z.enum([..., 'new_event_kind'])
   export const PAYLOAD_SCHEMAS = {
     ...,
     new_event_kind: z.object({ /* schema */ }),
   }
   ```

2. **Write to the log** (in your component):
   ```typescript
   await events.append({
     taskId, stepId, runToken,
     kind: 'new_event_kind',
     payload: { /* validated */ },
     idempotencyKey: 'stable-key-if-retryable',
   })
   ```

3. **Test idempotency** (add to storage.test.ts):
   ```typescript
   it('new_event_kind: idempotent replay', async () => {
     const log = await freshLog()
     const first = await log.append({
       kind: 'new_event_kind',
       payload: { /* test payload */ },
       idempotencyKey: 'test:1',
     })
     const replay = await log.append({
       kind: 'new_event_kind',
       payload: { /* same payload */ },
       idempotencyKey: 'test:1',
     })
     expect(replay.seq).toBe(first.seq)
     await log.close()
   })
   ```

4. **Test project isolation** (add to storage.test.ts):
   ```typescript
   it('new_event_kind: respects project isolation', async () => {
     const db = await createTestDb()
     const p1 = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
     const p2 = (await openStorage(db.url, { projectId: 'other-project' })).events
     await p1.append({ kind: 'new_event_kind', payload: { /* ... */ } })
     await p2.append({ kind: 'new_event_kind', payload: { /* ... */ } })
     expect((await p1.all()).filter(e => e.kind === 'new_event_kind')).toHaveLength(1)
     expect((await p2.all()).filter(e => e.kind === 'new_event_kind')).toHaveLength(1)
   })
   ```

---

## Troubleshooting

### Reference: Quick Diagnostics

| Symptom | Diagnostic Command | Likely Seam |
|---------|-------------------|-------------|
| "Unresolved operation" in status | `orc replay <task-id>` → find operation_started with no completion | Operation Journal |
| "Outputs could not be verified" | `ls -la <declared-file>` → check file existence | Execution Flow |
| Memory tool returns error | `orc status` → check SurrealDB connection | Memory/Knowledge |
| "plan hash mismatch" on approve | `orc log <task-id> --json \| grep -i plan` → confirm no edits between request and approval | Feedback & Approval |
| Multiple projectIds in query | `cat .orc/config.json \| jq .projectId` | Event Log (isolation) |

### Reference: Common Command Patterns

```bash
# Audit a task's entire event history
orc log <task-id> --json | jq '.[] | {seq, kind, payload}'

# Replay at a specific event
orc replay <task-id> --at <seq>

# View execution trace (operation journal + events)
cat vault/tasks/<task-id>/execution.md

# Check project isolation
orc log <task-id> --json | jq '.projectId' | sort | uniq -c

# Manually verify an output receipt
sha256sum <file>
# Compare to vault/tasks/<task-id>/lineage.md
```

---

## Links

- **Architecture Overview:** [docs/ARCHITECTURE.md](../ARCHITECTURE.md)
- **Data Contracts:** `packages/contracts/src/` (events.ts, operations.ts, execution.ts, memory.ts)
- **Storage Implementation:** `packages/kernel/src/storage/` (event-log.ts, operation-journal.ts, postgres.ts)
- **Durable Execution:** `packages/kernel/src/execution/dbos-port.ts`
- **Memory Plugin:** `plugins/memory/src/`
- **Tests:** `packages/kernel/src/*.test.ts`, `packages/kernel/src/storage.test.ts`
- **Operational Guide:** [README.md](../../README.md) "Operational notes" section
