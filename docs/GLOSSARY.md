# Glossary

Key terms used throughout the orchestrator codebase and documentation. Many terms link to where they are first explained or most thoroughly documented.

---

## A

**Approval** — Human gate that permits execution to proceed. Two of them, writing different events: the ordinary gate (`orc approve <taskId>`) appends `plan_approved` and hashes nothing; the grounded-plan gate (`orc reply <taskId> approve`) additionally stamps a SHA-256 of the canonical plan-note graph onto `feedback_provided`, recording what was approved and when. `finalize_plan` freezes the plan only if nothing was written to the task's plan scope after that approval's seq. See [feedback delivery and grounded approval](ARCHITECTURE.md#feedback-delivery-and-grounded-approval), [both gates side by side](seams-reference.md#a-plan-is-approved-by-a-human).

**Artifact** — Output file produced by a step (declared in the step's `signal(success, outputs: [...])` call). Verified via SHA-256 receipt at the storage boundary. See [output lineage](ARCHITECTURE.md#responsibilities), [`artifact_produced` event](ARCHITECTURE.md#execution-flow-—-one-step-durably), [`vault/tasks/<id>/lineage.md`](../README.md#vault-views).

**Audit replay** — Deterministic reconstruction of any historical state by folding events up to a given sequence. See [`orc replay` command](../README.md#quickstart), [audit replay guarantee](../README.md#guarantees-stated-precisely), [execution flow](ARCHITECTURE.md#execution-flow-—-one-step-durably).

---

## B

**Brief** — What a new session is told about a project before it has asked anything: the workspace the directory is, with its [health](#workspace); tasks awaiting approval, running or blocked (capped per status, this checkout's first); accepted [decisions](#decision), title plus one line, capped; and the drift advisory when it fires. `orc brief` prints it (`--json` for the parsed shape). The Claude Code plugin's `SessionStart` hook injects it into every session. It reads the read model as it stands and never drains the projector, stating how many knowledge events it is behind. A read model that cannot be reached costs the brief its decisions and note count — printed as unknown, never as none. See [`Brief` schema](../packages/contracts/src/brief.ts), [selection and rendering](../packages/cli/src/brief.ts), [the reads](../packages/cli/src/brief-gather.ts), [the hook](../plugin/hooks/session-start.sh).

---

## C

**Checkpoint** — DBOS-managed durable state across step retries. Distinct from `operation`, which journals external calls. See [execution flow](ARCHITECTURE.md#execution-flow-—-one-step-durably), [DBOS port invariant](EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Citation** — URL + optional title on a `research` note, proving the finding came from external sources. Only note kind that requires citations. See [knowledge—raw evidence vs distilled note](ARCHITECTURE.md#knowledge-—-raw-evidence-vs-distilled-note).

**Claim** — One individually addressable statement asserted by a [semantic note](#note-tier), and the unit the claim arm of search returns. Its id IS its content: `claimId(text)` = sha256 of the whitespace-normalized text, first 12 hex chars. Writers add and retire claims by name (`addClaims` / `invalidates`) — never by supplying the array. `validFrom` is stamped by the projector from the committed event, not by the writer. See [claims](ARCHITECTURE.md#claims-—-the-addressable-unit-of-knowledge), [`claim.ts`](../packages/contracts/src/claim.ts).

**Claim history** — A claim's whole life, recovered by folding the event log (`orc memory claims <id> --history`). The tombstone lives on the `memory_written` event, never on the note, so the log is the only surface a retired claim survives on. See [claims](ARCHITECTURE.md#claims-—-the-addressable-unit-of-knowledge).

**Contracts** — `packages/contracts/` package containing only Zod schemas and interface definitions (no runtime I/O, no policy). Imported by kernel and plugins; kernel never imports plugins. See [dependency rule](EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

---

## D

**Data-access service** — Encapsulates one database or file store (Postgres, SurrealDB, vault). Sits in tier ② between application (tier ①) and databases (tier ③). See [system map—three tiers](ARCHITECTURE.md#system-map-—-three-tiers), [`openStorage()`, `openKnowledge()`](ARCHITECTURE.md#the-storage-service-—-read/write-boundary).

**Degraded memory** — SurrealDB down ⇒ `memory unavailable` tool results, but all other operations (execution, audit, cancellation, vault trace) continue. Events still append to Postgres. See [degraded memory guarantee](../README.md#guarantees-stated-precisely), [vault startup](../README.md#operational-notes).

**Decision** — Architectural choice recorded as a `kind=decision` note. Carries a `status` (`proposed | accepted | superseded | deprecated`; absent reads as `accepted`) and a fixed body — Context, Decision, Consequences (`plugins/memory/src/adr.ts`). Recorded by `orc adr new` (author `human`) or the MCP `record_decision` tool (author `mcp`); changed only by supersession, which links the new note `supersedes` the old and marks the old `superseded`. See [`decisions.ts`](../plugins/memory/src/decisions.ts), [note lifecycle](ARCHITECTURE.md#note-lifecycle-—-currency-healing-retirement).

**Deterministic** — Guaranteed to produce identical output given identical inputs, *for a given build*. Applied to vault projections (same events → same markdown), event-log fold (same events → same state), the plan freeze (same plan-notes → same executable plan). A derivation that serializes parsed records is deterministic with respect to its inputs AND the schema the running build parses them with, so two processes on different builds may disagree — which is why nothing compares such a value across a process boundary. See [vault projections](seams-reference.md#vault-projections-—-read-only-human-views).

**DBOS** — Database-backed OS (durable workflow framework). Orc uses it for operation journaling, checkpoints, and retry-safe execution. See [DBOS Transact](../README.md#stack), [operation journal](ARCHITECTURE.md#the-storage-service-—-read/write-boundary), [workflow recovery](../README.md#guarantees-stated-precisely).

---

## E

**Event** — Immutable fact appended to the event log. Has a `kind` (enum), a `payload` (Zod-validated JSON), and a sequence number. Folds to state; never mutated; survives replays. See [event log as sole truth](ARCHITECTURE.md), [`EventKind` enum](../packages/contracts/src/events.ts), [fold function](../packages/kernel/src/projections.ts).

**Event log** — Postgres `events` table (project-scoped). The one source of truth. Appended via `EventLog.append()` under the per-project advisory lock; read by subscriptions, replay, vault projector, memory projector. See [sole truth](ARCHITECTURE.md), [storage service](ARCHITECTURE.md#the-storage-service-—-read/write-boundary).

**Executor** — Agent framework that loops model/tool calls until `signal(success)` or a terminal error. Injected at `createDbosPort()`. Default: `executor-api-loop`. See [executor interface](../packages/contracts/src/execution.ts), [`executor-api-loop` plugin](../plugins/executor-api-loop/), [how to add one](EXTENDING.md#where-a-change-goes).

---

## F

**Feedback** — Human-provided reply to a plan approval. Includes task/step envelope and an idempotent outbox for delivery. See [`feedback_provided` event](ARCHITECTURE.md#feedback-delivery-and-grounded-approval), [human gate](EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Fingerprint** — Digest of trust consent (for MCP: command + args + env names; for extensions: entry + resolved local imports + `bun.lock`). Binding mechanism for `orc mcp trust` and `orc ext trust`. See [trust model](../README.md#operational-notes), [declare vs grant](EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Finish step** — Kernel-appended step (role `finisher`) ending every root plan except the grounded scaffold and the auto-heal sweep, and every frozen grounded pipeline, right before the commit step. Reconciles the task's notes, drafts a decision if the task made one, and asks once; an approval word records the decision (if any) and completes the task. Gated by `stepMayReconcile`, which keys on both step id and role so a planner-authored step merely named `finish` cannot arm it. See [`role-finisher` skill](../vault/skills/role-finisher/SKILL.md), [`stepMayReconcile`](../packages/contracts/src/plan.ts), [note lifecycle](ARCHITECTURE.md#note-lifecycle-—-currency-healing-retirement).

**Fold** — Pure function `fold(events[]) → State`, deterministically reconstructing a snapshot at any point. Idempotent: folding the same events twice yields identical state. See [fold function](../packages/kernel/src/projections.ts), [`applyOperationEvent`](ARCHITECTURE.md#responsibilities).

---

## G

**Graph UI** — Web-based interactive visualization of the task/execution/knowledge graph. Served by `orc graph` on `http://127.0.0.1:7749`, bound to localhost only. Launched inside a project with a live runtime behind it, it serves CSRF-token-guarded mutations and the copilot alongside the graph, both fenced to the home project. Door #1 of the two-doors model. See [`orc graph` command](../README.md#operational-notes), [adapters](ARCHITECTURE.md#adapters-—-two-doors-over-one-transport-free-core), [graph UI plan](plans/2026-07-20-graph-ui.md).

---

## H

**Hook bus** — Async event subscription mechanism for plugins and extensions. Detached from the event transaction, and subscribers are drained before deactivation. See [T2 extensions](EXTENDING.md#where-a-change-goes), [`HookBus`](../packages/kernel/src/plugins/hooks.ts).

---

## I

**Idempotency key** — Deterministic, unique identifier for an operation (command + args + optional payload hash). DBOS uses it to safely retry: a crash mid-operation can re-attempt using the same key without duplication. See [resume guarantee](../README.md#guarantees-stated-precisely), [operation journal](ARCHITECTURE.md#the-storage-service-—-read/write-boundary).

**Index** — Human projection (markdown file in vault) summarizing a data structure. E.g., `vault/index.md` (task tree), `vault/memory/index.md` (knowledge graph). Deterministic, rebuilt on data changes. Not a database index. See [vault projections](seams-reference.md#vault-projections-—-read-only-human-views).

**Isolation** — Execution boundary for a step (process/sandbox separation). Declared in plan `isolation` field. See [execution tier](ARCHITECTURE.md#system-map-—-three-tiers), [plan schema](../packages/contracts/src/execution.ts).

---

## K

**Kernel** — `packages/kernel/`, the policy-free core. Implements task/plan lifecycle, feedback gates, fold, storage service facades, DBOS port, signal routing. Imports only `contracts`; receives plugins. See [kernel responsibilities](ARCHITECTURE.md#responsibilities).

**Knowledge graph** — SurrealDB read model of authored notes + typed links. Event-first: built from `memory_written`/`memory_deleted`/`memory_accessed` events. Disposable; rebuilt on startup if stale. See [knowledge—raw evidence vs distilled note](ARCHITECTURE.md#knowledge-—-raw-evidence-vs-distilled-note), [memory system interaction](seams-reference.md#memory-subsystem-interaction).

---

## L

**Lineage** — Artifact provenance: which step produced which output, with SHA-256 receipt. Viewable in `vault/tasks/<id>/lineage.md`. See [artifact receipt](ARCHITECTURE.md#execution-flow-—-one-step-durably), [output lineage guarantee](../README.md#guarantees-stated-precisely).

---

## M

**Memory** — Durable knowledge graph (SurrealDB read model + vault projection). Event-first, degradation-tolerant, sourced-research-only. See [`vault/memory/`](../README.md#vault-views), [memory system](seams-reference.md#memory-subsystem-interaction).

**Memory note** — Authored fact, decision, finding, or plan recorded in the knowledge graph. Has `id`, `scope`, `tier`, `links`, `title`, `summary`, `body`, plus whatever else its [tier](#note-tier) allows — for a semantic note that includes its [claims](#claim), the statements it asserts. Only `research` kind requires citations. Claims are written additively (`addClaims` / `invalidates`), never by supplying the array. See [note tiers](../packages/contracts/src/memory.ts), [`memory_write` tool](../plugins/memory/).

**Note tier** — Which memory a note belongs to, and therefore which fields it may carry. `semantic` = durable project knowledge (its [claims](#claim), plus the retrieval surface around them: `kind`, `categories`, `paths`, `sources`). `episodic` = the per-task trail a run leaves behind (title/summary/tags only, always `expirable`). `plan` = one node of a task's decomposition (`rationale`, `uncertainty`, `zone`). A note written without a tier is classified from its shape. See [NOTE_TIERS](../packages/contracts/src/memory.ts).

**MCP** — Model Context Protocol. External tool server. Declared in `.orc/config.json`, armed with `orc mcp trust` (fingerprint grant), referenced in plans via `toolRefs`. See [MCP server pattern](../README.md#operational-notes), [`mcp-client` plugin](../plugins/mcp-client/), [trust model](EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Mutation** — Write operation (append event, approve plan, write note, etc.). Only available when CLI is inside a project (CSRF-token guarded for web). See [CLI entry point](../packages/cli/src/bin.ts), [graph UI mutations](plans/2026-07-21-web-actions.md).

---

## N

**Neuron** — Deferred memory lifecycle concept: notes decay on access, drop out of search when dormant, become archive candidates. Trigger: knowledge graph shows clear hot/cold split. See [`IDEAS.md` entry 1](IDEAS.md#1-neuron-like-memory-lifecycle-decay-sweep-archive-restore).

**Note** — Unit of authored knowledge in the graph. See [memory note](#memory-note).

---

## O

**Operation** — External call (model, tool, side effect) with a durable before/after journal record. Distinct from `checkpoint` (DBOS-managed state). See [operation journal](ARCHITECTURE.md#the-storage-service-—-read/write-boundary), [operation responsibilities](ARCHITECTURE.md#responsibilities), [`ctx.operation` in dbos-port](../packages/kernel/src/execution/dbos-port.ts).

**Operation journal** — Postgres `operations` table (rebuildable from events). Records `operation_started` BEFORE the external call and completion/failure AFTER. Crash leaves an unresolved node. See [operation journal](ARCHITECTURE.md#the-storage-service-—-read/write-boundary), [`orc status` command](../README.md#quickstart).

---

## P

**Plan** — Structured task decomposition: list of steps, each with role, title, instructions, skill/tool refs, executor, model, dependencies. Derived from the approved plan-notes at the freeze, which is refused if they moved after the approval. See [plan schema](../packages/contracts/src/execution.ts).

**Plugin** — Replaceable behavior: executor, provider, skill, tool server, extension. Registered via `seedRegistries`, opted-in via plan refs. See [plugin registry](../packages/kernel/src/plugins/host.ts).

**Project** — A git repository under orc: isolated execution context with its own identity, event log, operations, vault, and memory. Identity lives in the main checkout's `.orc/identity.json`; every worktree of the repository resolves to the same project. One project spans many [workspaces](#workspace) — the checkouts it is worked in, each adopted on first use. Set via `orc init --name`. See [project identity](ARCHITECTURE.md#identity-and-isolation), [`projectId` + `projectName` in config](../README.md#quickstart).

**Projector** — Background process that reads from the event log and writes projections (vault markdown, Surreal notes, operation journal index). See [vault projector](../packages/vault-projector/), [memory projector](../plugins/memory/src/projector.ts).

**Provisional knowledge** — A note written from a [workspace](#workspace) that is not on trunk and has not merged: it describes work nobody else can see yet. Derived at read time from the note's `workspaceId` and the workspace table's current standing, never stored — which is what lets one `workspace_merged` clear it across the whole corpus on the next read. `memory_search`, `memory_read` and `memory_neighbors` carry `provisional: { workspaceId, title }` on such rows and nothing at all on final ones; a note whose workspace the table does not know is deliberately *not* flagged (that is ignorance, not evidence). A vault file carries `provisional: <workspaceId>` in its frontmatter as a snapshot taken when the file was rendered — a merge re-renders nothing, so the file keeps the flag until the note is next written or the vault is rebuilt from the read model (projector start, `orc memory rebuild`). See [`provisionalOf`](../plugins/memory/src/provisional.ts), [`ProvisionalFlag`](../packages/contracts/src/workspace-entity.ts), [memory trust](ARCHITECTURE.md#note-lifecycle-—-currency-healing-retirement).

---

## R

**Redaction** — Stripping secrets + configured sensitive keys/values at the Postgres storage boundary (never in-flight). See [redaction guarantee](../README.md#guarantees-stated-precisely), [redaction service](../packages/kernel/src/redact.ts), [`redactEnv` config](../packages/kernel/src/config.ts).

**Replay** — Deterministic recreation of state at any historical sequence. See [`orc replay` command](../README.md#quickstart), [audit replay](../README.md#guarantees-stated-precisely).

**Research note** — Only note kind that MUST carry citations. Raw fetched pages stay in audit trail; distilled findings land in memory only as `research` notes with sources. See [sourced knowledge](../README.md#guarantees-stated-precisely), [research note pattern](ARCHITECTURE.md#knowledge-—-raw-evidence-vs-distilled-note).

**Retention** — Note field: `durable` (default, permanent) or `expirable` (may be retired by `orc memory sweep` once nothing has touched it for the TTL, unless a surviving note links to it). Authoring judgment at write time; pinned to `expirable` on the episodic tier. See [retention field](../packages/contracts/src/memory.ts), [sweep policy](../plugins/memory/src/sweep.ts).

---

## S

**Scope** — Namespace for notes in the knowledge graph, and the unit retrieval lanes are built from. `"project"` (the default) is the one durable knowledge scope; the other family is per-task plan scopes, derived by `planScope(taskId)`, which hold one task's decomposition and are transient. A `MemoryLink` names an id and carries no scope, so `linkLookupScopes` decides which scope that id means — own scope first, then `project`. See [retrieval lanes](ARCHITECTURE.md#retrieval-lanes-—-what-a-step-may-be-handed), [knowledge graph structure](seams-reference.md#knowledge-graph-structure).

**Seam** — Extension point defined in `packages/contracts/`. Examples: `ModelProvider`, `AgentExecutor`, event kinds, config keys. See [seam map](EXTENDING.md#where-a-change-goes), [seams reference guide](seams-reference.md).

**Signal** — Step completion message: `signal(success, outputs)` or `signal(failure, error)`. Triggers artifact verification and event committal. See [signal](../packages/contracts/src/execution.ts), [execution flow](ARCHITECTURE.md#execution-flow-—-one-step-durably).

**Skill** — Agent knowledge/procedures (no code). Defined in `vault/skills/<name>/SKILL.md`. Hot-indexed, force-loaded via `skillRefs`. See [skills pattern](EXTENDING.md#where-a-change-goes), [skill indexing](../packages/kernel/src/plugins/skills.ts).

**Split** — Recursive task decomposition via the `task_split` tool. One transaction appends `task_created`, `split_proposed` (on the parent's stream) and `plan_proposed` — plus `plan_approved` when the project's `approvalPolicy` auto-approves, otherwise the child parks at the human gate. The router starts an approved child; `split_resolved` carries its outcome back to the parent's `join_splits`. There is no `split_approved` event. See [task split](seams-reference.md#scenario-4-task-splits-into-children).

**Storage service** — Data-access facade for one database/store (Postgres, SurrealDB, vault). Encapsulates connection, locking, redaction, migrations. See [storage service](ARCHITECTURE.md#the-storage-service-—-read/write-boundary), [tier ②](ARCHITECTURE.md#system-map-—-three-tiers).

**Supervisor** — The process holding the execution runtime for a project (`orc serve`). Presence is a heartbeat row in `supervisors`, not a lock; identity is a claimed slot id used as the DBOS executor id, so recovery is per-supervisor. Every other command is a client: it appends the ask and watches. See [identity and isolation](ARCHITECTURE.md#identity-and-isolation), [`serve.ts`](../packages/cli/src/serve.ts), [supervisor storage](../packages/kernel/src/storage/supervisors.ts).

---

## T

**Task** — Top-level work unit. Created via `orc new`, approved via `orc approve`, run via `orc run`. Has a plan and execution state. Every task names the [workspace](#workspace) it belongs to — a required field, taken from the checkout it was created in (`--workspace <id>` re-homes it, a split child inherits its parent's) — and its runs execute there unless `--cwd` overrides. `orc tasks` groups by workspace. See [`TaskNode` type](../packages/contracts/src/task.ts), [`orc new` command](../README.md#quickstart).

**Tool** — External capability invoked during step execution (via MCP server or built-in skill). Opted-in via `toolRefs`. See [MCP server](#mcp), [tool references](../packages/contracts/src/execution.ts#toolRefs), [`mcp-client` plugin](../plugins/mcp-client/).

**Topic** — A group of [claims](#claim) that mean roughly the same thing, DERIVED by clustering their embeddings — never authored, and not an agent-spelled filter. Recomputed wholesale by `refreshTopics` from the claim table (the third pipeline stage), so nothing about a topic lives only in the read model. A topic's label is the medoid claim's opening words (derived by `topicLabel()`, cut to MEMORY_LIMITS.topicLabelChars=60 and elided at a word boundary), so labels are verbatim prefixes, not paraphrases. The full medoid sentence is always reachable via `topicClaims(topicKey)` / `orc memory topics <topicKey>` / `memory_topics <topicKey>` tool. Browsable via `orc memory topics` (human rows) or `orc memory topics --json` (pretty-printed JSON) and the `memory_topics` tool; fetching one is a TRACKED event (`memory_topic_accessed`). See [topics](ARCHITECTURE.md#topics-—-grouping-that-is-derived-never-authored), [`cluster.ts`](../plugins/memory/src/cluster.ts).

**Trust** — Fingerprint-based consent for plugins/MCP/extensions. Declared in `.orc/config.json`, granted via `orc mcp trust` / `orc ext trust`, stored in `.orc/trust.json` (under the main checkout, mode 0600, never committed). See [trust model](../README.md#operational-notes), [declare vs grant invariant](EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

---

## V

**Vault** — Deterministic markdown projections of tasks, execution, lineage, and knowledge. Rebuilt on every relevant event. Starts empty; first event triggers initial render. See [`vault/` views](../README.md#vault-views), [vault projections](seams-reference.md#vault-projections-—-read-only-human-views).

---

## W

**Workflow** — DBOS-managed durable execution context for a run. Survives crashes via checkpoints + operation journal. See [DBOS workflow](../packages/kernel/src/execution/dbos-port.ts), [workflow recovery](../README.md#guarantees-stated-precisely).

**Workspace** — One checkout being worked in: the unit a [task](#task) belongs to, a run executes in, and a note remembers being written from. Two kinds — `checkout` (the repository's main checkout, the one holding the identity) and `worktree` (a linked git worktree, whether `orc ws new` created it or you did). `cwd` (a resolved realpath) is the natural key: one *active* record per directory, and the first orc command run anywhere adopts that directory, so no checkout is ever registered by hand. `managed` is true only for a directory orc created and is the fact that licenses `git worktree remove` (`orc ws archive --remove`, and the removal `orc ws merge` performs). `onTrunk` is captured at adoption and decides finality: knowledge written on trunk is final, everywhere else it is [provisional](#provisional-knowledge) until `orc ws merge` / `orc ws finalize` records `workspace_merged`. Because it is captured rather than re-derived, a checkout that *switches branch* is re-adopted — the old record is archived and a new one minted for the new branch, carrying over the facts a mint cannot derive (`managed`, `baseBranch`, `kind`) — so a main checkout moved onto a feature branch stops reading as trunk. **Workspace health** — `dangling` / `waiting` / `active` / `idle` / `merged` — is one derivation over the fold plus two probes (does the directory exist, is it clean), rendered identically by `orc ws ls`, the `workspace_list` tool and `project_status`, and stated for the current checkout by the [brief](#brief). See [`Workspace` entity](../packages/contracts/src/workspace-entity.ts), [lifecycle operations](../packages/cli/src/workspace-ops.ts), [the `orc ws` surface](../packages/cli/src/ws-commands.ts), [health + `workspaceByCwd`](../packages/kernel/src/workspaces.ts), [adoption](../packages/cli/src/workspace-adopt.ts), [Workspaces](../README.md#workspaces).

---

## Z

**Zod** — Runtime schema validation library. Used for contracts, event payloads, config. See [stack](../README.md#stack), [`packages/contracts/`](../packages/contracts/).

---

## Cross-references

### By Topic

**Execution**
- [Checkpoint](#checkpoint), [Operation](#operation), [Signal](#signal), [Workflow](#workflow), [Fold](#fold), [DBOS](#dbos)

**Knowledge & Memory**
- [Memory note](#memory-note), [Note tier](#note-tier), [Claim](#claim), [Claim history](#claim-history), [Topic](#topic), [Knowledge graph](#knowledge-graph), [Research note](#research-note), [Citation](#citation), [Scope](#scope), [Retention](#retention), [Provisional knowledge](#provisional-knowledge)

**Architecture**
- [Event](#event), [Event log](#event-log), [Data-access service](#data-access-service), [Kernel](#kernel), [Contracts](#contracts), [Seam](#seam), [Plugin](#plugin)

**Documentation**
- [Decision](#decision), [Audit replay](#audit-replay), [Lineage](#lineage), [Index](#index)

**Operations**
- [Project](#project), [Workspace](#workspace), [Brief](#brief), [Task](#task), [Plan](#plan), [Split](#split), [Approval](#approval), [Artifact](#artifact), [Tool](#tool), [Skill](#skill)

**Infrastructure**
- [MCP](#mcp), [Trust](#trust), [Fingerprint](#fingerprint), [Degraded memory](#degraded-memory), [Idempotency key](#idempotency-key), [Redaction](#redaction), [Projector](#projector)

---

## See Also

- [`README.md`](../README.md) — Quick navigation, guarantees, operational notes
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) — System map, modules, tiers, invariants
- [`docs/EXTENDING.md`](EXTENDING.md) — How to add a seam (provider, executor, skill, tool, event)
- [`docs/seams-reference.md`](seams-reference.md) — Call paths, debugging strategies, component interactions
- [`docs/IDEAS.md`](IDEAS.md) — Deferred work with reasoning and triggers
- [`docs/plans/INDEX.md`](plans/INDEX.md) — Catalog of feature plans and approval status
