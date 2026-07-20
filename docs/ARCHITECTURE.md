# Architecture

One paragraph of ground truth: the Postgres **event log is the only truth**. Every other
store — the operations journal, SurrealDB, the vault, DBOS's system database — is either a
rebuildable index over that log or a disposable projection of it. All state is `fold(events)`.
Everything below is arranged around protecting that invariant.

## System map — modules

Every first-party module, its package, and how the calls flow. The data-access services live
in the nested `storage/` cluster (Postgres) and the memory plugin's `knowledge.ts` (Surreal);
the tier-by-tier view is the next section.

```mermaid
graph TD
  subgraph CLI ["packages/cli — entrypoint & wiring"]
    BIN["bin.ts<br/>help/init/migrate bootstrap + cleanup"]
    MAIN["main.ts<br/>commands (buildProgram)"]
    RUNTIME["runtime.ts<br/>startup order, degraded mode"]
  end

  subgraph CONTRACTS ["packages/contracts — the seam layer"]
    EVENTS["events.ts<br/>EventKind, payload schemas, envelope"]
    OPS_C["operations.ts<br/>OperationSpec/Record, transitions"]
    EXEC_C["execution.ts<br/>ExecutorContext, Checkpoint, Signal"]
    WS["workspace.ts<br/>resolveInWorkspace guard"]
    MEM_C["memory.ts<br/>note kinds, store interface"]
  end

  subgraph KERNEL ["packages/kernel — policy-free core"]
    subgraph STORAGE_SVC ["storage/ — Postgres data-access service"]
      PGSTORE["postgres.ts<br/>PostgresStore: pool, project lock, redaction"]
      LOG["event-log.ts<br/>EventLog: append/subscribe/query"]
      JOURNAL["operation-journal.ts<br/>OperationJournal: before/after nodes"]
      MIG["migrate.ts<br/>explicit migrate + assertMigrated"]
    end
    REDACT["redact.ts<br/>storage-boundary normalizer"]
    FOLD["projections.ts<br/>fold, applyOperationEvent"]
    KAPI["kernel.ts<br/>task/plan + feedback/approval API"]
    PORT["execution/dbos-port.ts<br/>durable workflows"]
    ART["execution/artifacts.ts<br/>verifyArtifacts receipts"]
    ROUTER["execution/signal-router.ts<br/>split + feedback delivery"]
    HOST["plugins/host.ts<br/>registry + refValidator"]
    TRUST["plugins/trust.ts<br/>fingerprint grants"]
    SKILLS["plugins/skills.ts<br/>SKILL.md index"]
  end

  subgraph PLUGINS ["plugins/* — replaceable behavior"]
    APILOOP["executor-api-loop<br/>model/tool loop"]
    PROV["provider-anthropic/openai/ollama"]
    MCP["mcp-client<br/>T1 tool servers"]
    subgraph MEMPKG ["memory"]
      MEMBIZ["store · projector · tools<br/>(business logic)"]
      KNOW["knowledge.ts + surreal.ts<br/>Surreal data-access service"]
    end
  end

  subgraph PROJ ["packages/vault-projector"]
    VP["index.ts + render.ts<br/>markdown/mermaid views"]
  end

  subgraph STORES ["databases & files"]
    PG[("Postgres<br/>events + operations<br/>(canonical, per project)")]
    DBOSDB[("Postgres<br/>DBOS system db<br/>(per project)")]
    SUR[("SurrealDB<br/>knowledge read model<br/>(db per project)")]
    VAULT[("vault/ markdown<br/>human projection")]
  end

  BIN --> MAIN
  BIN --> RUNTIME
  MAIN --> KAPI
  RUNTIME --> PORT
  RUNTIME --> VP
  RUNTIME --> MEMBIZ
  RUNTIME --> HOST

  KAPI --> LOG
  PORT --> LOG
  PORT --> JOURNAL
  PORT --> ART
  PORT --> ROUTER
  PORT --> APILOOP
  APILOOP --> PROV
  APILOOP --> MCP
  APILOOP -->|"ctx.operation / ctx.checkpoint"| PORT
  HOST --> TRUST
  HOST --> SKILLS

  LOG --> PGSTORE
  JOURNAL --> PGSTORE
  JOURNAL --> LOG
  PGSTORE --> REDACT
  PGSTORE --> MIG
  PGSTORE --> PG
  PORT --> DBOSDB
  ROUTER --> LOG
  VP --> LOG
  VP --> VAULT
  MEMBIZ --> LOG
  MEMBIZ --> KNOW
  MEMBIZ --> VAULT
  KNOW --> SUR

  KERNEL -.->|imports| CONTRACTS
  PLUGINS -.->|imports| CONTRACTS
  PROJ -.->|imports| CONTRACTS
```

### Legend

| Notation | Meaning |
|---|---|
| Rectangle | First-party module (file named in the node) |
| Nested box | The data-access service inside its package (`storage/`, memory's `knowledge.ts`) |
| Cylinder | A database or file store. **Postgres events is truth**; the rest are index or projection |
| Solid arrow | Runtime call / data flow direction |
| Dashed arrow | Compile-time dependency only (imports types/schemas, never calls back) |

## System map — three tiers

The same system as three layers: business logic never touches a database — every read and
write crosses the **data-access service layer** in the middle. One service per store, each
encapsulating connection, project scoping, locking/transactions, and redaction. Swap a
backend or add a store and only its service changes; the tiers above and below do not.

```mermaid
graph TD
  subgraph APP ["① Application — business logic (never touches a DB directly)"]
    direction LR
    CLI["packages/cli<br/>bin · main · runtime"]
    KRN["packages/kernel<br/>task/plan API · fold · DBOS port · signal router · trust"]
    MEMBIZ["plugins/memory<br/>gateway · projector · tools · ranking"]
    VPBIZ["packages/vault-projector<br/>markdown/mermaid renders"]
    PLG["plugins/*<br/>executor-api-loop · providers · mcp-client"]
  end

  subgraph SVC ["② Data-access service layer — one service per store, DB mechanics encapsulated"]
    direction LR
    PGSVC["Postgres service · openStorage()<br/>EventLog · OperationJournal<br/>PostgresStore: pool · project lock · redaction · assertMigrated"]
    KNSVC["Knowledge service · openKnowledge()<br/>SurrealMemory: notes · typed edges · cursor<br/>project-derived database boundary"]
    VWSVC["Vault writer<br/>atomic markdown writes (containment-guarded)"]
  end

  subgraph DBS ["③ Databases & files"]
    direction LR
    PG[("Postgres<br/>events + operations<br/>canonical, per project")]
    SUR[("SurrealDB<br/>knowledge read model<br/>db per project")]
    VLT[("vault/ markdown<br/>human projection")]
    DBOS[("Postgres<br/>DBOS system db<br/>per project")]
  end

  CLI --> KRN
  CLI --> MEMBIZ
  CLI --> VPBIZ
  PLG --> KRN

  KRN -->|read + write events & operations| PGSVC
  MEMBIZ -->|event-first note writes| PGSVC
  MEMBIZ -->|read + write knowledge| KNSVC
  MEMBIZ -->|memory md| VWSVC
  VPBIZ -->|read + subscribe| PGSVC
  VPBIZ -->|task md| VWSVC

  PGSVC --> PG
  KNSVC --> SUR
  VWSVC --> VLT
  KRN -. DBOS SDK owns its own store .-> DBOS

  classDef svc fill:#1a4d7a,color:#fff
  class PGSVC,KNSVC,VWSVC svc
```

### Legend

| Notation | Meaning |
|---|---|
| **① / ② / ③** | The three tiers: application → data-access services → databases |
| Blue box (tier ②) | A data-access service — the only code that opens/queries its store |
| Cylinder (tier ③) | A database or file store. **Postgres events is truth**; the rest are index or projection |
| Solid arrow | Runtime call / data flow (every app→DB edge passes through a service) |
| Dashed arrow | DBOS SDK manages its own system database — the one store not behind our services |

The layer is realized as sibling openers, each returning a facade whose methods are the whole
contract — callers never see a pool, a lock, or a query:

- **`openStorage(url, { projectId })` → `Storage { events, operations }`** — the Postgres
  service (`packages/kernel/src/storage/`). `PostgresStore` owns the pool, the per-project
  advisory lock, redaction, and schema verification; `EventLog` (append/subscribe/query) and
  `OperationJournal` (before/after nodes) sit on top. Migration is a separate explicit
  `orc db migrate` step — `openStorage` only verifies and fails loudly if the schema is behind.
- **`openKnowledge(config)` → `Knowledge`** — the SurrealDB service
  (`plugins/memory/src/knowledge.ts`), encapsulating auth and the project-derived database
  name. The memory gateway/projector/tools read and write through it and never open a Surreal
  session themselves.

The kernel is business logic and stays free of both: it takes an `EventLog`, not a pool. The
memory plugin's `createMemory` is the orchestrator that assembles the two services into the
memory domain services. The one exception drawn dashed: the DBOS SDK manages its own system
database directly (durable workflow checkpoints), which is not ours to mediate.

Dependency rule (`docs/EXTENDING.md` invariant 3): **contracts import nothing**, kernel
imports contracts, plugins import contracts (never the kernel's internals beyond its public
exports), and the kernel never imports plugins — it receives them (`createDbosPort(opts)`,
`createPluginHost(config, seed)`).

## The storage service — read/write boundary

Every Postgres read and write goes through one facade. Callers never touch a pool, a lock,
redaction, or migrations — they call `events` / `operations` and the service handles the rest.

```mermaid
graph LR
  subgraph APP ["application — never touches the DB directly"]
    K["kernel.ts"]
    MEM["memory store"]
    VPR["vault projector"]
    RTR["signal router"]
    PRT["DBOS port"]
  end

  OPEN(["openStorage(url, projectId)"])

  subgraph SVC ["Storage facade"]
    direction TB
    EV["events : EventLog<br/>append · subscribe · byTask · after · countAfter"]
    OPJ["operations : OperationJournal<br/>begin · complete · fail · rebuild · operationsFor"]
  end

  subgraph OWNER ["PostgresStore — the sole owner"]
    direction TB
    POOL["pg pool"]
    LOCK["withProjectLock (per-project advisory lock)"]
    RED["redact (keys + values)"]
    VER["assertMigrated (verify, never migrate)"]
  end

  DB[("Postgres<br/>events + operations tables<br/>scoped by project_id")]

  K -->|read + write events| EV
  MEM -->|write events| EV
  VPR -->|read + subscribe| EV
  RTR -->|read + write| EV
  PRT -->|"read/write events"| EV
  PRT -->|"journal begin/complete/fail"| OPJ

  OPEN -.builds.-> EV
  OPEN -.builds.-> OPJ
  OPJ -->|"transitions append through"| EV
  EV --> OWNER
  OPJ --> OWNER
  OWNER --> DB

  classDef facade fill:#1a4d7a,color:#fff
  classDef owner fill:#5a3d7a,color:#fff
  class EV,OPJ facade
  class POOL,LOCK,RED,VER owner
```

Every write path is one locked transaction: `EventLog.append` acquires the project lock,
jsonb-shapes and redacts the payload, validates it, inserts, `pg_notify`s, and commits — all
atomically. `OperationJournal` writes its node and its transition events *through* that same
`EventLog` inside one lock, so the durable graph node and the append-only history can never
disagree. Reads are project-scoped queries that bypass the lock. Migration is separate
(`orc db migrate` → `migrateDatabase`); `openStorage` only verifies and fails loudly if the
schema is behind. Missing migration tables map to 0 applied; connection/auth/permission errors
remain their original failures.

## Execution flow — one step, durably

```mermaid
sequenceDiagram
  participant U as User (CLI)
  participant K as Kernel
  participant D as DBOS port
  participant X as api-loop executor
  participant L as EventLog (Postgres)
  participant M as Model/Tool

  U->>K: orc run <task>
  K->>D: startRun (deterministic workflow id)
  D->>L: run_started + status→running (idempotent keys)
  D->>X: startTurn(ctx)
  loop each iteration
    X->>D: ctx.operation(spec, fn)
    D->>L: beginOperation → operation_started + journal row (BEFORE the effect)
    D->>M: fn() — the external call
    D->>L: completeOperation → operation_completed + agent_call/tool_* (ONE transaction)
  end
  X->>D: signal(success, outputs)
  D->>D: verifyArtifacts(workspace, outputs)
  D->>L: artifact_produced* + step_completed (ONE transaction)
  L-->>U: live tail via LISTEN/NOTIFY subscription
```

A crash between `operation_started` and completion leaves an **unresolved node** — visible in
`orc status`, `orc replay`, and `vault/tasks/<id>/execution.md`. Recovery reuses completed
journal nodes and re-attempts unresolved ones as explicitly at-least-once (attempts counted).

## Feedback delivery and grounded approval

`feedback_provided` is both audit history and the durable outbox. The event carries the requesting
step/run envelope; immediate delivery and the signal router use `feedback:<event-seq>` as DBOS's
idempotency key. The live router handles new events, and startup replays replies for still-running
tasks, healing a crash after append but before send.

For a grounded plan step, an exact normalized `approve` reply also stores SHA-256 of the canonical
plan-note graph. `finalize_plan` recomputes that hash and accepts only a human approval from the same
run token. Missing, cross-attempt, or stale approval returns a tool error before any child split.

## Responsibilities

| Component | Owns | Explicitly does NOT own |
|---|---|---|
| `contracts` | Zod schemas, event kinds + typed payloads, executor/port/store interfaces, the workspace containment guard | Any I/O, any storage, any policy |
| `kernel/storage/postgres` | The one Postgres owner: pool, project-scoped advisory lock (`withProjectLock`), redaction wiring, schema verification | Deciding *what* to store; the DBOS system database |
| `kernel/storage/event-log` | Project-bound append (jsonb-shape → redact → validate → insert → notify, one locked transaction), idempotency keys, lossless subscribe with reconnect, scoped queries + `countAfter` | Deciding *what* to append (callers do), projections |
| `kernel/storage/operation-journal` | Durable before/after nodes (begin/complete/fail), rebuild-from-log; transitions append through the `EventLog` in the same locked transaction | Model/tool specifics; the checkpoint machinery (that's the port) |
| `kernel/storage/migrate` | Explicit `migrateDatabase`; `assertMigrated` fails loudly when a database is behind | Migrating implicitly at open time |
| `kernel/redact` | The single storage-boundary normalizer: NUL strip + secret redaction (keys and values) | Being called anywhere except append/journal storage |
| `kernel/projections` | `fold(events) → State`, `applyOperationEvent` (shared by live journal and rebuild), crash dedup | Persisting anything |
| `kernel/kernel.ts` | Atomic task/plan lifecycle, feedback outbox events, plan-hash-bound human approval over the log | Execution |
| `kernel/dbos-port` | Durable run/step workflows, `ctx.checkpoint` and `ctx.operation` wrappers, retry policy, queue partitioning, cancellation cascade, output receipt commit | Model/tool specifics (executor's job), plan authoring |
| `kernel/signal-router` | Resolving splits, starting approved children, and live/startup delivery of committed feedback | Composing plans, executing steps |
| `kernel/plugins/*` | Registry + propose-time ref validation (`host`), fingerprint trust store (`trust`), SKILL.md indexing (`skills`), T2 extension loading | Runtime tool execution (that's the hub/executor) |
| `plugins/executor-api-loop` | The model⇄tool loop, prompt assembly (incl. knowledge protocol), signal/output pre-flight, per-call operation journaling | Durability (delegates to ctx), trust, receipts |
| `plugins/memory` | Event-first note store (gateway stamps git revision), transactional Surreal projection, per-project database boundary, knowledge tools + degraded variants, `vault/memory/**` rebuild | Being authoritative — Surreal and vault/memory are disposable |
| `packages/vault-projector` | Deterministic markdown/mermaid renders of tasks, execution, lineage, task expansion; coalesced live re-render | Truth of any kind; whole-log scans |
| `packages/cli` | Pre-bootstrap help/init/migrate, command surface, project discovery, startup/shutdown order, degraded-memory wiring | Business rules (kernel's job) |

## Identity and isolation

`orc init` mints `projectId` into the committable `.orc/config.json`. Everything derives:

- events/operations rows carry `project_id`; every query filters on it
- the per-project advisory lock serializes writers within a project only
- DBOS system database name = `deriveSystemUrl(dbUrl, projectId)`
- SurrealDB database name = `projectDatabaseName(base, projectId)`
- `requireProject(config)` gates project commands; uninitialized directories can still run
  help, `orc db migrate`, and `orc init`
- `orc init` seeds the first-party analysis/plan/documentation skills without overwriting project files
