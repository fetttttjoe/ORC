# Architecture

One paragraph of ground truth: the Postgres **event log is the only truth**. Every other
store — the operations journal, SurrealDB, the vault, DBOS's system database — is either a
rebuildable index over that log or a disposable projection of it. All state is `fold(events)`.
Everything below is arranged around protecting that invariant.

## System map

```mermaid
graph TD
  subgraph CLI ["packages/cli — entrypoint & wiring"]
    BIN["bin.ts<br/>process entry, init gate"]
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
    subgraph STORAGE_SVC ["storage/ — the Postgres service layer"]
      PGSTORE["postgres.ts<br/>PostgresStore: pool, project lock, redaction"]
      LOG["event-log.ts<br/>EventLog: append/subscribe/query"]
      JOURNAL["operation-journal.ts<br/>OperationJournal: before/after nodes"]
      MIG["migrate.ts<br/>explicit migrate + assertMigrated"]
    end
    REDACT["redact.ts<br/>storage-boundary normalizer"]
    FOLD["projections.ts<br/>fold, applyOperationEvent"]
    KAPI["kernel.ts<br/>task/plan API"]
    PORT["execution/dbos-port.ts<br/>durable workflows"]
    ART["execution/artifacts.ts<br/>verifyArtifacts receipts"]
    ROUTER["execution/signal-router.ts<br/>split resolution"]
    HOST["plugins/host.ts<br/>registry + refValidator"]
    TRUST["plugins/trust.ts<br/>fingerprint grants"]
    SKILLS["plugins/skills.ts<br/>SKILL.md index"]
  end

  subgraph PLUGINS ["plugins/* — replaceable behavior"]
    APILOOP["executor-api-loop<br/>model/tool loop"]
    PROV["provider-anthropic/openai/ollama"]
    MCP["mcp-client<br/>T1 tool servers"]
    MEMPLUG["memory<br/>store, projector, tools"]
  end

  subgraph PROJ ["packages/vault-projector"]
    VP["index.ts + render.ts<br/>markdown/mermaid views"]
  end

  subgraph STORES ["storage"]
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
  RUNTIME --> MEMPLUG
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
  MEMPLUG --> LOG
  MEMPLUG --> SUR
  MEMPLUG --> VAULT

  KERNEL -.->|imports| CONTRACTS
  PLUGINS -.->|imports| CONTRACTS
  PROJ -.->|imports| CONTRACTS
```

### Legend

| Notation | Meaning |
|---|---|
| Rectangle | First-party module (file named in the node) |
| Cylinder | Storage. **Postgres events is truth**; everything else is index or projection |
| Solid arrow | Runtime call / data flow direction |
| Dashed arrow | Compile-time dependency only (imports types/schemas, never calls back) |
| Subgraph box | One workspace package (or, nested, the storage service layer) |

**The storage service layer** (`packages/kernel/src/storage/`) is the single owner of every
Postgres access. `openStorage(url, { projectId })` returns a `Storage` facade with two
services — `events` (the `EventLog`: append / subscribe / query) and `operations` (the
`OperationJournal`: durable before/after nodes). Both sit on one `PostgresStore`, which owns
the connection pool, the per-project advisory lock, and secret redaction. No other module
opens a connection, takes the lock, or migrates. Consumers that only read/write events (the
kernel, memory store, vault projector) take the `EventLog`; the DBOS port, the one consumer
that needs both, takes the whole `Storage`. Migration is an explicit step (`migrateDatabase`
in test/CLI setup) — `openStorage` only *verifies* the schema and fails with guidance if the
database is behind, never mutating it as an open-time side effect.

Dependency rule (enforced by convention, `docs/EXTENDING.md` invariant 3): **contracts import
nothing**, kernel imports contracts, plugins import contracts (never the kernel's internals
beyond its public exports), and the kernel never imports plugins — it receives them
(`createDbosPort(opts)`, `createPluginHost(config, seed)`).

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
(`migrateDatabase`); `openStorage` only verifies and fails loudly if the schema is behind.

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
| `kernel/kernel.ts` | Task/plan lifecycle API (create, propose, approve, cancel semantics) over the log | Execution |
| `kernel/dbos-port` | Durable run/step workflows, `ctx.checkpoint` and `ctx.operation` wrappers, retry policy, queue partitioning, cancellation cascade, output receipt commit | Model/tool specifics (executor's job), plan authoring |
| `kernel/signal-router` | Resolving splits when children reach terminal state; starting approved child runs | Composing plans, executing steps |
| `kernel/plugins/*` | Registry + propose-time ref validation (`host`), fingerprint trust store (`trust`), SKILL.md indexing (`skills`), T2 extension loading | Runtime tool execution (that's the hub/executor) |
| `plugins/executor-api-loop` | The model⇄tool loop, prompt assembly (incl. knowledge protocol), signal/output pre-flight, per-call operation journaling | Durability (delegates to ctx), trust, receipts |
| `plugins/memory` | Event-first note store (gateway stamps git revision), transactional Surreal projection, per-project database boundary, knowledge tools + degraded variants, `vault/memory/**` rebuild | Being authoritative — Surreal and vault/memory are disposable |
| `packages/vault-projector` | Deterministic markdown/mermaid renders of tasks, execution, lineage, task expansion; coalesced live re-render | Truth of any kind; whole-log scans |
| `packages/cli` | Command surface, startup order (projections before DBOS), degraded-memory wiring, project identity gate | Business rules (kernel's job) |

## Identity and isolation

`orc init` mints `projectId` into the committable `.orc/config.json`. Everything derives:

- events/operations rows carry `project_id`; every query filters on it
- the per-project advisory lock serializes writers within a project only
- DBOS system database name = `deriveSystemUrl(dbUrl, projectId)`
- SurrealDB database name = `projectDatabaseName(base, projectId)`
- `requireProject(config)` is the one gate: production paths take a `ProjectConfig`, and an
  uninitialized directory can only run `orc init`
