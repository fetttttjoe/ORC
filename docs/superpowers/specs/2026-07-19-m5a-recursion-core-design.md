# M5a — Recursion Core Design

**Goal (R1, ADR-009, ADR-010):** a running step proposes a child split; the child becomes an
ordinary gated task with its own plan; the parent's turn durably pauses at a join and resumes
with a thin result — outcome + summary + note handles — then pulls detail by traversing the M4c
memory graph instead of re-holding the child's context. Recursion happens *through the graph*
(M4c spec §8), and every node of the tree has the same lifecycle as a top-level task.

M5 is decomposed: **M5a recursion core** (this spec) → M5b strategies (CoordinationStrategy,
TypedEdge, slots, presets) → M5c isolation + claude-code adapter (worktree sandbox, zones,
second executor). This spec was adversarially challenged against the full docs corpus
(28 challenges, 18 refuted); every surviving challenge is folded in as a decision below.

## 1. Decisions

- **D1 — Fork-and-join mid-turn.** The parent step blocks durably at `join_splits` and resumes
  in the same turn, Claude Code semantics: the report-back is thin, the knowledge lives in the
  graph. Fork-and-exit is expressible for free (propose splits, end the turn, a later step
  re-traverses) but the primitive is the mid-run gate — the `waitForSignal` ADR-004 deferred to M5.
- **D2 — One split = one child task + one child plan.** Parallelism lives inside the child plan
  as steps (the DAG interpreter already runs ready steps concurrently); several subtrees =
  several `task_split` calls. One approval gate per split, exactly ADR-009.
- **D3 — The proposing agent authors the child plan.** The split proposal carries a trimmed
  `ChildPlanDraft`; the parent has the working context (same reason Claude Code's parent writes
  subagent prompts). ApprovalPolicy gates it; default stays "every split gates".
- **D4 — Event-log bridge, children are first-class tasks.** Child creation/planning/approval/
  execution reuse `task_created` (with `parentId`), `plan_proposed`, `plan_approved`,
  `run_started`, `task_status_changed` unchanged. A **SignalRouter** in the port — one
  `EventLog.subscribe` consumer, the same infra projectors use — watches child-terminal events,
  appends `split_resolved`, and `DBOS.send`s it to the parent's workflow. Per-child retry/
  cancel/replay work unchanged because a child *is* a task. At-least-once send; recv dedups by
  `splitId`. The log stays the only truth — the router is derived signaling, and the join is
  itself an event (replayable, R9).
- **D5 — Thin join payload, graph pointers.** `split_resolved` carries `outcome` (the existing
  `RunOutcome` enum — `done | blocked | cancelled`, NOT `SignalOutcome`: blocked-via-
  maxIterations, harness failure, and cancel have no final signal), a deterministically derived
  `summary`, and `notes: {id, scope}[]` — scope-qualified because a note's key is `(id, scope)`
  (`memory_deleted` carries both for the same reason) and private-per-run scopes are a reserved
  M4b path. Parent pulls detail via `memory_read`/`memory_neighbors` seeded from `notes`.
- **D6 — Deterministic ids (M2 harness discipline: nothing minted inside a crash window).**
  `task_split` executes inside a tools checkpoint; a crash after append before commit re-executes
  it. Random ids would mint a duplicate subtree. So: `splitId` derives from
  `(runToken, toolCallId)`, `childTaskId` derives from `(parentTaskId, stepId, toolCallId)`
  (attempt-independent; the collision guard in `proposeSplit` covers cross-attempt reuse) — re-execution
  re-appends byte-identical events and the fold absorbs them idempotently.
- **D7 — Depth-partitioned queues.** A gate-waiting parent holds its DBOS queue slot (any
  PENDING workflow counts toward the concurrency cap). With today's single `agents` queue
  (global concurrency, default 3), three waiting parents starve the very children they wait on —
  guaranteed deadlock. Queues are partitioned by tree depth: `agents:<d>` (steps) and `runs:<d>`
  (child runs), `d = 0..maxDepth`, registered at port init (maxDepth default 3 ⇒ a fixed
  handful). A parent at depth *d* never competes with its depth-*d+1* descendants. Child runs
  enqueue (backpressure for splits-heavy trees); top-level `startRun` stays direct.
- **D8 — Subtree budget accounting (risk #6: "budget caps inherited down the tree").** A
  per-child clamp against parent-remaining amplifies N× per split (N^depth for wide trees).
  The fold gains subtree-aware usage (sum a task's usage plus descendants' via `parentId`);
  **both** the executor's `budgetRemainingUSD` and the `task_split` clamp use it. Child
  `budgetUSD` = min(requested, subtree-remaining).
- **D9 — `task_split` is a stepTool; `join_splits` is an api-loop builtin.** `task_split` is an
  ordinary non-blocking `ResolvedTool` on the existing `stepTools` seam. `join_splits` cannot
  be: `DBOS.recv` is illegal inside a checkpoint, so suspension requires the generator to yield —
  only a loop builtin can (the `signal` builtin is the exact precedent). The api-loop handles
  `join_splits` by yielding a `gate` event; the port resumes it with results.

## 2. Contracts

New event kinds (shapes are forever; challenged for M5b/M5c forward-compat):

```ts
split_proposed: z.object({
  splitId: z.string().min(1),           // derived: (runToken, toolCallId) — D6
  taskId: z.string().min(1),            // parent task
  stepId: z.string().min(1),
  runToken: z.string().min(1),          // parent step workflow id = send target
  childTaskId: z.string().min(1),       // derived: (parentTaskId, stepId, toolCallId) — D6
})
split_resolved: z.object({
  splitId: z.string().min(1),
  childTaskId: z.string().min(1),
  outcome: RunOutcome,                  // done | blocked | cancelled — D5
  summary: z.string(),                  // derivation pinned below
  notes: z.array(z.object({ id: z.string(), scope: z.string() })),  // D5
})
```

`summary` derivation (deterministic per path): `done` → joined `step_completed` summaries of the
child plan's terminal steps (steps no other step depends on); `blocked` → the failing step's
`step_failed` message; `cancelled` → `'cancelled'`. `notes` = the `(id, scope)` of every
`memory_written` whose `author.taskId` belongs to the child subtree, deduped, in write order.

`plan_approved` payload gains **approval provenance** (extended now, before the first
auto-approval ever fires — v0.0.1 hard directive, no back-compat):

```ts
plan_approved: z.object({
  taskId, version, approvedAt,          // unchanged
  approvedBy: z.enum(['human', 'policy']),
  ruleIndex: z.number().int().nonnegative().optional(),  // which policy rule matched
})
```

**ApprovalPolicy** (config, zod; threshold fields only, no expression DSL):

```ts
ApprovalRule = z.object({
  maxDepth: z.number().int().positive().optional(),
  maxCostUSD: z.number().positive().optional(),
  type: z.string().optional(),          // matches TaskNode.type
  then: z.enum(['auto', 'manual']),
})
ApprovalPolicy = z.object({
  default: z.enum(['manual', 'auto']).default('manual'),
  rules: z.array(ApprovalRule).default([]),
})
```

First matching rule wins; evaluated once at propose time. A rule matches only if **every**
present field matches. **A null `costEstimateUSD` never matches a `maxCostUSD` rule** (treated
as unbounded → falls through; with an all-rules miss, `default` applies). Default overall:
`manual` — every split gates, safe-by-default, cheap-to-relax (ADR-009).

**`task_split` tool** (stepTools seam, house pi-tool conventions: parse at the boundary,
advertised JSON schema mirrors the zod parser, every failure `{isError: true}` — never throw):

```ts
input:  { title, spec, plan: ChildPlanDraft, budgetUSD? }
ChildPlanDraft = { steps: { title, role, instructions, dependsOn?, skillRefs?, toolRefs? }[] }
        // executorRef/modelRef inherited from the parent step; refs validated at propose
        // via the existing ref validator, same as a top-level PlanDraft
output: { splitId, childTaskId, gated: boolean }   // non-blocking — returns immediately
errors (isError): depth >= maxDepth (config, default 3); subtree budget exhausted;
        ref-validation failure; malformed draft
```

The tool description pins the graph convention (no runtime-stamped link kind — the substrate
closes authored-and-pulled, M4c §8): *"include the seed note ids in `spec`; the child should
`memory_write` its findings linked to those seeds (`refines`/`derived_from`); `split_resolved.
notes` are your `memory_neighbors` seeds after the join."*

**`join_splits` builtin** (api-loop, like `signal`): input `{ splitIds?: string[] }` (default:
all unresolved splits of this step). `UnifiedEvent` gains
`{ type: 'gate', splitIds: string[], toolCallId: string }`.

## 3. Mechanics

**Gate flow.** Model calls `join_splits` → the loop yields `gate` instead of executing a tool →
the port's workflow loop (upgraded from `for await` to two-way `generator.next(value)`
iteration) is in workflow context, where `recv` is legal: it `DBOS.recv`s on topic
`split:<splitId>` per pending split (dedup by splitId; results checkpointed) → pushes the array
of thin results back into the generator → the loop appends `tool_call`/`tool_result` for the
gate's `toolCallId` in its own checkpoint and hands the results to the model as the tool result.
The turn continues with in-memory context intact. Crash mid-wait: DBOS replays the workflow,
checkpointed LLM/tool steps return cached, the generator re-runs to the same gate yield, `recv`
replays deterministically from DBOS's message log. No new persistence machinery.

**SignalRouter** (port-level). One log subscriber; routes are `(match(event) → topic, payload)`
registrations. M5a registers one route: task-terminal `task_status_changed` for a task with a
pending `split_proposed` → compose the thin result from the log (summary + subtree notes) →
append `split_resolved` → `DBOS.send(parent runToken, result, 'split:<splitId>')`. M5b's
bounded feedback rounds register new routes on the same seam — additive, no shape change.

**Queues.** `agents:<d>`/`runs:<d>` for `d = 0..maxDepth`, each with the configured
concurrency. A task's depth is `TaskNode.depth` (already in the contract). Auto-approved child
runs enqueue on `runs:<depth>`; manual ones sit `awaiting_approval` until `orc plan approve`,
then enqueue.

**Split lifecycle events** (all reused except the two new kinds):
`task_split` → `task_created`(child, parentId, depth+1, clamped budget) + `plan_proposed`(child)
+ `split_proposed` → policy: `plan_approved`(approvedBy:'policy') + enqueue child run, or park.
Child runs as a normal task. Terminal → router: `split_resolved` + send. Parent gate returns.

## 4. Error handling

- **A split never wedges the parent.** Child failure/block/cancel still *resolves* the split
  (outcome + summary); the parent agent decides — re-split, work around, or fail its own step.
- **Cancel cascades down.** `cancelRun(parent)` walks the tree via fold-state `parentId`,
  cancels child runs depth-first; the router resolves their splits as `cancelled`.
- **Runaway recursion:** depth cap + subtree-budget clamp enforced in `task_split` (isError,
  not crash). Bounded queue widths are the concurrency backstop.
- **No gate timeout in v1.** A manually-gated child waits for the human indefinitely, same as
  a top-level plan today; cancel is the escape hatch.
- **Orphaned splits on parent retry:** a new attempt (new runToken) re-proposes with new
  deterministic ids; prior children remain real tasks — visible in the tree, cancellable.
  Accepted for v1 (parent-agent- and human-resolvable; the log shows exactly what happened).

## 5. Testing

- Contracts: the two new payload schemas; ApprovalPolicy (first-match, every-field-matches,
  null-cost-never-matches, default-manual); `plan_approved` provenance.
- Pure: policy evaluation unit test; summary derivation; deterministic id derivation
  (same inputs ⇒ same ids).
- Port unit: two-way generator iteration with a scripted executor (gate yield → resume value
  becomes the tool result); recv dedup by splitId.
- Integration (extends the memory-reuse e2e harness): parent proposes split → policy
  auto-approves → child writes a linked note + completes → parent's gate returns
  `{outcome:'done', notes:[…]}` → parent `memory_read`s the child's note — the full
  recursive-MAS loop. A second test: manual gate parks the child `awaiting_approval`;
  kernel approve unblocks; and a depth-1 parent gate does not starve depth-2 children
  (queue partition proof at concurrency 1).

## 6. Deferred (restated so nothing re-adds them)

- CoordinationStrategy/TypedEdge/slots + presets, bounded feedback rounds → M5b (router seam
  + `strategyRef` field already reserved).
- Zone enforcement, worktree/docker sandbox, claude-code adapter → M5c. The `gate` UnifiedEvent
  is executor-agnostic by construction (any executor may yield it; only the api-loop does in M5a).
- Push/auto-binding of context slices, context manifests, confidence provenance,
  weights-as-config, vectors/RRF, BM25 → unchanged from M4c's deferred list.
- Gate timeouts, orphan auto-reaping, per-rule policy audit UI → when a real need shows.

## 7. Self-review

RG coverage: R1 splits ✓ (D2/D3), R2 policy per depth/cost/type ✓ (D8 rules; provenance
recorded), R9 replay ✓ (join is an event; deterministic ids; router derived from log),
R6 graph reuse ✓ (D5 thin payload + authored-seed convention), risk #6 cost blowout ✓
(D7 queues + D8 subtree budget). Absorbed-lesson check: bottega typed completion → RunOutcome
enum ✓; pi tool contract → house conventions pinned ✓; claude-obsidian single-writer → router
appends via the same single EventLog, no second writer ✓; RecursiveMAS vocabulary (topologies,
rounds) stays M5b, no shape here blocks it ✓.
