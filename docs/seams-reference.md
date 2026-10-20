# Seams Reference Guide: component interactions and debugging

This guide maps the component interactions described in [`ARCHITECTURE.md`](ARCHITECTURE.md) to concrete call
paths, data flows and debugging strategies. Use it to understand how parts of the system communicate and to
diagnose issues.

Tier numbers below are ARCHITECTURE.md's three tiers, not a call depth: **①** application (CLI, kernel,
knowledge-core, plugins: never touches a store directly), **②** data-access services (`openStorage`, the
knowledge backend `openKnowledge` resolves, the vault writer), **③** the stores themselves (Postgres, the git
working tree, `vault/`). The kernel is tier ①; it takes an `EventLog`, not a pool.

## Call paths by scenario

### Scenario 1: A step executes and calls a model

**Starting point:** a user calls `orc run <task>`

A client never starts a run. It **records the ask** and watches the stream; the supervisor turns that ask into a
workflow. This is what lets a run outlive the terminal that asked for it.

**Tier ① (application: CLI):**
1. `packages/cli/src/exec-commands.ts`'s `run` command calls `OrcActions.run` (`packages/cli/src/actions.ts`),
   which checks the cwd, refuses a task no run can serve (`assertDrivable`: the same admission `startRunAt`
   enforces), makes sure a supervisor is up, and calls `kernel.requestRun(taskId, { cwd })`. That appends
   `run_requested` and returns its seq; there is no `kernel.startRun`. The CLI then tails the log from that seq;
   `ctrl-c` ends the watch, not the run

**Tier ① (application: supervisor):**
2. `packages/kernel/src/execution/signal-router.ts` sees `run_requested` over `LISTEN/NOTIFY` and calls the port's
   `startRunAt`, which starts the run workflow under the deterministic id `run:<taskId>:v<planVersion>`
   (`:r<n>` on retry). `port.launch()` is the boot-time `DBOS.launch()`, not a per-run call
3. The run workflow launches each dependency **wave** of ready steps and awaits the wave whole, then recomputes
   readiness: DBOS binds child handles positionally, so launch order must be a pure function of
   `(plan, done, failed)`
4. `packages/kernel/src/execution/dbos-port.ts` runs each step as its own workflow
   (`step:<taskId>:<stepId>:a<attempt>`) and hands the injected executor a `ctx` carrying `checkpoint`,
   `operation` and `knowledge`

**Tier ① (application: executor plugin):**
5. `plugins/executor-api-loop/` iterates: `ctx.checkpoint('preload', () => knowledge.preload(budget, round))`
   before the first prompt (so a replay reuses the recorded claims), then model and tool calls, each wrapped in
   `ctx.operation(spec, fn)`, until `signal(success)` or a terminal error

**Tier ② (data-access service):**
6. `ctx.operation` → `OperationJournal.beginOperation` records `operation_started` *before* the external
   call, then `completeOperation` commits `operation_completed` plus the drafted `agent_call` / `tool_result` in
   ONE locked transaction (see "Storage service call paths" below)

**Outcome:** events in Postgres: `run_requested`, `run_started`, `step_started`, a `knowledge_delivered` for the
preload when it handed claims over, then per call `operation_started`, `agent_call` / `tool_result`,
`operation_completed` (or `operation_failed`)

**How to trace:**
- `orc log <task> --json` shows every event of the task in order
- `orc status <task>` shows the execution breakdown: steps, their operations, operation status
- `orc replay <task> --at <seq>` freezes the state at any event sequence

---

### Scenario 2: A plan is approved by a human

There are **two** approval gates and they write different events. Confusing them is the usual reason a grep here
comes back empty.

**Gate A: `orc approve <taskId>`, the ordinary plan gate. No hash.**

**Tier ① (application: kernel):**
1. `packages/kernel/src/kernel.ts` `approvePlan(taskId, version?)` requires status `awaiting_approval`, and
   rejects a stale `--version` with `version_conflict`
2. In ONE transaction it appends `plan_approved` (`approvedBy: human | policy | mcp`) and
   `task_status_changed → approved`. It does NOT append `feedback_provided` and computes no plan hash

**Tier ① (application: signal router):**
3. `packages/kernel/src/execution/signal-router.ts` sees `plan_approved` for a task with a pending split and calls
   `port.startChildRun(childTaskId)`. Approving only *unblocks* a child; something still has to execute it, which
   is why `OrcActions.approve` makes sure a supervisor is up before it appends the approval that supervisor has
   to react to

**Gate B: `orc reply <taskId> approve`, the grounded-plan gate. This one is bound to a point in the log.**

4. `kernel.replyFeedback` answers the open `feedback_requested`. When the task is `grounded` and the reply is
   exactly `approve` on the plan step, it stamps `planHash` (`planGraphHash(planNotesOf(...))`, SHA-256 over the
   task's canonical plan notes) onto the `feedback_provided` payload. That hash is the audit record of what was
   approved, and the marker `approvedPlanHash` uses to tell a plan approval from any other `approve`; the gate
   itself does not compare it. Its value is reproducible only by the build that stamped it, so it attests *that
   an approval happened over some graph*, never *that it was this graph*: do not compare it against a freshly
   computed one
5. The plan-authoring agent then calls `finalize_plan`, which locates the approval with
   `kernel.approvedPlanHash(taskId, runToken)` (only an approval from a door in `groundedApprovalDoors` counts)
   and refuses the freeze when `kernel.planNotesChangedSince(taskId, approvedSeq)` is non-empty (any
   `plan_note_written` on the task after the approval), *naming the ids*, so the agent learns which edit cost it
   the gate instead of only that something moved. That is equivalent to "the notes are unchanged", since
   `planNotesOf` reads exactly those events, and unlike comparing two content hashes it cannot disagree with
   itself when the approving process and the executor are different builds. A missing, cross-run or stale
   approval fails before any child split

**How to debug approval issues:**
- Ordinary gate: `orc log <task> --json | jq '.[] | select(.kind == "plan_approved")'`, then check `approvedBy`
- Grounded gate: `orc log <task> --json | jq '.[] | select(.kind == "feedback_provided") | .payload.planHash'`
- `cannot approve while task is '<status>'` means the task is not at `awaiting_approval`: check
  `orc status <task>`
- `the plan notes changed after approval` from `finalize_plan`: the notes it names moved between the human's
  `approve` and the freeze. Re-approve, then call `finalize_plan` without editing in between

---

### Scenario 3: A step records a claim; the next reader sees it

**Starting point:** a running step calls `knowledge_write` (`orc knowledge add` and `retire` take the same path
with a CLI author, and `knowledge_check` with a `false` verdict writes its patch the same way)

**Tier ① (application: knowledge-core):**
1. `packages/knowledge-core/src/tools.ts`'s `knowledge_write` parses the patch (`add`, `change`, `retire`, a
   required `why`, an optional `decision`) and calls `port.write` with the step's author and the idempotency key
   `<runToken>:tool:<toolCallId>:knowledge`
2. `packages/knowledge-core/src/port.ts`'s `write` gives each unnamed addition an id derived from that key, so a
   retried call writes the same claims, and reads the claims a change restates (new text or anchors) before it
   hands the patch to the backend

**Tier ② (data-access service: the git-files backend):**
3. `plugins/knowledge-git/src/backend.ts`'s `write` refuses a decision this checkout does not hold, canonicalizes
   symbol anchors against the file's outline (an unknown symbol is refused with the closest names), snapshots
   the checkout's buckets (`git ls-files`, each bucket parsed once per content hash), and plans the write: which
   bucket each claim belongs in, by its first anchor
4. It takes the lock of every bucket file the write touches, re-snapshots, re-plans, and writes each bucket
   atomically in canonical form, removing a bucket that ends up empty. A writer that raced it makes it re-plan, up
   to five attempts. A bucket with a line it cannot read refuses the write

**Tier ① again (application: the port records the evidence):**
5. The port reads each added or restated claim's anchors right after the write and appends `knowledge_written`
   with the refs added, changed and retired, the files touched, the `why`, and the asserted digests. A failed
   append leaves the files written and returns `evidence not recorded: <reason>` among the warnings

**Outcome:**
- The bucket file is changed in the step's checkout, uncommitted; its diff is part of the task's changes
- `knowledge_written` is in the log, in the task's stream
- The next `knowledge_card`, `knowledge_search` or preload in that checkout reads the claim from the file, as
  `clean`: an uncommitted line's basis is the working tree, and the asserted digests match it
- Once committed, the claim's basis is that commit, and its state follows its anchors' code from there

**How to debug knowledge writes:**
- `orc knowledge card <path>` lists the claims at or under a path; `orc knowledge search <query>` ranks them
- `git diff -- '*/knowledge/*'` shows what a task wrote before it is committed; `git log -p -- <bucket>` shows a
  claim's history, retirements included
- `orc log <task> --json | jq '.[] | select(.kind == "knowledge_written") | .payload'` shows each write's refs,
  `why` and assertions
- `orc knowledge check` prints `<file>:<line>  <problem>` for anything a later write would refuse

---

### Scenario 4: A task splits into children

**Starting point:** a running step calls the `task_split` tool

**Tier ① (application: executor):**
1. The model emits a `task_split` tool call; the loop executes it like any other resolved tool. There is no
   `ctx.split`: the tool is `packages/kernel/src/execution/split-tool.ts` (`ref: kernel/task_split`), handed to
   the step by the port. It is withheld from a scout (`ANALYZE_STEP_ROLE`): a scout orients, it does not
   decompose

**Tier ① (application: kernel):**
2. `split-tool.ts` `execute` → `kernel.proposeSplit(...)`, keyed by the provider's real `toolCallId`, so a
   checkpoint replay reuses the same `splitId` instead of splitting twice
3. `packages/kernel/src/kernel.ts` `proposeSplit` → in ONE transaction: `task_created` for the child,
   `split_proposed` on the PARENT's stream, then `plan_proposed` for the child's expanded plan. There is no
   split-approval event: no such name is in `EventKind`
4. Whether the child is gated is the project's `approvalPolicy`: an auto-approving rule appends `plan_approved`
   (`approvedBy: policy`) in that same transaction; otherwise the child parks at the human gate
5. `packages/kernel/src/execution/signal-router.ts` sees `plan_approved` for a task with a pending split and calls
   `port.startChildRun(childTaskId)`, idempotently, and again at startup for an approved child whose run never
   started
6. When the child reaches a terminal status the router composes the join payload (outcome, summary, and the
   claims the child's subtree recorded and did not retire) and appends `split_resolved`, which is what unblocks
   the parent's `join_splits`

**Tier ② (data-access service):**
7. Events written to Postgres (canonical history)

**Outcome:**
- Each child is a new task in `state.tasks`
- Children appear in the vault's task-expansion graph under their parent
- Each child can be `orc run` independently, or it starts automatically once approved

**How to debug splits:**
- `orc log <parent> --json | grep -E "task_created|split_proposed|plan_approved|split_resolved"` shows the split
  trigger, its approval and its join
- A split that never starts is almost always a gated child: `orc status <parent>` prints
  `awaiting approval: <title>  (orc approve <childTaskId>)` for each one
- A parent stuck in `step_started` for hours with a `split_proposed` and no `split_resolved` is waiting on a child
  that will never finish. There is no timeout: the gate is human. If the child is unrecoverable,
  `orc cancel <childTaskId>`: the router composes the join from any TERMINAL child status, so the parent's
  `join_splits` unblocks with `outcome: 'cancelled'` instead of hanging. Cancelling the *parent* strands nothing
  but tells you nothing either

---

### Scenario 5: An artifact is produced; its receipt is verified

**Starting point:** a step signals success with `outputs: ["file.txt"]`

**Tier ① (application: executor):**
1. `plugins/executor-api-loop/src/loop.ts` calls `ctx.signal(success, { outputs: [...] })`

**Tier ① (application: kernel execution port):**
2. `packages/kernel/src/execution/dbos-port.ts`'s trusted `finish` checkpoint (never agent- or tool-controlled
   code) calls `verifyArtifacts(workspace, outputs)` (`packages/kernel/src/execution/artifacts.ts`)
   - `validateOutputPaths` enforces workspace containment, regular-file-ness, and no duplicates
   - it reads each file's bytes *itself* and computes SHA-256 and byte size. The agent supplies paths; it never
     supplies a hash

**Tier ② (data-access service):**
3. Writes `artifact_produced` events (one per artifact), each `{ path, sha256, size }`, keyed
   `<runToken>:artifact:<path>`, in the SAME transaction as `step_completed`, so a completed step can never be
   missing its receipts, and vice versa
4. If that transaction already landed before a crash, verification is skipped rather than re-hashing a workspace
   that may have changed since: re-verifying could flip a durably-recorded success into a failure

**Outcome:**
- The artifact is recorded with a content-hash receipt
- The task's lineage page in the vault (`tasks/<id>/lineage.md`) shows which step produced each artifact, with a
  hash prefix
- The audit trail is complete; a later replay can check the receipt

**How to debug artifact issues:**
- `orc log <task> --json | grep artifact_produced` shows every produced artifact with its full hash
- `orc status <task>` prints one `out` line per artifact: step, path, hash prefix and size
- To check a receipt by hand: `sha256sum <path>` and compare it against the event. A mismatch means the workspace
  changed *after* the step completed: the receipt is not wrong, the file is no longer the one that was signed

---

## Storage service call paths

The `Storage` facade (described in ARCHITECTURE.md) is the one place Postgres reads and writes happen. Every
caller uses one of two interfaces:

### EventLog interface (`storage.events`)

| Method | Effect | Transaction |
|---|---|---|
| `append(input)` | ONE `EventInput` object (`{ kind, payload, taskId, stepId, runToken, chatId, door, usage?, idempotencyKey? }`), typed as a discriminated union over `kind` so the compiler holds `payload` to the schema that kind names. Acquires the project lock → parses the envelope → jsonb-shapes → redacts → validates the *redacted* payload → INSERT `ON CONFLICT DO NOTHING` → pg_notify → commit. Validation runs on the redacted payload so a zod error can never quote a secret back | ONE lock-held transaction |
| ⮑ on conflict | A key that already committed is **not** silently absorbed. The stored row is re-read and returned only if its envelope, payload and usage are all deep-equal; anything else throws `idempotency_conflict` (`idempotency key '<k>' reused with different event data`). A replay that absorbed a *changed* payload would rewrite history under the cover of a retry | — |
| ⮑ payload shaping | The jsonb round-trip drops `undefined`-valued keys before the redact-and-compare, so a byte-identical keyed replay still compares equal; `\u0000` is stripped from every string because Postgres jsonb cannot store it. A tool result carrying binary comes back NUL-free: that is the storage boundary, not a bug in the tool | — |
| `transaction(fn)` | Runs `fn(tx)` under one project lock; every read and append inside is atomic. This is how a read that decides a write stays safe | ONE lock-held transaction |
| `subscribe({ fromSeq }, cb)` | Opens a PG client, LISTENs, retries on reconnect. NOTIFY is only a wake-up: the authoritative read is a catch-up `WHERE seq > cursor`, and the cursor advances only after the handler resolves. A log that no longer reaches the cursor rewinds it to 0 and calls `onReset` | No transaction; async callback per event |
| `all()` | SELECT all events for the project, ordered by seq | Read-only, no lock |
| `byTask(taskId)` / `byTaskSince(taskId, afterSeq)` | SELECT events for one task | Read-only, no lock |
| `after(seq, kinds?)` | SELECT events after a sequence, optionally filtered by kind: how the vault projector and the knowledge evidence reader catch up | Read-only, no lock |
| `earliestSeq()` | Oldest surviving seq, so a cached reader can detect a TRUNCATED log (purge, delete chat), which no event announces | Read-only, no lock |

### OperationJournal interface (`storage.operations`)

| Method | Effect | Via EventLog |
|---|---|---|
| `beginOperation(context, spec)` | Records `operation_started` in the log AND the journal table, keyed `<operationId>:<attempt>:started`. An already-`completed` node is reused (`{ reused: true }`) and the effect never re-runs | Appends through `EventLog`, same lock |
| `completeOperation(context, spec, attempt, value, drafts)` | Records `operation_completed` plus the drafted result events (`agent_call`, `tool_result`, …). The same attempt already completed is a no-op re-entry; a *stale* attempt throws `terminalError` | Appends through `EventLog`, one transaction |
| `failOperation(context, spec, attempt, error)` | Records `operation_failed`: a deliberate no-op if the node is already `completed`, so a straggling failure can never regress a success | Appends through `EventLog` |
| `operationsFor(taskId)` | Reads the durable nodes for one task (what `orc status` prints) | Read-only |
| `rebuildOperations()` | Deletes the project's rows and refolds them from the log via the same `applyOperationEvent` the live path uses | Read-only over events |

### How the lock prevents corruption

The lock is `pg_advisory_xact_lock`, which is **transaction-scoped**: it is released the instant the transaction
ends (commit, rollback, or the backend dying with it). So a crash during an append does not strand it, and there
is no timeout to wait out. Concurrent writers block on `pg_advisory_xact_lock` until the holder's transaction
ends, then proceed. Reads bypass the lock entirely and see whatever was last committed.

The journal keys every transition by the operation id the executor supplies (deterministic per run, e.g.
`<runToken>:model:<iteration>`) and the attempt (`<operationId>:<attempt>:started`, `:completed`, `:failed`), so a
crash during `begin → fn → complete` can safely retry: a completed node is reused and its effect never re-runs,
and an unresolved one is re-attempted under the next attempt number.

---

## Knowledge subsystem interaction

The knowledge files are the truth about the code; the event log holds the evidence about them.

```
step tool / orc knowledge / orc adr / MCP read tools
    ↓ KnowledgePort (packages/knowledge-core/src/port.ts): parse, resolve the checkout
KnowledgeBackend (plugins/knowledge-git): read and write the files, under per-bucket locks
    ↓
git working tree: <package>/knowledge/*.md buckets, docs/decisions/*.md
    ↑ readings: the git-blame basis of each claim line, anchor digests at the basis and now
KnowledgePort appends knowledge_delivered · knowledge_written · knowledge_checked
    ↓ (event log, read back incrementally by createEvidenceReader)
foldEvidence → driftOf → claim state: clean · suspect · unknown · unanchored
```

**Degraded modes:**
- **Knowledge off** (`"knowledge": null` in `.orc/config.json`): every knowledge tool is still offered and
  answers `knowledge unavailable: knowledge is off for this project (…)`; preload hands over nothing.
- **Knowledge unavailable** (an unknown plugin, invalid options): the supervisor warns once at boot and runs on.
  The tools answer `knowledge unavailable: <reason>`, `scoped_changes` returns `citingClaims: null` with a
  `degraded` line, and `git_commit` returns `stillDrifted: null` with a `degraded` line. No step depends on
  knowledge to run.
- **Event log unreachable**: `orc knowledge card`, `search`, `fmt` and `check` read the files and still work;
  `drift` reads states from git blame alone and prints a note saying so; `add`, `retire`, `verify` and `stats`
  need the log and fail.
- **An evidence append fails**: the write or check still lands in the files and returns
  `evidence not recorded: <reason>`; the claim's state then rests on its git-blame basis until the next write or
  check records evidence.

**Repair:** the files are in git, so a bad write shows in `git diff` and is undone like any other change.
`orc knowledge fmt` restores canonical form, assigns missing ids and refiles misplaced claims; `orc knowledge check`
exits 1 and names every remaining problem by file and line. A purged or reset log loses only evidence: every claim
survives and falls back to its basis.

The format of a bucket and a decision file, and the rule for each claim state, are in
[knowledge-files.md](knowledge-files.md).

---

## Vault projections: read-only human views

The vault is **deterministic**: the same events produce the same markdown every time. It lives at `vaultDir`
(default `vault/` in the main checkout). `vault/skills/` beside it is authored source, not a projection.

| File | Content | Rebuilt |
|---|---|---|
| `index.md` (at the vault root) | the task-expansion graph (which task created which child, with live status), the active runs, and every task | on any task's re-render; it folds only `task_created` + `task_status_changed` and never scans the whole log |
| `tasks/<id>/index.md` | the task's spec, its step graph, links to the files below, and a per-step usage table | on any event carrying the task's id, coalesced to one render per task per 50 ms |
| `tasks/<id>/log.md` | the task's events, newest first | same |
| `tasks/<id>/execution.md` | the step graph with each operation node, its status and attempts; unresolved operations are drawn dashed | same |
| `tasks/<id>/lineage.md` | each artifact with path, hash prefix and size, under the step that produced it | same |
| `tasks/<id>/plan-v<n>.md` | each plan version | written once, never overwritten |
| `tasks/<id>/sessions/<stepId>.md` | the step's model turns, tool calls, results and signal | same as the task index |

`renderTaskFiles` writes all of a task's files from one pass over `log.byTask(taskId)`, so they can never disagree
about a run. A projection file edited by hand is overwritten with a warning; a plan file is never overwritten.

---

## Debugging workflows

### "My step is stuck in 'running' state"

1. Check unresolved operations:
   ```bash
   orc status <task>
   ```
   Look for `operation_started` without a matching completion. The `op` lines print `attempts N`:
   **`attempts` above 1 on a still-`started` node is the ambiguity marker, not noise.** It means a previous
   process committed `operation_started`, then died before `operation_completed`, so the external effect *may
   already have run*. The journal records that rather than hiding it, which is the whole point of writing the
   start before the call.

2. Examine the operation:
   ```bash
   orc log <task> --json | jq '.[] | select(.kind == "operation_started")'
   ```
   Note the `operationId`. Two `operation_started` events sharing one `operationId` with a single completion is
   the same story read from the log side.

3. Check the operation journal in Postgres (optional, requires direct access):
   ```sql
   -- rows are project-scoped, and the key is (project_id, operation_id); there is no `id` column
   SELECT * FROM operations
    WHERE project_id = '<project-id>' AND task_id = '<task-id>' AND operation_id = '<operationId>';
   ```

4. Decide:
   - **If it is a dead provider call:** `orc retry <task>`; DBOS retries unresolved operations
   - **If the step code is genuinely hung:** stop the supervisor (`orc serve stop` sends it SIGTERM) and start
     it again (`orc serve`); DBOS recovery resumes the run and re-attempts the unresolved node as a new attempt
   - **If you want to skip it:** there is no skip mechanism: `orc cancel <parent>`, fix the plan, and re-run

### "Knowledge unavailable"

The tool error is `knowledge unavailable: <reason>`, and `orc status <task>` prints the same line where it
otherwise prints `knowledge: <n> claims · <m> suspect`.

1. `knowledge is off for this project` means `.orc/config.json` sets `"knowledge": null`. Remove it, or set
   `"knowledge": { "plugin": "git-files" }`.
2. `knowledge: unknown plugin '<id>'` names a plugin the CLI does not ship; the known ids are listed after it.
3. An options error names the field: the git-files backend takes `dirName`, `manifests` and `decisionsDir`, and
   refuses a `decisionsDir` inside a knowledge folder.
4. `the git-files backend needs a git checkout` (the error of a tool call, and the reason the health line
   gives) means the checkout is not a git repository, or git is not on PATH.

### "A claim reads suspect"

1. List what is not clean, with the anchors that moved:
   ```bash
   orc knowledge drift            # or: orc knowledge drift <path>…  /  --json
   ```
   Each line is `state  id  bucket  anchor…`, followed by the count per state.
2. Read the code at those anchors. A claim is suspect when its anchored code changed since the claim's line was
   last committed (or since a write asserted or a check confirmed it), or when the anchored file, folder or
   symbol is gone.
3. Settle it:
   ```bash
   orc knowledge verify <id> holds --why "<what you read>"                # still true: clears it
   orc knowledge verify <id> false --text "<corrected>" --why "<…>"       # reworded under the same id
   orc knowledge verify <id> false --retire --why "<…>"                   # no longer true
   ```
   Or let the commit reactor draft a sweep, and approve it.
4. A claim whose id appears twice in the checkout has no line blame can attribute, so it reads suspect until the
   duplicate is removed; `orc knowledge check` names it.

### "`orc knowledge check` fails"

Each line is `<file>:<line>  <problem>`. `missing id`, `not in canonical form`, `belongs in '<bucket>'` and a
short-form symbol are fixed by `orc knowledge fmt`. A duplicated id, an unknown symbol (the closest names are
listed), a missing anchor, an unknown decision or a line that does not parse need a person; see the table in
[knowledge-files.md](knowledge-files.md#the-commands).

### "The task tree is wrong in the vault"

1. Check the `task_created` and `split_proposed` events:
   ```bash
   orc log <parent> --json | jq '.[] | select(.kind | test("task_created|split_proposed"))'
   ```

2. Re-render from the log:
   ```bash
   orc vault render            # every task, then the root index
   orc vault render <taskId>   # one task
   ```
   The running supervisor re-renders on each event; a vault written while no supervisor ran catches up when the
   next one starts, which renders every task once.

### "The step stopped mid-loop and the provider reported nothing"

Look for a `step_failed` whose class is `budget_exceeded`, message `budget exhausted before iteration <n>`. The
loop checks the remaining budget *before* each model call, so an exhausted step dies without a provider error to
point at: there is nothing wrong upstream to find.

```bash
orc log <task> --json | jq '.[] | select(.kind == "step_failed") | .payload'
orc status <task>   # the per-step usage lines show the spend that got you here
```

The envelope is the **tightest** remaining budget over the whole ancestor chain: for each ancestor that set one,
`budgetUSD − subtreeUsage(ancestor)`, minimised. That is why a child with its own generous `--budget` still stops:
an ancestor's cap binds it. Enforcing at the spend point across ancestors is what stops N sibling splits, each
handed the full remaining budget before any of them spends, from together overrunning the parent. Raise the cap
on the *binding* ancestor, not the leaf.

### "Every command fails before it does anything"

```
database schema is behind (3/5 migrations applied) (checked localhost:5433/orc) — run 'orc db migrate'
```

`assertMigrated` reads drizzle's bookkeeping table on every `openStorage` and refuses to run against a database
it does not recognise. The host is printed with the password stripped, so the message is safe to paste into an
issue. Migration is never implicit and never automatic on startup:

```bash
orc db migrate
```

`orc db migrate` (like `orc init`) runs before Postgres, plugins and identity are wired up, so it still works when
nothing else does.

---

## Reference: event kinds involved in each seam

| Seam | Events written | Events read | Data-access service |
|---|---|---|---|
| Step execution | `operation_started`, `agent_call` / `tool_result`, `operation_completed` | all above (live status) | `EventLog`, `OperationJournal` |
| Plan approval (ordinary) | `plan_approved`, `task_status_changed` | `plan_approved` for routing | `EventLog` |
| Plan approval (grounded) | `feedback_provided` carrying `planHash` | `feedback_provided` for the approval and its seq, then the task's `plan_note_written` after it for `finalize_plan`'s gate | `EventLog` |
| Plan authoring (grounded) | `plan_note_written` (the full merged note; envelope = the task, plus the writing step and run) | the task's `plan_note_written`, folded by `planNotesOf` for the freeze, the approval hash and the plan pane | `EventLog` |
| Knowledge write | `knowledge_written`: refs added, changed and retired, files, `why`, decision, and the asserted anchor digests; also for each recorded decision | the same, folded into claim evidence, a task's writes (`listTaskKnowledgeWrites`) and a split's join | knowledge backend, `EventLog` |
| Knowledge check | `knowledge_checked`: the verdict, the claim's text, the anchors' digests, `why` | the same, folded into claim evidence (a `holds` confirms those digests) | knowledge backend, `EventLog` |
| Knowledge read | `knowledge_delivered`: the ids a card, search, get, at-risk push or step preload actually handed over, `mode` naming which; a step's preload appends one, after its budget cut | the same, folded into claim evidence and `orc knowledge stats` | knowledge backend, `EventLog` |
| Commit outside orc | `commit_recorded` (from the post-commit hook) | the auto-heal reactor, via the signal router | `EventLog` |
| Task split | `task_created`, `split_proposed`, `plan_proposed`, then `plan_approved` (policy or human) and `split_resolved` on join | the same, plus the plan lookup | `EventLog` |
| Artifact receipt | `artifact_produced` | the same (for lineage) | `EventLog`, verified via the filesystem |
| Vault render | many reads, no writes | the above (sink only) | `EventLog` (read-only) |

---

## Performance notes

| Ceiling | Current impact | Upgrade path |
|---|---|---|
| Graph rebuild per event in `ProjectSessions` | Each event folds into the held state with `foldInto`; the whole graph is then rebuilt and diffed, O(graph) per event. A full refold happens only when the log is truncated or replaced | patch the graph per event when the rebuild measurably slows |
| Postgres advisory lock | Per project, transaction-scoped, no timeout: a writer waits as long as the holder's transaction runs | It serializes **writers** only; reads are always concurrent. The upgrade is a finer-grained lock, not a longer wait. The pool is capped at `max: 4` for the same reason: extra connections cannot buy write throughput past one lock |
| Knowledge snapshot per call | Every backend read or write of claims lists the checkout's buckets with `git ls-files`; a bucket is re-parsed only when its content hash changes | cache the listing per git index state when a large repository makes it slow |
| Drift readings | One `git blame` per bucket a read touches, and one digest per anchor at its basis and now; git objects are memoized per process | cache readings by bucket and anchor object ids when a full read measurably slows |

---

## See also

- [`ARCHITECTURE.md`](ARCHITECTURE.md): system map and invariants
- [`knowledge-files.md`](knowledge-files.md): the knowledge-file format and the claim states
- [`EXTENDING.md`](EXTENDING.md): how to add a seam
- [`IDEAS.md`](IDEAS.md): deferred improvements with triggers
