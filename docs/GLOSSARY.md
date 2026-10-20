# Glossary

Key terms used throughout the orchestrator codebase and documentation. Most terms link to where they are
explained in full.

---

## A

### Anchor

The code a [claim](#claim) is about: a path relative to the repository root, optionally at one
symbol (`path#Name`, where a name is the dotted chain of the definitions that contain it, e.g. `EventLog.append`).
A claim has up to 8; the first decides its [bucket](#bucket). A claim's [state](#claim-state) compares each
anchor's code now with its code at the claim's [basis](#basis). See [anchors and
symbols](knowledge-files.md#anchors-and-symbols).

### Approval

Human gate that permits execution to proceed. There are two, and they write different events: the
ordinary gate (`orc approve <taskId>`) appends `plan_approved` and hashes nothing; the grounded-plan gate
(`orc reply <taskId> approve`) additionally stamps a SHA-256 of the task's canonical plan notes onto
`feedback_provided`, recording what was approved and when. `finalize_plan` freezes the plan only if no plan note
was written after that approval's seq. See [feedback delivery and grounded
approval](ARCHITECTURE.md#feedback-delivery-and-grounded-approval), [both gates side by
side](seams-reference.md#scenario-2-a-plan-is-approved-by-a-human).

### Artifact

Output file produced by a step, declared in the step's `signal(success, outputs: [...])` call.
The port's trusted finish checkpoint hashes it itself and records a SHA-256 receipt (`artifact_produced`) in the
same transaction as `step_completed`. See [the receipt path](seams-reference.md#scenario-5-an-artifact-is-produced-its-receipt-is-verified),
[`vault/tasks/<id>/lineage.md`](../README.md#vault-views).

### Audit replay

Deterministic reconstruction of any historical state by folding events up to a given
sequence. See [`orc replay`](../README.md#quickstart), [the guarantee](../README.md#guarantees-stated-precisely),
[execution flow](ARCHITECTURE.md#execution-flow-one-step-durably).

---

## B

### Basis

The commit `git blame` names for a claim's own line in its bucket: the code the claim was last
written against. A line not yet committed has the working tree as its basis. The basis is read from git on every
drift read; nothing stores it. See [the four claim states](knowledge-files.md#the-four-claim-states).

### Brief

What a new session is told about a project before it has asked anything: the workspace the directory
is, with its [health](#workspace); tasks awaiting approval, running or blocked (capped per status, this checkout's
first); accepted [decisions](#decision), title plus one line, capped; and knowledge health (claims and suspect
count). `orc brief` prints it (`--json` for the parsed shape). The Claude Code plugin's `SessionStart` hook
injects it into every session. Decisions that cannot be read print as unknown, never as none. See [`Brief`
schema](../packages/contracts/src/brief.ts), [selection and rendering](../packages/cli/src/brief.ts), [the
reads](../packages/cli/src/brief-gather.ts), [the hook](../plugin/hooks/session-start.sh).

### Bucket

One Markdown file of [claims](#claim) inside a package's knowledge folder: `## Facts` and `## Why`
sections of one-line claims under a `# title`. A claim's bucket is computed from its first anchor, never chosen.
See [where a claim lives](knowledge-files.md#where-a-claim-lives).

---

## C

### Checkpoint

DBOS-managed durable state across step retries. Distinct from [operation](#operation), which
journals external calls. See [execution flow](ARCHITECTURE.md#execution-flow-one-step-durably), [the DBOS port
invariant](EXTENDING.md#invariants-the-rules-that-keep-changes-cheap).

### Claim

One line of project knowledge in a [bucket](#bucket): a standalone sentence of class `fact` (what the
code does now) or `why` (the reason it is that way), with an 8-character id, up to 8 [anchors](#anchor), tags,
sources, and an optional link to a [decision](#decision). Written through the [knowledge port](#knowledge-port)
as a patch that adds, changes (same id) or retires claims. See [claims](ARCHITECTURE.md#claims), [the claim
line](knowledge-files.md#the-claim-line), [`knowledge.ts`](../packages/contracts/src/knowledge.ts).

### Claim state

Whether a claim still describes its code: `clean`, `suspect`, `unknown` or `unanchored`
(`ClaimState`). Judged per anchor from the anchor's digest now, at the [basis](#basis), and in the
[evidence](#evidence); the claim takes the worst of its anchors. `orc knowledge drift` lists the claims that are
not clean. See [the four claim states](knowledge-files.md#the-four-claim-states),
[`claim-state.ts`](../packages/contracts/src/claim-state.ts).

### Contracts

`packages/contracts/`, the package holding Zod schemas and interface definitions (no runtime I/O,
no policy). Imported by the kernel, `knowledge-core` and the plugins; the kernel never imports a plugin. See [the
dependency rule](EXTENDING.md#invariants-the-rules-that-keep-changes-cheap).

---

## D

### Data-access service

The one module that opens and queries a store: the Postgres service (`openStorage`), the
[knowledge backend](#knowledge-backend) (files in the git working tree), and the vault writer. It sits in tier ②
between application (tier ①) and the stores (tier ③). See [system map: three
tiers](ARCHITECTURE.md#system-map-three-tiers), [the storage
service](ARCHITECTURE.md#the-storage-service-the-readwrite-boundary).

### DBOS

DBOS Transact, the durable-workflow library orc runs on, backed by its own Postgres system database
per project. Orc uses it for run and step workflows, checkpoints and retry-safe execution. See [the
stack](../README.md#stack), [workflow recovery](../README.md#guarantees-stated-precisely).

### Decision

Architectural choice kept as a Markdown file `docs/decisions/<yyyy-mm-dd>-<slug>.md`: frontmatter
`status` (`proposed | accepted | superseded | deprecated`), optional `tags`, `supersedes` and `supersededBy`, a
`# title`, and the sections Context, Decision, Consequences and optionally Considered. Recorded by `orc adr new`
or the `record_decision` tool through the knowledge port; changed only by supersession: the new file names
`supersedes`, and the old one is marked `superseded` with `supersededBy`. See [decision
files](knowledge-files.md#decision-files), [`decision-format.ts`](../plugins/knowledge-git/src/decision-format.ts),
[`decision.ts`](../packages/contracts/src/decision.ts).

### Delivery

The fact that a card, search, get, at-risk push or step preload handed claims to someone, recorded
as `knowledge_delivered` with the ids and the mode. Part of the [evidence](#evidence); `orc knowledge stats`
reports on it. See [provenance](ARCHITECTURE.md#provenance).

### Deterministic

Guaranteed to produce identical output given identical inputs, *for a given build*. Applied
to vault projections (same events → same markdown), the event-log fold (same events → same state), and the plan
freeze (same plan notes → same executable plan). A derivation that serializes parsed records is deterministic
with respect to its inputs AND the schema the running build parses them with, so two processes on different
builds may disagree, which is why nothing compares such a value across a process boundary. See [vault
projections](seams-reference.md#vault-projections-read-only-human-views).

### Drift

A claim's anchored code having moved since the claim was written or confirmed; what makes a claim
`suspect`. `orc knowledge drift` reports it and never fails; the commit reactor drafts a sweep for it. See [where
knowledge goes stale](ARCHITECTURE.md#where-knowledge-goes-stale-and-what-closes-it).

---

## E

### Event

Immutable fact appended to the event log. Has a `kind` (enum), a `payload` (Zod-validated JSON) and a
sequence number. Folds to state; never mutated; survives replays. See [the
architecture](ARCHITECTURE.md), [`EventKind`](../packages/contracts/src/event-kinds.ts), [the
fold](../packages/kernel/src/projections.ts).

### Event log

The Postgres `events` table (project-scoped): the one record of what happened. Appended via
`EventLog.append()` under the per-project advisory lock; read by subscriptions, replay, the vault projector and
the knowledge evidence reader. See [the storage service](ARCHITECTURE.md#the-storage-service-the-readwrite-boundary).

### Evidence

What the log knows about claims: the anchor digests writes asserted (`knowledge_written`), the
digests `holds` checks confirmed and the verdicts (`knowledge_checked`), and the deliveries
(`knowledge_delivered`). Folded by `foldEvidence`, a pure function with zero imports. A log reset loses only the
evidence, never a claim. See [claim state](ARCHITECTURE.md#claim-state-drift-and-evidence),
[`evidence.ts`](../packages/knowledge-core/src/evidence.ts).

### Executor

Agent framework that loops model and tool calls until `signal(success)` or a terminal error.
Injected at `createDbosPort()`. Default: `executor-api-loop`. See [the executor
interface](../packages/contracts/src/execution.ts), [`executor-api-loop`](../plugins/executor-api-loop/), [how to
add one](EXTENDING.md#where-a-change-goes).

---

## F

### Feedback

A human reply to a step's question, including the plan-approval reply of a grounded task. Carries
the asking step's task/run envelope, and its event is the durable outbox for delivery. See [feedback
delivery](ARCHITECTURE.md#feedback-delivery-and-grounded-approval), [the human
gate](EXTENDING.md#invariants-the-rules-that-keep-changes-cheap).

### Fingerprint

Digest of what a trust grant consented to (for MCP: command, args and env names; for
extensions: entry, resolved local imports and `bun.lock`). The binding behind `orc mcp trust` and
`orc ext trust`. See [operational notes](../README.md#operational-notes), [declare vs
grant](EXTENDING.md#invariants-the-rules-that-keep-changes-cheap).

### Finish step

Kernel-appended step (role `finisher`) ending every root plan except the grounded scaffold and
the auto-heal sweep, and every frozen grounded pipeline. Reconciles the claims the task recorded (`task_claims`),
drafts a decision if the task made one, and asks once; an approval word records the decision (if any) and
completes the task. Gated by `stepMayReconcile`, which keys on both step id and role so a planner-authored step
merely named `finish` cannot arm it. See [the `role-finisher` skill](../vault/skills/role-finisher/SKILL.md),
[`stepMayReconcile`](../packages/contracts/src/plan.ts), [execution
flow](ARCHITECTURE.md#execution-flow-one-step-durably).

### Fold

Pure function `fold(events[]) → State`, deterministically reconstructing a snapshot at any point.
Folding the same events twice yields identical state. See [the fold](../packages/kernel/src/projections.ts),
[responsibilities](ARCHITECTURE.md#responsibilities).

---

## G

### Graph UI

The web console over a project's task and execution graph. Served by `orc graph` on
`http://127.0.0.1:7749`, bound to localhost only. Launched inside a project with a live runtime behind it, it
serves CSRF-token-guarded mutations and the copilot alongside the graph, both fenced to the home project. Door #1
of the two-doors model. See [operational notes](../README.md#operational-notes),
[adapters](ARCHITECTURE.md#adapters-two-doors-over-one-transport-free-core).

---

## H

### Hook bus

Async event subscription mechanism for plugins and extensions. Detached from the event
transaction, and subscribers are drained before deactivation. See [T2
extensions](EXTENDING.md#where-a-change-goes), [`HookBus`](../packages/kernel/src/plugins/hooks.ts).

---

## I

### Idempotency key

Deterministic, unique key for an append or an operation. A crash mid-operation re-attempts
under the same key without duplication, and a replayed key with different data is refused. See [the resume
guarantee](../README.md#guarantees-stated-precisely), [the EventLog
interface](seams-reference.md#eventlog-interface-storageevents).

### Index

A human projection in the vault summarizing a structure: `vault/index.md` holds the task-expansion
graph and every task's status. Deterministic, rebuilt on data changes. Not a database index. See [vault
projections](seams-reference.md#vault-projections-read-only-human-views).

### Isolation

Execution boundary for a step, declared in the plan step's `isolation` field (`IsolationTier`).
See [the plan schema](../packages/contracts/src/plan.ts).

---

## K

### Kernel

`packages/kernel/`, the policy-free core: task and plan lifecycle, feedback gates, the fold, the
storage facades, the DBOS port, signal routing. Imports only `contracts`; receives plugins. See [kernel
responsibilities](ARCHITECTURE.md#responsibilities).

### Knowledge backend

The plugin that reads and writes the [knowledge files](#knowledge-files)
(`KnowledgeBackend`), chosen by `knowledge.plugin` in `.orc/config.json`; the default is `git-files`
(`plugins/knowledge-git`). It never appends events. Every backend passes the shared contract suite. See [the port
and the backend](ARCHITECTURE.md#the-port-and-the-backend).

### Knowledge files

What the project holds true about its code, kept in the repository: [buckets](#bucket) of
[claims](#claim) and [decision](#decision) files, reviewed, branched and merged with the code. See
[knowledge-files.md](knowledge-files.md).

### Knowledge port

`KnowledgePort`, the one interface every consumer reads and writes knowledge through: card,
search, get, write, drift, check, preload and the decision calls. `createKnowledgePort` implements it over any
backend and appends one [evidence](#evidence) event per act; it never touches a file. See [the port and the
backend](ARCHITECTURE.md#the-port-and-the-backend), [`port.ts`](../packages/knowledge-core/src/port.ts).

---

## L

### Lineage

Artifact provenance: which step produced which output, with its SHA-256 receipt. Viewable in
`vault/tasks/<id>/lineage.md`. See [the receipt path](seams-reference.md#scenario-5-an-artifact-is-produced-its-receipt-is-verified),
[the output lineage guarantee](../README.md#guarantees-stated-precisely).

---

## M

### MCP

Model Context Protocol. An external tool server, declared in `.orc/config.json`, armed with
`orc mcp trust` (a fingerprint grant), and referenced in plans via `toolRefs`. orc also serves itself over MCP
(`orc mcp serve`, door #2). See [operational notes](../README.md#operational-notes),
[`mcp-client`](../plugins/mcp-client/), [the trust model](EXTENDING.md#invariants-the-rules-that-keep-changes-cheap).

### Mutation

A write: appending an event, approving a plan, recording a claim. Only available when the CLI runs
inside a project (CSRF-token guarded for the web). See [the CLI entry point](../packages/cli/src/bin.ts),
[adapters](ARCHITECTURE.md#adapters-two-doors-over-one-transport-free-core).

---

## O

### Operation

External call (model, tool, side effect) with a durable before/after journal record. Distinct from
[checkpoint](#checkpoint) (DBOS-managed state). See [the operation
journal](ARCHITECTURE.md#the-storage-service-the-readwrite-boundary),
[`ctx.operation` in dbos-port](../packages/kernel/src/execution/dbos-port.ts).

### Operation journal

The Postgres `operations` table, rebuildable from events. Records `operation_started`
BEFORE the external call and completion or failure AFTER. A crash leaves an unresolved node. See [the operation
journal](ARCHITECTURE.md#the-storage-service-the-readwrite-boundary), [`orc status`](../README.md#quickstart).

### Operator state

Everything a project has waiting on a human, folded server-side from the whole log into one
value: open questions still owed an answer (`openQuestions`, keyed by task and topic, withdrawn once the task is
terminal), retryable tasks (the kernel's own `canRetry` predicate), and tasks with a plan worth showing
(`planned`). Answered by the `operatorState` view and pushed on the SSE stream's `operator` field rather than
fetched: it changes on almost every append, so a client holds the last non-null value instead of refetching one.
See [the read side](ARCHITECTURE.md#the-read-side-the-view-registry),
[`operator-state.ts`](../packages/ui-core/src/views/operator-state.ts).

---

## P

### Plan

Structured task decomposition: a list of steps, each with role, title, instructions, skill and tool
refs, executor, model and dependencies. A grounded plan is derived from its approved [plan notes](#plan-note) at
the freeze, which is refused if they moved after the approval. See [the plan
schema](../packages/contracts/src/plan.ts).

### Plan note

One note of a grounded task's plan, written by the plan step with `plan_note_write` and stored as a
`plan_note_written` event on the task (the latest write per id is the note). The `masterplan` note lists its
`subplans` in step order; each subplan carries the body, `rationale`, `dependsOn`, `zone`, `uncertainty`,
capability refs and the `modelRef` its frozen step gets. See [`plan-note.ts`](../packages/contracts/src/plan-note.ts).

### Plugin

Replaceable behaviour: executor, provider, tool server, extension, knowledge backend. Executors and
providers are registered via `seedRegistries` and opted into via plan refs; the knowledge backend is chosen in
config. See [the plugin registry](../packages/kernel/src/plugins/host.ts), [the seam
map](EXTENDING.md#where-a-change-goes).

### Project

A git repository under orc: an isolated execution context with its own identity, event log,
operations and vault, and its knowledge files in the repository. Identity lives in the main checkout's
`.orc/identity.json`; every worktree of the repository resolves to the same project. One project spans many
[workspaces](#workspace), the checkouts it is worked in, each adopted on first use. Set via `orc init --name`. See
[identity and isolation](ARCHITECTURE.md#identity-and-isolation), [the quickstart](../README.md#quickstart).

### Projector

The vault projector: it subscribes to the event log and re-renders the vault's markdown for each
task an event names. See [`vault-projector`](../packages/vault-projector/), [vault
projections](seams-reference.md#vault-projections-read-only-human-views).

---

## R

### Redaction

Stripping secrets and configured sensitive keys and values at the Postgres storage boundary
(never in flight). See [the redaction guarantee](../README.md#guarantees-stated-precisely), [the redaction
service](../packages/kernel/src/redact.ts), [`redactEnv`](../packages/kernel/src/config.ts).

### Replay

Deterministic recreation of state at any historical sequence. See [`orc replay`](../README.md#quickstart),
[audit replay](#audit-replay).

---

## S

### Scope

What a read is about: the project, a workspace, a task (with or without its subtree) or a chat
(`Scope`, discriminated by `ScopeType`). `inScope` is the one rule deciding which events a scoped read sees. See
[the read side](ARCHITECTURE.md#the-read-side-the-view-registry), [`scope.ts`](../packages/contracts/src/scope.ts).

### Seam

An extension point defined in `packages/contracts/`. Examples: `ModelProvider`, `AgentExecutor`,
`KnowledgeBackend`, event kinds, config keys. See [the seam map](EXTENDING.md#where-a-change-goes), [the seams
reference](seams-reference.md).

### Signal

Step completion message: `signal(success, outputs)` or `signal(failure, error)`. Triggers artifact
verification and the step's completion events. See [`execution.ts`](../packages/contracts/src/execution.ts),
[execution flow](ARCHITECTURE.md#execution-flow-one-step-durably).

### Skill

Agent procedure, no code. Defined in `vault/skills/<name>/SKILL.md`, hot-indexed, and force-loaded via
`skillRefs`. See [the seam map](EXTENDING.md#where-a-change-goes), [skill
indexing](../packages/kernel/src/plugins/skills.ts).

### Split

Recursive task decomposition via the `task_split` tool. One transaction appends `task_created`,
`split_proposed` (on the parent's stream) and `plan_proposed`, plus `plan_approved` when the project's
`approvalPolicy` auto-approves; otherwise the child parks at the human gate. The router starts an approved child;
`split_resolved` carries its outcome, and the claims its subtree recorded, back to the parent's `join_splits`.
There is no split-approval event. See [task split](seams-reference.md#scenario-4-a-task-splits-into-children).

### Storage service

The Postgres data-access facade (`openStorage`): connection, the project lock, redaction
and schema verification behind `EventLog` and `OperationJournal`. See [the storage
service](ARCHITECTURE.md#the-storage-service-the-readwrite-boundary), [tier ②](ARCHITECTURE.md#system-map-three-tiers).

### Supervisor

The process holding the execution runtime for a project (`orc serve`). Presence is a heartbeat
row in `supervisors`, not a lock; identity is a claimed slot id used as the DBOS executor id, so recovery is per
supervisor. Every other command is a client: it appends the ask and watches. See [identity and
isolation](ARCHITECTURE.md#identity-and-isolation), [`serve.ts`](../packages/cli/src/serve.ts), [supervisor
storage](../packages/kernel/src/storage/supervisors.ts).

---

## T

### Task

Top-level work unit. Created via `orc new`, approved via `orc approve`, run via `orc run`. Has a plan
and execution state. Every task names the [workspace](#workspace) it belongs to: a required field, taken from the
checkout it was created in (`--workspace <id>` picks another; a split child inherits its parent's), and its runs
execute there unless `--cwd` overrides. `orc tasks` groups by workspace. See [`TaskNode`](../packages/contracts/src/task.ts),
[the quickstart](../README.md#quickstart).

### Tool

An external capability invoked during step execution, from an MCP server or built in. Opted into via
`toolRefs`. See [MCP](#mcp), [the plan schema](../packages/contracts/src/plan.ts),
[`mcp-client`](../plugins/mcp-client/).

### Trust

Fingerprint-based consent for MCP servers and extensions. Declared in `.orc/config.json`, granted via
`orc mcp trust` / `orc ext trust`, stored in `.orc/trust.json` (under the main checkout, mode 0600, never
committed). See [operational notes](../README.md#operational-notes), [declare vs
grant](EXTENDING.md#invariants-the-rules-that-keep-changes-cheap).

---

## V

### Vault

Deterministic markdown projections of tasks, plans, execution, lineage and step sessions, rebuilt from
the log on every relevant event. `vault/skills/` beside them is authored source, not a projection. See [the vault
views](../README.md#vault-views), [vault projections](seams-reference.md#vault-projections-read-only-human-views).

### View

A named, pure read over the folded project state, declared once on the wire (`ViewName`, `WIRE`: its
own param and result schema) and implemented once as a file under `packages/ui-core/src/views/`. Answered through
one route (`GET /api/view/<name>`) or, for an in-process caller, `viewOf`; a view's own "not found" is `null`,
answered 404. Every view is also a `Touchable`: it reports the param patterns one appended event makes stale,
which the stream carries so a client refetches exactly what an event touched rather than owning a refresh table
of its own. A new read is a new view file, never a route, a client-side filter or a browser fold. See [the read
side](ARCHITECTURE.md#the-read-side-the-view-registry), [`wire.ts`](../packages/ui-core/src/wire.ts),
[`registry.ts`](../packages/ui-core/src/views/registry.ts).

---

## W

### Workflow

DBOS-managed durable execution context for a run or a step. Survives crashes via checkpoints and
the operation journal. See [the DBOS port](../packages/kernel/src/execution/dbos-port.ts), [workflow
recovery](../README.md#guarantees-stated-precisely).

### Workspace

One checkout being worked in: the unit a [task](#task) belongs to, a run executes in, and an
author names. Two kinds: `checkout` (the repository's main checkout, the one holding the identity) and `worktree`
(a linked git worktree, whether `orc ws new` created it or you did). `cwd` (a resolved realpath) is the natural
key: one *active* record per directory, and the first orc command run anywhere adopts that directory, so no
checkout is ever registered by hand. `managed` is true only for a directory orc created and is the fact that
licenses `git worktree remove` (`orc ws archive --remove`, and the removal `orc ws merge` performs). `onTrunk` is
captured at adoption; a checkout that *switches branch* is re-adopted: the old record is archived and a new one
minted for the new branch, carrying over the facts a mint cannot derive (`managed`, `baseBranch`, `kind`).
Knowledge written in a workspace lives in that checkout's files until its branch merges. **Workspace health**
(`dangling` / `waiting` / `active` / `idle` / `merged`) is one derivation over the fold plus two probes (does the
directory exist, is it clean), rendered identically by `orc ws ls`, the `workspace_list` tool and
`project_status`, and stated for the current checkout by the [brief](#brief). See [`Workspace`
entity](../packages/contracts/src/workspace-entity.ts), [lifecycle operations](../packages/cli/src/workspace-ops.ts),
[the `orc ws` surface](../packages/cli/src/ws-commands.ts), [health and
`workspaceByCwd`](../packages/kernel/src/workspaces.ts), [adoption](../packages/cli/src/workspace-adopt.ts),
[Workspaces](../README.md#workspaces).

---

## Z

### Zod

Runtime schema validation library, used for contracts, event payloads and config. See [the
stack](../README.md#stack), [`packages/contracts/`](../packages/contracts/).

---

## Cross-references

### By topic

**Execution**
- [Checkpoint](#checkpoint), [Operation](#operation), [Signal](#signal), [Workflow](#workflow), [Fold](#fold), [DBOS](#dbos)

**Knowledge**
- [Knowledge files](#knowledge-files), [Claim](#claim), [Bucket](#bucket), [Anchor](#anchor), [Claim state](#claim-state), [Basis](#basis), [Evidence](#evidence), [Drift](#drift), [Delivery](#delivery), [Decision](#decision), [Knowledge port](#knowledge-port), [Knowledge backend](#knowledge-backend)

**Architecture**
- [Event](#event), [Event log](#event-log), [Data-access service](#data-access-service), [Kernel](#kernel), [Contracts](#contracts), [Seam](#seam), [Plugin](#plugin), [View](#view), [Scope](#scope), [Operator state](#operator-state)

**Records**
- [Audit replay](#audit-replay), [Lineage](#lineage), [Index](#index), [Vault](#vault)

**Operations**
- [Project](#project), [Workspace](#workspace), [Brief](#brief), [Task](#task), [Plan](#plan), [Plan note](#plan-note), [Split](#split), [Approval](#approval), [Feedback](#feedback), [Finish step](#finish-step), [Artifact](#artifact), [Tool](#tool), [Skill](#skill)

**Infrastructure**
- [MCP](#mcp), [Trust](#trust), [Fingerprint](#fingerprint), [Idempotency key](#idempotency-key), [Redaction](#redaction), [Projector](#projector), [Supervisor](#supervisor)

---

## See also

- [`README.md`](../README.md): quick navigation, guarantees, operational notes
- [`docs/ARCHITECTURE.md`](ARCHITECTURE.md): system map, modules, tiers, invariants
- [`docs/knowledge-files.md`](knowledge-files.md): the knowledge-file format and the claim states
- [`docs/EXTENDING.md`](EXTENDING.md): how to add a seam (provider, executor, backend, skill, tool, event)
- [`docs/seams-reference.md`](seams-reference.md): call paths, debugging strategies, component interactions
- [`docs/IDEAS.md`](IDEAS.md): deferred work with reasoning and triggers
