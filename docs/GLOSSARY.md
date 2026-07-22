# Glossary

Key terms used throughout the orchestrator codebase and documentation. Many terms link to where they are first explained or most thoroughly documented.

---

## A

**Approval** — Human gate that freezes a plan graph via SHA-256 hash and permits execution to proceed. See [`feedback_provided` event](docs/ARCHITECTURE.md#feedback-delivery-and-grounded-approval), [`orc approve` command](README.md#quickstart).

**Artifact** — Output file produced by a step (declared in the step's `signal(success, outputs: [...])` call). Verified via SHA-256 receipt at the storage boundary. See [output lineage](docs/ARCHITECTURE.md#responsibilities), [`artifact_produced` event](docs/ARCHITECTURE.md#execution-flow-—-one-step-durably), [`vault/tasks/<id>/lineage.md`](README.md#vault-views).

**Audit replay** — Deterministic reconstruction of any historical state by folding events up to a given sequence. See [`orc replay` command](README.md#quickstart), [audit replay guarantee](README.md#guarantees-stated-precisely), [`docs/ARCHITECTURE.md` audit replay section](docs/ARCHITECTURE.md#audit-replay).

---

## C

**Checkpoint** — DBOS-managed durable state across step retries. Distinct from `operation`, which journals external calls. See [execution flow](docs/ARCHITECTURE.md#execution-flow-—-one-step-durably), [DBOS port invariant](docs/EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Citation** — URL + optional title on a `research` note, proving the finding came from external sources. Only note kind that requires citations. See [knowledge—raw evidence vs distilled note](docs/ARCHITECTURE.md#knowledge-—-raw-evidence-vs-distilled-note).

**Contracts** — `packages/contracts/` package containing only Zod schemas and interface definitions (no runtime I/O, no policy). Imported by kernel and plugins; kernel never imports plugins. See [dependency rule](docs/EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

---

## D

**Data-access service** — Encapsulates one database or file store (Postgres, SurrealDB, vault). Sits in tier ② between application (tier ①) and databases (tier ③). See [system map—three tiers](docs/ARCHITECTURE.md#system-map-—-three-tiers), [`openStorage()`, `openKnowledge()`](docs/ARCHITECTURE.md#the-storage-service-—-read/write-boundary).

**Degraded memory** — SurrealDB down ⇒ `memory unavailable` tool results, but all other operations (execution, audit, cancellation, vault trace) continue. Events still append to Postgres. See [degraded memory guarantee](README.md#guarantees-stated-precisely), [vault startup](README.md#operational-notes).

**Decision** — Architectural choice recorded as a `kind=decision` note in the knowledge graph. See [`vault/memory/index.md`](README.md#vault-views), [ADR formalization](docs/plans/INDEX.md#phase-2-documentation-roadmap).

**Deterministic** — Guaranteed to produce identical output given identical inputs. Applied to vault projections (same events → same markdown), event-log fold (same events → same state), approval hash (same plan → same hash). See [vault projections](docs/seams-reference.md#vault-projections-—-read-only-human-views).

**DBOS** — Database-backed OS (durable workflow framework). Orc uses it for operation journaling, checkpoints, and retry-safe execution. See [DBOS Transact](README.md#stack), [operation journal](docs/ARCHITECTURE.md#operation-journal), [workflow recovery](README.md#guarantees-stated-precisely).

---

## E

**Event** — Immutable fact appended to the event log. Has a `kind` (enum), a `payload` (Zod-validated JSON), and a sequence number. Folds to state; never mutated; survives replays. See [event log as sole truth](docs/ARCHITECTURE.md#), [`EventKind` enum](packages/contracts/src/events.ts), [fold function](packages/kernel/src/projections.ts).

**Event log** — Postgres `events` table (project-scoped). The one source of truth. Appended via `EventLog.append()` under the per-project advisory lock; read by subscriptions, replay, vault projector, memory projector. See [sole truth](docs/ARCHITECTURE.md#), [storage service](docs/ARCHITECTURE.md#the-storage-service-—-read/write-boundary).

**Executor** — Agent framework that loops model/tool calls until `signal(success)` or a terminal error. Injected at `createDbosPort()`. Default: `executor-api-loop`. See [executor interface](packages/contracts/src/execution.ts), [`executor-api-loop` plugin](plugins/executor-api-loop/), [how to add one](docs/EXTENDING.md#where-a-change-goes).

---

## F

**Feedback** — Human-provided reply to a plan approval. Includes task/step envelope and an idempotent outbox for delivery. See [`feedback_provided` event](docs/ARCHITECTURE.md#feedback-delivery-and-grounded-approval), [human gate](docs/EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Fingerprint** — Digest of trust consent (for MCP: command + args + env names; for extensions: entry + resolved local imports + `bun.lock`). Binding mechanism for `orc mcp trust` and `orc ext trust`. See [trust model](README.md#operational-notes), [declare vs grant](docs/EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Fold** — Pure function `fold(events[]) → State`, deterministically reconstructing a snapshot at any point. Idempotent: folding the same events twice yields identical state. See [fold function](packages/kernel/src/projections.ts), [`applyOperationEvent`](docs/ARCHITECTURE.md#responsibilities).

---

## G

**Graph UI** — Web-based interactive visualization of the task/execution/knowledge graph. Served by `orc graph` on `http://127.0.0.1:7749` (localhost only, read-only). See [`orc graph` command](README.md#operational-notes), [graph UI plan](docs/plans/2026-07-20-graph-ui.md).

---

## H

**Hook bus** — Async event subscription mechanism for plugins and extensions. Subscribers are drained before deactivation. See [T2 extensions](docs/EXTENDING.md#where-a-change-goes), `HookBus` in `packages/kernel/src/`.

---

## I

**Idempotency key** — Deterministic, unique identifier for an operation (command + args + optional payload hash). DBOS uses it to safely retry: a crash mid-operation can re-attempt using the same key without duplication. See [resume guarantee](README.md#guarantees-stated-precisely), [operation journal](docs/ARCHITECTURE.md#operation-journal).

**Index** — Human projection (markdown file in vault) summarizing a data structure. E.g., `vault/index.md` (task tree), `vault/memory/index.md` (knowledge graph). Deterministic, rebuilt on data changes. Not a database index. See [vault projections](docs/seams-reference.md#vault-projections-—-read-only-human-views).

**Isolation** — Execution boundary for a step (process/sandbox separation). Declared in plan `isolation` field. See [execution tier](docs/ARCHITECTURE.md#system-map-—-three-tiers), [plan schema](packages/contracts/src/execution.ts).

---

## K

**Kernel** — `packages/kernel/`, the policy-free core. Implements task/plan lifecycle, feedback gates, fold, storage service facades, DBOS port, signal routing. Imports only `contracts`; receives plugins. See [kernel responsibilities](docs/ARCHITECTURE.md#responsibilities).

**Knowledge graph** — SurrealDB read model of authored notes + typed links. Event-first: built from `memory_written`/`memory_deleted`/`memory_accessed` events. Disposable; rebuilt on startup if stale. See [knowledge—raw evidence vs distilled note](docs/ARCHITECTURE.md#knowledge-—-raw-evidence-vs-distilled-note), [memory system interaction](docs/seams-reference.md#memory-subsystem-interaction).

---

## L

**Lineage** — Artifact provenance: which step produced which output, with SHA-256 receipt. Viewable in `vault/tasks/<id>/lineage.md`. See [artifact receipt](docs/ARCHITECTURE.md#execution-flow-—-one-step-durably), [output lineage guarantee](README.md#guarantees-stated-precisely).

---

## M

**Memory** — Durable knowledge graph (SurrealDB read model + vault projection). Event-first, degradation-tolerant, sourced-research-only. See [`vault/memory/`](README.md#vault-views), [memory system](docs/seams-reference.md#memory-subsystem-interaction).

**Memory note** — Authored fact, decision, finding, or plan recorded in the knowledge graph. Has `id`, `scope`, `kind`, `links`, `body`, optional `sources`. Only `research` kind requires citations. See [note kinds](packages/contracts/src/memory.ts), [`memory_write` tool](plugins/memory/).

**MCP** — Model Context Protocol. External tool server. Declared in `.orc/config.json`, armed with `orc mcp trust` (fingerprint grant), referenced in plans via `toolRefs`. See [MCP server pattern](README.md#operational-notes), [`mcp-client` plugin](plugins/mcp-client/), [trust model](docs/EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

**Mutation** — Write operation (append event, approve plan, write note, etc.). Only available when CLI is inside a project (CSRF-token guarded for web). See [CLI entry point](packages/cli/src/bin.ts), [graph UI mutations](docs/plans/2026-07-21-web-actions.md).

---

## N

**Neuron** — Deferred memory lifecycle concept: notes decay on access, drop out of search when dormant, become archive candidates. Trigger: knowledge graph shows clear hot/cold split. See [`IDEAS.md` entry 1](docs/IDEAS.md#1-neuron-like-memory-lifecycle-decay-sweep-archive-restore).

**Note** — Unit of authored knowledge in the graph. See [memory note](#memory-note).

---

## O

**Operation** — External call (model, tool, side effect) with a durable before/after journal record. Distinct from `checkpoint` (DBOS-managed state). See [operation journal](docs/ARCHITECTURE.md#operation-journal), [operation responsibilities](docs/ARCHITECTURE.md#responsibilities), [`ctx.operation` in dbos-port](packages/kernel/src/execution/dbos-port.ts).

**Operation journal** — Postgres `operations` table (rebuildable from events). Records `operation_started` BEFORE the external call and completion/failure AFTER. Crash leaves an unresolved node. See [operation journal](docs/ARCHITECTURE.md#operation-journal), [`orc status` command](README.md#quickstart).

---

## P

**Plan** — Structured task decomposition: list of steps, each with role, title, instructions, skill/tool refs, executor, model, dependencies. Frozen at approval (SHA-256 hash). See [plan schema](packages/contracts/src/execution.ts), [grounded planning](docs/superpowers/specs/2026-07-19-m5b-grounded-plan-strategy-design.md).

**Plugin** — Replaceable behavior: executor, provider, skill, tool server, extension. Registered via `seedRegistries`, opted-in via plan refs. See [plugins design](docs/superpowers/specs/2026-07-17-m3-plugins-design.md), [plugin registry](packages/kernel/src/plugins/host.ts).

**Project** — Isolated execution context with its own identity, event log, operations, vault, and memory. Set via `orc init --name`. See [project identity](docs/ARCHITECTURE.md#identity-and-isolation), [`projectId` + `projectName` in config](README.md#quickstart).

**Projector** — Background process that reads from the event log and writes projections (vault markdown, Surreal notes, operation journal index). See [vault projector](packages/vault-projector/), [memory projector](plugins/memory/src/projector.ts).

---

## R

**Redaction** — Stripping secrets + configured sensitive keys/values at the Postgres storage boundary (never in-flight). See [redaction guarantee](README.md#guarantees-stated-precisely), [redaction service](packages/kernel/src/redact.ts), [`redactEnv` config](packages/kernel/src/config.ts).

**Replay** — Deterministic recreation of state at any historical sequence. See [`orc replay` command](README.md#quickstart), [audit replay](README.md#guarantees-stated-precisely).

**Research note** — Only note kind that MUST carry citations. Raw fetched pages stay in audit trail; distilled findings land in memory only as `research` notes with sources. See [sourced knowledge](README.md#guarantees-stated-precisely), [research note pattern](docs/ARCHITECTURE.md#knowledge-—-raw-evidence-vs-distilled-note).

**Retention** — Note field: `durable` (default, permanent) or `expirable` (may be swept in future; see [`IDEAS.md` entry 2](docs/IDEAS.md#2-retention-durable--expirable-on-notes-—-shipped-2026-07-20)). Authoring judgment at write time. See [retention field](packages/contracts/src/memory.ts).

---

## S

**Scope** — Namespace for notes in the knowledge graph. Default is `"project"`; custom scopes like `"architecture"`, `"glossary"` organize notes thematically. See [knowledge graph structure](docs/seams-reference.md#knowledge-graph-structure).

**Seam** — Extension point defined in `packages/contracts/`. Examples: `ModelProvider`, `AgentExecutor`, event kinds, config keys. See [seam map](docs/EXTENDING.md#where-a-change-goes), [seams reference guide](docs/seams-reference.md).

**Signal** — Step completion message: `signal(success, outputs)` or `signal(failure, error)`. Triggers artifact verification and event committal. See [signal](packages/contracts/src/execution.ts), [execution flow](docs/ARCHITECTURE.md#execution-flow-—-one-step-durably).

**Skill** — Agent knowledge/procedures (no code). Defined in `vault/skills/<name>/SKILL.md`. Hot-indexed, force-loaded via `skillRefs`. See [skills pattern](docs/EXTENDING.md#where-a-change-goes), [skill indexing](packages/kernel/src/plugins/skills.ts).

**Split** — Recursive task decomposition via `task_split()`. Creates child tasks and optionally starts them. See [task split](docs/seams-reference.md#scenario-4-task-splits-into-children), [recursion core design](docs/superpowers/specs/2026-07-19-m5a-recursion-core-design.md).

**Storage service** — Data-access facade for one database/store (Postgres, SurrealDB, vault). Encapsulates connection, locking, redaction, migrations. See [storage service](docs/ARCHITECTURE.md#the-storage-service-—-read/write-boundary), [tier ②](docs/ARCHITECTURE.md#system-map-—-three-tiers).

---

## T

**Task** — Top-level work unit. Created via `orc new`, approved via `orc approve`, run via `orc run`. Has a plan and execution state. See [`Task` type](packages/contracts/src/execution.ts), [`orc new` command](README.md#quickstart).

**Tool** — External capability invoked during step execution (via MCP server or built-in skill). Opted-in via `toolRefs`. See [MCP server](#mcp), [tool references](packages/contracts/src/execution.ts#toolRefs), [`mcp-client` plugin](plugins/mcp-client/).

**Trust** — Fingerprint-based consent for plugins/MCP/extensions. Declared in `.orc/config.json`, granted via `orc mcp trust` / `orc ext trust`, stored in `.orc/trust.json` (mode 0600, never committed). See [trust model](README.md#operational-notes), [declare vs grant invariant](docs/EXTENDING.md#invariants-—-the-rules-that-keep-changes-cheap).

---

## V

**Vault** — Deterministic markdown projections of tasks, execution, lineage, and knowledge. Rebuilt on every relevant event. Starts empty; first event triggers initial render. See [`vault/` views](README.md#vault-views), [vault projections](docs/seams-reference.md#vault-projections-—-read-only-human-views).

---

## W

**Workflow** — DBOS-managed durable execution context for a run. Survives crashes via checkpoints + operation journal. See [DBOS workflow](packages/kernel/src/execution/dbos-port.ts), [workflow recovery](README.md#guarantees-stated-precisely).

---

## Z

**Zod** — Runtime schema validation library. Used for contracts, event payloads, config. See [stack](README.md#stack), [`packages/contracts/`](packages/contracts/).

---

## Cross-references

### By Topic

**Execution**
- [Checkpoint](#checkpoint), [Operation](#operation), [Signal](#signal), [Workflow](#workflow), [Fold](#fold), [DBOS](#dbos)

**Knowledge & Memory**
- [Memory note](#memory-note), [Knowledge graph](#knowledge-graph), [Research note](#research-note), [Citation](#citation), [Scope](#scope), [Retention](#retention)

**Architecture**
- [Event](#event), [Event log](#event-log), [Data-access service](#data-access-service), [Kernel](#kernel), [Contracts](#contracts), [Seam](#seam), [Plugin](#plugin)

**Documentation**
- [Decision](#decision), [Audit replay](#audit-replay), [Lineage](#lineage), [Index](#index)

**Operations**
- [Project](#project), [Task](#task), [Plan](#plan), [Split](#split), [Approval](#approval), [Artifact](#artifact), [Tool](#tool), [Skill](#skill)

**Infrastructure**
- [MCP](#mcp), [Trust](#trust), [Fingerprint](#fingerprint), [Degraded memory](#degraded-memory), [Idempotency key](#idempotency-key), [Redaction](#redaction), [Projector](#projector)

---

## See Also

- [`README.md`](README.md) — Quick navigation, guarantees, operational notes
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — System map, modules, tiers, invariants
- [`docs/EXTENDING.md`](docs/EXTENDING.md) — How to add a seam (provider, executor, skill, tool, event)
- [`docs/seams-reference.md`](docs/seams-reference.md) — Call paths, debugging strategies, component interactions
- [`docs/IDEAS.md`](docs/IDEAS.md) — Deferred work with reasoning and triggers
- [`docs/plans/INDEX.md`](docs/plans/INDEX.md) — Catalog of feature plans and approval status
