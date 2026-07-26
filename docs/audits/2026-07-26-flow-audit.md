# End-to-end flow audit — 2026-07-26

> **Status: resolved.** Every finding below was addressed; see "Resolution" at the end for what
> changed, and for the two items deliberately left alone with reasons. Kept as the record of why
> the code looks the way it does.


Scope: every first-party package and plugin, read end to end. Judged against the stated vision:
a **self-creating knowledge graph built while agents work**, used to (a) plan and handle tasks,
(b) answer project questions instead of re-reading files, (c) launch work in parallel.

Part 1 is the codebase map (docs input). Part 2 is the findings, ranked.

---

## Part 1 — Codebase map

### 1.1 Packages, by what they own

| Module | Lines | Owns | Talks to |
|---|---|---|---|
| `packages/contracts` | ~2.4k | Zod schemas, event kinds + payloads, tier'd note model, executor/port/store interfaces, workspace guard, memory folds, activation math | nothing (leaf) |
| `packages/kernel/storage` | ~750 | The one Postgres owner: pool, per-project advisory lock, redaction, `EventLog` (append/subscribe/query), `OperationJournal`, migrations, supervisor heartbeats, runtime lock | Postgres |
| `packages/kernel` (core) | ~1.1k | `fold(events) → State`, task/plan lifecycle, feedback outbox, plan-hash approval, cancel-subtree, budget derivation | storage |
| `packages/kernel/execution` | ~1.3k | DBOS port (run/step workflows, checkpoints, operation journal, gates, queues), signal router, grounded-plan strategy, `task_split` / `finalize_plan` / `exec` / `read_annotations` / `report_coverage` tools | storage, contracts, DBOS |
| `packages/kernel/plugins` | ~450 | Plugin registry + propose-time ref validation, fingerprint trust store, SKILL.md index + watcher, T2 extension loading | filesystem |
| `plugins/executor-api-loop` | ~760 | The model⇄tool loop: prompt assembly, knowledge preload, tool dispatch, suspension points (join/ask), signal handling, ambient capture, write-claim fence | contracts, providers, ctx (port) |
| `plugins/provider-*` | ~350 | anthropic / openai / ollama model + embedding providers, cost tables, OAuth | AI SDK |
| `plugins/mcp-client` | ~250 | T1 MCP server hub, trust-gated spawn, net guard, search backends | MCP servers |
| `plugins/memory` | ~1.6k | Event-first note store (gateway), Surreal projection + edge materialization, memory tools, ranking/RRF/activation, budget fitting, drift probe, sweep, consolidation, lifecycle subscriber, vault memory render | EventLog, SurrealDB, vault |
| `packages/vault-projector` | ~370 | Deterministic markdown/mermaid renders of tasks, execution, lineage; coalesced live re-render | EventLog, filesystem |
| `packages/ui-core` | ~900 | Transport-free UI core: `ProjectSessions` (live fold + graph patches + transcripts + log rows), `OrcActions` interface, copilot toolset | storage |
| `packages/graph-ui` | ~2.0k | Door #1: HTTP/SSE adapter + browser page (sigma renderer, plan editor, conversation, chat) | ui-core |
| `packages/cli` | ~2.7k | Bootstrap, command surface, project discovery, supervisor spawn/claim, shared `OrcActions` impl, MCP stdio door | everything |

### 1.2 The four flows

**A. Grounded task → executable plan**

```
orc new --strategy grounded-plan
  └─ kernel.createGroundedTask        → task_created, plan_proposed[analyze,plan], plan_approved(policy)
  └─ kernel.requestRun                → run_requested
       └─ supervisor signal router    → port.startRunAt → orcRun workflow
            ├─ wave 1: analyze step   (scout role → memory_search/read/write, report_coverage)
            └─ wave 2: plan step      (auditor role → full memory surface + ask_human + finalize_plan)
                 ├─ authors plan-tier notes in scope `plan:<taskId>`
                 ├─ ask_human → feedback_requested → DBOS.recv park
                 ├─ orc reply "approve" → feedback_provided (+ planHash) → router → DBOS.send
                 └─ finalize_plan
                      ├─ kernel.listPlanNotes   (fold memory events → plan-tier notes)
                      ├─ planGraphHash == approved hash?
                      ├─ instantiateFrozenPlan  (masterplan decomposes_into → steps)
                      └─ kernel.proposeSplit    → child task_created + plan_proposed + auto plan_approved
                           └─ router route 2    → port.startChildRun → child orcRun
```

**B. Step execution (durable)**

```
orcStep workflow
  ├─ checkpoint 'init'      → step_started, skill_loaded
  ├─ tool resolution        (MCP hub + stepTools: memory ×4, split, annotations, coverage, exec, finalize)
  ├─ executor.startTurn(ctx)
  │    ├─ preloadKnownContext → ctx.checkpoint('preload') → memory_search ×1..3 → prompt block
  │    └─ per iteration:
  │         ├─ ctx.checkpoint(`budget:${i}`)   → remainingBudget(fold(log.all()))   ← full-log scan
  │         ├─ ctx.operation(model)            → operation_started, agent_call, operation_completed
  │         ├─ ctx.operation(tool) per call    → operation_started, tool_call, tool_result, operation_completed
  │         ├─ join_splits  → yield gate       → port DBOS.recv(`split:<id>`)
  │         ├─ ask_human    → yield feedback   → feedback_requested + DBOS.recv(`feedback:<topic>`)
  │         └─ signal       → checkpoint       → signal_received → captureAmbientNote
  └─ checkpoint 'finish'    → groundedPlanOmission guard, verifyArtifacts, artifact_produced*, step_completed
```

**C. Memory write → read model → retrieval**

```
memory_write tool
  └─ store.write   (INSIDE project advisory lock)
       ├─ foldLiveNotes(all memory events)   ← full memory-history fold, per write
       ├─ merge-on-omit against folded base
       └─ append memory_written
  ⇒ projector (subscribe) → SurrealMemory.applyEvent  (one tx: note row + edge re-materialize + cursor)
       └─ writeMemoryFile(vault/memory/**) + index.md refresh
  ⇒ retrieval:
       memory_search  → hybrid (cosine scan ⊕ keyword substring) → RRF fuse → activation boost
       memory_read    → Surreal row → drift probe → budget fit → recordAccess(memory_accessed)
       memory_neighbors → all in-scope link rows → rankNeighbors → activation boost → recordAccess(seed)
```

**D. Command → supervisor → run**

```
orc <verb>  →  ensureRuntime()
                 ├─ liveSupervisors(storage)  (heartbeat rows, 30s trust)
                 ├─ none → spawnSupervisor()  (detached `orc serve`, waits 15s for first beat)
                 └─ --no-daemon → buildRuntime() in-process
               → kernel.requestRun / replyFeedback / approvePlan / cancelSubtree   (append only)
               → watchSubtree()  (LISTEN/NOTIFY stream, settles on stopped-subtree or park)
```

### 1.3 Stores

| Store | Truth? | Written by | Rebuildable |
|---|---|---|---|
| Postgres `events` | **yes** | `EventLog.append` only | — |
| Postgres `operations` | index | `OperationJournal` (through EventLog, same lock) | `rebuild()` |
| Postgres `supervisors` | ephemeral | heartbeat | n/a |
| DBOS system DB (per project) | engine state | DBOS SDK | recovery |
| SurrealDB (db per project) | read model | memory projector | `orc memory rebuild` |
| `vault/**` | human projection | vault-projector + memory projector | `orc vault render` |

---

## Part 2 — Findings

Ranked by how much they cost the vision.

### F1 — The whole-log refold is the system's structural tax  ⛔ critical

`fold()` is pure and total, which is right for replay. But nothing caches it, so **every question
costs a full table read plus a full fold.** In the hot path:

| Site | Frequency | Cost |
|---|---|---|
| `dbos-port.ts:289` `budgetRemainingUSD` | **once per model iteration, per step** | `log.all()` — every row, every jsonb payload (agent_call message deltas, tool_result bodies) |
| `serve.ts:23` `hasLiveWork` | **every 5 s, forever, while idle** | `log.all()` + fold, to answer one boolean |
| `signal-router.ts:235,251` | per routed event | refetch + refold router-kind history |
| `store.ts:29` | per note write, **inside the project write lock** | folds the entire memory history |
| `kernel.state()` | `watchSubtree` per status/split event, `rootOf`, `assertDrivable`, `cancelSubtree`, `gatedChildren`, `openFeedbackInSubtree` | full refold each |
| `sessions.ts:132` | per event, per open project | refold + rebuild graph + diff |
| `consolidate.ts:71,82,94` | 3 scans per consolidation | task_created, memory_accessed, task_status_changed separately |
| `lifecycle.ts:63` | per supervisor boot | every finished task rescanned |

`budgetRemainingUSD` is the worst: it runs **even when no task in the tree sets a budget**
(`remainingBudget` returns `null` after scanning everything). A step doing 30 iterations reads the
entire project history 30 times.

`hasLiveWork` is the second worst: an idle project with a supervisor up reads its whole log
17,280 times a day.

**Why this specifically hurts the vision:** the pitch is "ask the graph instead of re-reading the
project". The runtime does the opposite of that to itself — it re-reads its whole history per model
call, so the orchestrator gets slower in proportion to how much it has learned. That is backwards.

**Fix shape:** one incremental `State` per project, maintained off the log subscription, shared by
the port, the router, the supervisor and `ProjectSessions`. `sessions.ts:99` already carries the
exact ponytail note for this — the shape exists, it just lives in the UI package instead of the
kernel. Separately, `budgetRemainingUSD` should short-circuit to `null` with one indexed query when
no ancestor sets `budgetUSD`.

---

### F2 — Preload is invisible to the learning loop  ⛔ critical (vision)

`preloadKnownContext` (loop.ts) runs `memory_search` and renders the hits into the first prompt.
`memory_search` **records no access by design** (`tools.ts`: *"a summary list is not a read"*).
Consequences that compound:

1. Notes surfaced by preload never gain `hits` → never gain `activation` → never rank higher in the
   next preload. The one retrieval path that runs on **every step** contributes nothing to ranking.
2. `consolidateTask.derivedFrom` = *accessed* project note ids only. A step that used preloaded
   context but never called `memory_read` produces **zero provenance links**.
3. `isSubstantive` gates on `derivedFrom.length >= 1 || steps.length >= 2`. So single-step tasks that
   used preloaded knowledge silently produce no consolidation note at all.

The feature that saves tokens (preload) structurally starves the feature that makes the network
self-improving (activation + provenance). They were designed independently and meet nowhere.

**Fix shape:** record a distinct `MEMORY_ACCESS.preload` mode with a lower weight, or count
"surfaced in preload AND the step signalled success" as a weak access. At minimum, preloaded ids
must reach `derivedFrom`.

---

### F3 — The network grows nodes, not edges  ⛔ critical (vision)

`captureAmbientNote` writes one episodic note per signalled step with **`links: []`**. `noteLint`
only warns about missing links on the *semantic* tier, so episodic notes are exempt by design.

The **only** automatic edge producers in the whole system are:
- `consolidatedNote` → `derived_from` accessed project notes (usually empty — see F2),
- `instantiateFrozenPlan` → reads `decomposes_into` / `depends_on` from *human-authored* plan notes.

Nothing links a step note to its plan note, its task's consolidation note, the files it touched, or
its upstream siblings — **all of which are known for free at write time**:
- `ctx.step.id` **is** the plan-note id after `instantiateFrozenPlan` (ids carry through verbatim),
- `Object.keys(ctx.depOutputs)` are the upstream step ids (= their plan-note ids),
- `ctx.taskId` gives the plan scope.

So: you have a graph store, typed edges, both-direction traversal, RRF fusion, activation decay and
edge-level heat — and almost no automatic edge production feeding it. The graph accumulates
disconnected episodic nodes findable only by search, which is the exact failure mode `noteLint`
warns humans about on the semantic tier.

**This is the largest gap between the code and "self-creating neuronal network."** It is also the
cheapest to close: one draft change in `captureAmbientNote` wires every run into the graph.

---

### F4 — `hits` / `lastAccessedAt` has two independent implementations

- Surreal projector keeps incremental columns on `note` and `link` rows (`surreal.ts:234, 245`).
- Contracts re-derive the same numbers from the log (`foldAccessCounts`, `foldEdgeStats`).

Consumers are split: `neighbors()` and `semanticSearch()` read the Surreal columns; the UI graph heat
and `sweep.ts` read the folds. Two code paths, two failure modes, and they diverge whenever the
projector is behind — which `probeMemory` explicitly tolerates (`KNOWLEDGE_KINDS` excludes
`memory_accessed`, so "healthy" is compatible with stale hits). A sweep and a search can therefore
disagree about whether a note is cold.

---

### F5 — Memory events are folded in six different shapes

`foldLiveNotes`, `foldPlanNotes`, `foldAccessCounts`, `foldWriteTimes`, `foldEdgeStats`,
`SurrealMemory.applyEvent`, plus `kernel.planNotesChangedSince`'s inline scan — all reading the same
two or three event kinds, each doing its own pass.

`deriveNoteProvenance` exists *because* two of these drifted and threw on every sourced plan note.
That is a signal the split is wrong, not that the extraction was right. One
`foldMemory(events) → { notes, access, edges, writeTimes }` replaces all of them and does one pass
instead of five. `sweep.ts` alone currently makes three passes over the same array.

---

### F6 — "Parallel launch" is weaker than it looks

Three independent ceilings stack:

1. **Wave barrier.** `runWorkflow` launches a wave, `await Promise.all(...)`, then recomputes
   readiness. A fast step's dependents wait for the slowest step in its wave, even when the
   dependency graph permits progress. Knowingly paid (DBOS binds child workflows positionally, and
   `startWfFuncId` is not exposed) — but it is a real cost and it is not visible to the user.
2. **Queue concurrency = 3** (`config.concurrency` default), per depth.
3. **One supervisor per project** (`PHASE1_MAX_SLOTS = 1`), because the zone write-fence is an
   in-process `Map` (`executor-api-loop/src/tools.ts:79`).

Plus: every parallel unit is a full task — `task_created` → `plan_proposed` → approval → `orcRun`
workflow → `orcStep` workflow. There is no lighter-weight fan-out primitive for "run these five
reads concurrently and give me the answers", which is the shape the vision's *"parallelly launch
tasks"* and *"search info to save tokens"* both want.

Effective ceiling today: **3 concurrent model loops per depth level, gated behind a wave barrier.**
That number is not stated anywhere a user would look, and it isn't one setting — it's spread across
`concurrency`, the barrier, and the supervisor fence.

---

### F7 — Two plan representations that diverge after the freeze

The plan-note graph (memory, `plan` tier, scope `plan:<taskId>`) is frozen by
`instantiateFrozenPlan` into a `ChildPlanDraft` → `Plan` event. After that:

- The note graph stays **writable** and is still what `orc memory neighbors` and the UI show.
- Execution runs the **frozen copy**.
- Nothing reconciles them, and nothing marks the note graph as frozen.
- `plan_annotated` / `plan-revise` only work *before* `finalize_plan`.

Worse, **plan-tier notes default to `retention: durable`** (only `episodic` is pinned expirable).
`orc memory sweep` retires expirable notes only, and the sole cleanup path for a plan scope is
`orc cancel`. So every completed grounded task leaves its entire decomposition in the graph
permanently — noise in exactly the store `preloadKnownContext` searches on every step.

---

### F8 — Every CLI memory command pays a full cold start

`orc memory {add,rm,ls,search,cat,neighbors,rebuild,consolidate}` and `orc note` each do:

```
openMemory → createMemory → gitRevision()      ← spawns `git rev-parse`, even for read-only commands
           → openKnowledge()                    ← fresh Surreal WS connect (5s timeout budget)
           → projector.catchUp()                ← full drain from cursor
           → the actual work
           → close()
```

`gitRevision` is only used to stamp *writes*; read paths pay a subprocess spawn for nothing.
`catchUp()` on a read path is a full drain per invocation.

---

### F9 — Implicit behaviour / patched-in spots

These do something other than what their location suggests:

| Location | What it actually does |
|---|---|
| `bin.ts:48` | Rebinds `console.log/info/debug` to `console.error` **process-wide**, keyed on `argv[0..1] === ['mcp','serve']` |
| `dbos-port.ts:143` `redactStepResult` | Wraps values in `{v: …}` so arrays/primitives hit the redactor's object walk, then unwraps. DBOS `operation_outputs` redaction depends on a shape trick, not the redactor's contract |
| `surreal.ts:138`, `:359` | Two raw-SurrealQL escape hatches (DDL, vector cosine) around an ORM that can express neither — the ORM is carrying less than it costs |
| `surreal.ts:441` `matchFilter` | Seeds with `n.scope.eq(n.scope)` as an always-true predicate |
| `tools.ts:197` memory_write | `id ?? slugId(title)` — a title edit silently **forks** the note into a new id; only the schema *description* prevents it |
| `loop.ts:264` `captureAmbientNote` | Bypasses the operation journal entirely; idempotency rests on a synthetic tool-call id (self-flagged) |
| `store.ts:43` | Swallows `idempotency_conflict` when the payload differs only by the git-revision stamp — a genuinely conflicting keyed replay with a different revision is indistinguishable from a benign one |
| `dbos-port.ts:82/473/496` | Three hand-rolled read-check-append blocks (`appendRunInit`, `finish`, `contain`) that all exist because `makeCheckpoint(fn, toEvents)` runs `fn()` then opens a **separate** transaction for its drafts — so any state-dependent event is TOCTOU through the draft path. That is the structure being wrong, not the three call sites |
| `main.ts:396` `approve` | Silently calls `ensureRuntime()` (which may **spawn a detached background process**) as a side effect of approving a non-root plan |

---

### F10 — `docs/ARCHITECTURE.md` contradicts the code and itself

- The execution sequence diagram shows `orc run <task>` → `Kernel` → `startRun` directly. The real
  path is `kernel.requestRun` (appends `run_requested`) → **supervisor's signal router** →
  `startRunAt`. The "Identity and isolation" section further down describes the supervisor
  correctly — so the document contradicts itself.
- The `plugins/memory` responsibilities row omits: embeddings / semantic + hybrid search, the
  memory-lifecycle consolidation seam, the tier'd note model (semantic/episodic/plan), activation
  and edge heat, and the drift probe.
- No mention of `runtime-lock`, `supervisors` table, or the `PHASE1_MAX_SLOTS = 1` constraint in the
  module map.

---

## Recommended order

| # | Change | Why first |
|---|---|---|
| 1 | `captureAmbientNote` emits links (`example_of` its plan note, `depends_on` upstream step notes) | ~10 lines. Turns node accumulation into actual graph growth — the core of the vision |
| 2 | Preloaded ids count as weak accesses + reach `derivedFrom` | ~15 lines. Closes the loop between token-saving and learning (F2) |
| 3 | `budgetRemainingUSD` short-circuits when no ancestor has a budget | ~5 lines. Removes the single most expensive line in the runtime |
| 4 | `hasLiveWork` → indexed status query instead of `fold(all())` | ~5 lines. Removes the idle-supervisor full-log read every 5 s |
| 5 | One incremental `State` cache in the kernel, shared by port / router / supervisor / sessions | The real F1 fix. Bigger, but everything above is a plaster without it |
| 6 | One `foldMemory` replacing the six folds; drop the duplicate `hits` derivation | F4 + F5 in one change |
| 7 | Plan-scope retention: expire plan notes once the task is terminal | Stops the graph filling with dead decompositions (F7) |
| 8 | Update `docs/ARCHITECTURE.md` from Part 1 of this document | F10 |


---

## Resolution

859 tests pass (baseline 838), workspace typecheck clean, zero non-null assertions in production code.

| # | Outcome |
|---|---|
| **F1** | `fold` split into `emptyFold`/`foldInto` (batch path is now a reduce over the incremental one, equivalence pinned). New `kernel/live-state.ts` serves advisory reads. `budgetRemainingUSD` and the supervisor's idle probe read the index instead of `fold(await log.all())`; `ProjectSessions` applies events incrementally. `startRunAt` deliberately does **not** use it — admission is a decision, not an advisory read — and now uses two indexed `byTask` reads instead of a whole-log scan. |
| **F2** | New `MEMORY_ACCESS.preload` mode. `StepMemory.recall` records what it surfaced, so injected notes earn activation and reach consolidation's `derived_from`. |
| **F3** | `StepMemory.capture` writes `depends_on` edges to the ambient notes of upstream steps and `derived_from` edges to every durable note the step pulled. A run now wires itself into the graph. |
| **F4** | `bumpAccess` and `viaEdge` in contracts are the one increment rule and the one edge canonicalization; the Surreal projector applies both instead of hand-rolling them. |
| **F5** | `foldLiveNotes` + `foldMemory` replace five separate walks. `staleNotes` went 4 passes → 1, `buildGraph` 3 → 1. |
| **F6** | The wave barrier stays (DBOS binds child workflows positionally — removing it reintroduces the replay-order bug). The ceiling is now *stated*: `orc serve` prints concurrency-per-depth, max depth and supervisor count, and ARCHITECTURE.md records all three limits in one place. |
| **F7** | `recall` is scoped to `linkLookupScopes(planScope(taskId))`, and the scope predicate moved **into** the query — the semantic arm ranks then truncates, so the old post-filter let one project's plan notes occupy every slot. |
| **F8** | `sourceRevision` became a memoized provider: read paths no longer spawn `git rev-parse`, and the spawn never happens inside the project write lock. |
| **F9** | Redactor exposes its shape-preserving walk (`redact.value`), so the port drops the `{v: …}` wrapper trick. `stampIfRunning` replaces two hand-rolled locked read-check-appends. `finalize_plan` does one `find` instead of `some` + `find!`. `store.write`'s idempotency comment corrected to state the rule the code enforces. |
| **F10** | ARCHITECTURE.md: execution sequence redrawn through `run_requested` → supervisor → port (it showed the CLI calling `startRun` directly), plus a new "Step memory — the one seam" section, the `live-state` row, and a corrected `plugins/memory` responsibilities row. |
| **F11** | *(raised mid-review)* All 42 non-null assertions removed from production code — guards, destructuring, `Map` accessors, hoisted narrowings, and one readonly tuple. Tests keep theirs. |

### Deliberately not done

- **The wave barrier** (part of F6). `DBOS.startWorkflow` binds children by `(callerID, callerFunctionID)`,
  not by the workflow id we pass, so launch order must stay a pure function of `(plan, done, failed)`.
  Continuous scheduling needs `startWfFuncId`, which the SDK does not expose. The cost — a fast step's
  dependents wait for its whole wave — is real and now documented rather than hidden.
- **The signal router's per-event refold.** It reads `after(0, ROUTER_KINDS)` and folds on each routed
  event. Left as-is because router kinds are the low-volume ones and the file's catch-up/idempotency
  logic is the most delicate in the repo. It did get the cheap half of the fix: `memory_written` left
  `ROUTER_KINDS` (note bodies no longer ride every routed event) and is fetched only when a split
  actually resolves.

### Follow-on worth considering

- `memory_write` still forks a note when its title changes and no id is passed (`id ?? slugId(title)`);
  only the tool description prevents it.
- Plan-tier notes remain `retention: durable`, so a finished task's decomposition is kept forever.
  Harmless for retrieval now that recall is scoped, but it is unbounded storage.


---

## Round two — review of the fixes

The first pass introduced regressions of its own. Re-reviewed end to end; all resolved.
866 tests pass, typecheck clean.

**Introduced by round one, now fixed:**

| Problem | Resolution |
|---|---|
| Scoping `recall` to `linkLookupScopes(planScope(taskId))` made split children blind to their own decomposition — a child's id is `${parent}.${step}.${callId}`, so `plan-<child>` is a different scope from the `plan-<parent>` its subplan notes live in | New `taskLaneScopes(taskId, ancestorTaskIds)` in contracts; the port supplies the ancestor chain via one shared `ancestorTaskIds(state, taskId)` in projections (which also replaced the inline walks in `remainingBudget` and the CLI's root-of-tree lookup) |
| `recall` was scoped but the model's own `memory_search` was not — same starvation, still open | `memoryTools` takes an options object with `searchScope`; the step binding passes the same lanes to both paths. `orc mcp serve` passes none, so an external browser still sees the whole graph |
| `pulled` silently excluded `neighbors`, so a step that navigated the graph left no provenance | One rule: any delivered project-scope access is provenance. `recordAccess` fires on a hit only, so the seed was genuinely pulled |
| `matchFilter`'s scope predicate used a `null` reduce seed plus an index test, and an `any` | Destructured head/tail |
| `recall`'s fallback ladder was a nested async IIFE | An ordered candidate list and a loop |
| `LiveState.current()` returns a mutated-in-place view where `fold()` used to return a fresh snapshot | Stated on the interface: read synchronously, do not retain across an await |
| `projectState()` silently fell back to `fold(await log.all())` — the exact scan it exists to remove | Throws. Every caller runs inside or after `launch()`, so a null there is a wiring bug, not a slow path |

**Flagged in round one but not actually fixed, now done:**

| Problem | Resolution |
|---|---|
| `store.write` folded the project's entire memory history **inside the project advisory lock**, which serializes every writer — and ambient capture writes a note per step, so it grew with exactly what the graph is for | New `EventLog.latestNoteEvent(scope, id)` + migration `0004_note_lookup_index` (partial expression index; both kinds COALESCE the note address because `memory_written` nests it and `memory_deleted` does not). Verified with `EXPLAIN ANALYZE` over 20k memory events: `Index Scan using idx_events_note_seq`, 3 buffers, 0.04 ms |
| `buildGraph` still walked every event on every event — round one made `fold` incremental and left this half | `foldMemoryInto`/`emptyMemoryFold` mirror `foldInto`; `buildGraph` takes the `MemoryFold` and `ProjectSessions` maintains it per event |
| `nodeDetail` re-walked all events per request | Reads the maintained fold (`mem.notes`, `mem.access`) |

`foldLiveNotes` was deleted — after the above it had no callers, since `foldMemory().notes` is the same map from the same walk.

> **Operational note:** migration 0004 means an existing database is one behind. `openStorage`
> fails loudly until `orc db migrate` runs.
