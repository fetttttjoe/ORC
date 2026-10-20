# orchestrator

You describe a job. The system plans it, you approve the plan, and agents
execute it — splitting into sub-tasks where the work is bigger than one agent,
surviving crashes, and writing down what they learned so the next run starts
smarter.

**→ [Quickstart](#quickstart)** to have it running.

Four properties shape everything else:

- **The event log is the truth.** Every task, plan, model call, tool call and
  knowledge write is an append-only Postgres row. Nothing is derived state you
  cannot rebuild — the markdown vault is a disposable projection, regenerated
  from the log on demand.
- **A human approves the plan.** Agents propose; a person approves; only then
  does anything run. Approval can be delegated to a policy, but never assumed.
- **Runs are durable.** `kill -9` mid-step and the work resumes where it left
  off, without re-billing the model call that already completed.
- **Knowledge is files in the repo.** Agents record atomic *claims* —
  individually addressable statements anchored to code — in
  `<package>/knowledge/*.md`. Git holds what is true about the code; the event
  log records what was handed to agents and what they read. A claim is
  retired by id, and its history is git's.

Adding anything (provider, executor, skill, tool, event kind, …):
[`docs/EXTENDING.md`](docs/EXTENDING.md).

## Where it stands

Working today, in rough order of how much of the system each one touches:

| | |
|---|---|
| **Recursion** | a step splits into child tasks (`task_split`) and rejoins them (`join_splits`); budget is debited from the parent, depth-bounded by policy |
| **Durability** | DBOS Transact workflows over a project-scoped Postgres system database; a model or tool call is journalled before and after, so replay is honest rather than optimistic |
| **Knowledge** | claims in markdown files beside the code they describe — `orc knowledge card/search/add/retire`, anchored to paths and symbols, with a drift verdict (`orc knowledge drift`) that says which claims the code has moved past; format in [`docs/knowledge-files.md`](docs/knowledge-files.md) |
| **Provenance** | web findings land as claims that carry their source URLs rather than pasted pages, output artifacts carry verified receipts, and what knowledge was actually *read* is event-sourced rather than guessed |
| **Workspaces** | one checkout per request: any checkout adopts itself on first use, `orc ws new` makes a worktree + branch for one request, tasks and runs bind to it, and a merge lands its branch on trunk |
| **Isolation** | project identity per repository (every worktree shares it), project-scoped databases, and a runtime lock — two projects on one machine cannot cross-recover each other's work |

Degraded-knowledge tolerant: if the checkout cannot be read, knowledge tools return an
explicit unavailable result with the reason, and everything else keeps working.

## Architecture & Documentation

Start here to navigate the codebase and understand the architectural foundations.

### Quick Navigation

| Topic | Purpose | Where to Find |
|---|---|---|
| **Architecture overview** | System map, data flow, seams, invariants | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modules, tiers, storage service, execution flow |
| **MCP integration** | How `orc mcp serve` and the MCP client plugin work | [`docs/mcp-overview.md`](docs/mcp-overview.md) — both directions: orc as an MCP server, orc as an MCP client |
| **Extension points** | How to add providers, executors, tools, skills, events | [`docs/EXTENDING.md`](docs/EXTENDING.md) — seam map with invariants |
| **Decisions & roadmap** | Architectural decision records and forward-looking work | [`docs/decisions/`](docs/decisions/) (one file per decision, `orc adr ls`) and [`ROADMAP.md`](ROADMAP.md) |
| **Knowledge files** | The claim format, buckets, anchors and drift states | [`docs/knowledge-files.md`](docs/knowledge-files.md) |
| **Seams reference** | Component interactions, call paths, debugging | [`docs/seams-reference.md`](docs/seams-reference.md) — 5 scenarios, troubleshooting workflows |
| **Glossary** | Key terms with definitions and links | [`docs/GLOSSARY.md`](docs/GLOSSARY.md) — the architectural vocabulary, A–Z |
| **Ideas & backlog** | Deferred features with triggers | [`docs/IDEAS.md`](docs/IDEAS.md) — deferred work with the condition that would ship it |

### Component Areas

- **Event log** — canonical Postgres append-only history; foldable, auditable, never partial
- **Execution** — durable workflows via DBOS Transact; operation journal before/after nodes; at-least-once recovery
- **Plugins** — replaceable executor, model providers, MCP servers, extension system; zero-trust (declare + consent + fingerprint)
- **Knowledge** — claims as markdown files in the repo, anchored to code, drift-checked against git; web research carries citations
- **Vault** — deterministic markdown projections of tasks, lineage and artifacts (disposable, rebuilt on restart), plus the shipped skills under `vault/skills/`

### Visual Navigation

- `orc graph [--port 7749]` — the web UI (door #1): a live WebGL graph of tasks, steps and artifacts, and the pane you drive work from — it proposes, approves, replies and runs. Defended as the control surface it is: bound to loopback, a `Host` check that a DNS-rebinding attacker cannot satisfy, a CSRF token minted per boot and required on every mutation, and a fence limiting it to the one project it was started in
- `vault/` — filesystem projections: `index.md` (task tree + status), `tasks/<id>/execution.md` (steps + operations), `tasks/<id>/lineage.md` (artifact receipts)

## Stack

TypeScript end-to-end on Bun (package manager, runtime, test runner).
Postgres via docker compose (canonical event log + operations journal + DBOS
system DB, all project-scoped). Drizzle ORM over node-postgres (committed SQL
migrations; the generator is not installed — see Operational notes). DBOS
Transact for durable execution. Vercel AI SDK v7 (+ ai-sdk-ollama) for
models. Zod contracts. Commander CLI.

## Quickstart

```bash
docker compose up -d --wait     # Postgres :5433, loopback-only
bun install && bun run test:full     # the whole suite, four workers, ~110 s (plain `bun test` is sequential, several times slower)

(cd packages/cli && bun link)          # installs a global `orc` (Bun shim); alias works too

# Model auth. A `.env` in the PROJECT ROOT is loaded by every entry point (CLI, supervisor,
# MCP server) no matter which directory you invoke from; the shell environment always wins.
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env    # or ORC_ANTHROPIC_AUTH=oauth for a Claude subscription
                                               # and/or run a local Ollama — no key needed

orc db migrate                  # explicit schema setup; works before project initialization
orc init --name my-project      # identity + first-party skills; safe to re-run (it tops up the
                                # skills after an upgrade) — every worktree of the repository is the
                                # same project; identity lives only in the main checkout, never committed
orc ws new "write release notes" --spec "summarize changes since v1.2; declare the notes file as an output"
                                # a git worktree + branch for ONE request under .orc/worktrees/<slug>,
                                # recorded as a workspace, with the request drafted as its first task;
                                # prints `cd <path>` — work the request there
orc new "write release notes" --spec "…"   # or draft it in the checkout you are already standing in
orc propose <task-id> --model anthropic/claude-sonnet-5   # or ollama/<model>
orc plan <task-id>              # review it
orc approve <task-id>           # the human gate
orc run <task-id>               # durable execution in the task's workspace (--cwd <dir> overrides),
                                # with live event tail
orc ws ls                       # every checkout of this project, attention-first, with its health
orc ws merge <ws-id>            # land its branch on trunk (--no-ff), record the merge, archive the
                                # record, and remove the worktree if orc created it
orc serve status                # the supervisor holding the runtime (the first executing command starts one)
orc status <task-id>            # project, knowledge health, steps, operations, receipts, cost
orc brief [--json]              # what a new session should know: this workspace and its health, tasks awaiting
                                # approval / running / blocked, decisions in force, the drift advisory
orc replay <task-id> --at <seq> # read-only audit replay at any event sequence
orc log <task-id> --json        # full redacted event records
orc watch [--since <seq>] [--kind <kind...>]  # follow the whole project's event log live, no server needed
orc skills                      # indexed SKILL.md skills (vault/skills/<name>/SKILL.md)
orc mcp trust <id>              # local consent, bound to the server's declaration fingerprint
orc mcp serve [--autonomy full] # serve THIS project to external agents over stdio (door #2)
orc ext trust <path>            # local consent, bound to extension dependency closure + bun.lock
orc retry <task-id>             # re-run failed steps after a block
orc knowledge card <path>       # the claims anchored at or under a path
orc knowledge search <query>    # claims ranked for a query
orc knowledge drift [paths...]  # claims whose anchored code changed since they were last checked
orc knowledge fmt | check       # canonicalize / validate every knowledge file
orc adr new "<title>" --context … --decision … --consequences … [--status s] [--tags …]
                                # record a decision (id = slugged title); status defaults to accepted
orc adr ls [--status s] [--json]  # list decisions, attention-first: proposed → accepted → deprecated → superseded
orc adr show <id>               # one decision: status, date, file, Context / Decision / Consequences (and Considered)
orc adr supersede <old-id> "<title>" --context … --decision … --consequences … [--status s] [--tags …]
                                # records the replacement and marks <old-id> superseded, in one operation
                                # decisions are files under docs/decisions/<yyyy-mm-dd>-<slug>.md; `orc adr` records
                                # them as `human`, the MCP door's record_decision as `mcp`
```

Every root plan (and every frozen grounded pipeline) ends with a **finish**
step, appended automatically before the run is done — the grounded bootstrap's
own analyze/plan template and the auto-heal sweep are the two exceptions. When
the operator's `finishChecks` setting is non-empty, a **checks** step runs
just before it: the configured commands run concurrently, and their
PASS/FAIL verdict reaches the finish step as an upstream output — a red check
leads the finish question but never blocks the run; `[]` means no checks step
at all. The finish step reconciles the claims the task recorded, judges whether the task
made an architectural decision, and asks once — the paths changed, every claim
kept, corrected or retired, the checks verdict if any, and the decision draft in ADR
wording if there is one. `orc reply <task-id>
approve` records that decision, if any, and completes the task; anything else
is read as feedback and the step asks again with the updated summary.

### Workspaces

A **workspace** is one checkout being worked in. Every task belongs to one, every
run happens in one, and every claim write records the one it was written from.

**Two kinds, one of them free.** `checkout` is the repository's main checkout —
the one holding `.orc/identity.json`. `worktree` is a linked git worktree: one
`orc ws new` created for a request, or one you made yourself. Either way you
never register a checkout: the first `orc` command run in a directory **adopts**
it, recording `workspace_created` before the command's own handler runs. So
`cd`-ing into any worktree of the project and typing `orc tasks` is all it takes
for that worktree to exist in the tree. What gets adopted is the directory orc
resolves settings from, so a worktree becomes its own workspace when the
repository tracks `.orc/config.json` (that tracked file is what stops the
upward walk inside the worktree); with nothing tracked there, the walk reaches
the main checkout's `.orc` and the command adopts — and files its tasks
under — that workspace instead.

`orc ws new "<request>"` is the deliberate half: `git worktree add` under
`.orc/worktrees/<slug>` on branch `orc/<slug>` (`--base <ref>` starts it
somewhere other than this checkout's HEAD), the project's `workspaceSetup`
argv run inside the new tree (`["bun", "install", "--frozen-lockfile"]` here;
a failing setup removes the tree again and records nothing), the record, and
the request drafted as that workspace's first task (`--no-task` makes only the
workspace). It prints the `cd` line to work in.

`finishChecks` is a sibling setting, also operator-trusted like
`workspaceSetup`: an array of commands in `.orc/config.json` (default `[]`)
that the kernel-appended `checks` step runs, concurrently, just before
`finish`. `[]` means no `checks` step at all — the plan ends with `finish`.
A red command is never a block: the checks step always completes, and the
failing command is named in the verdict the finish step reads as its `checks`
upstream output and leads its question with. The commands are frozen into
the plan you approve, a cancelled run stops them, and each one's full output
is in `.orc/checks/`.

**`cwd` is the natural key**, matched as a resolved realpath: one *active*
record per directory, adoption is idempotent on it, and a worktree moved to a
new path becomes a new workspace rather than re-pointing the old record.

**`managed` is the fact that licenses deletion** — it is true only for a
directory orc itself created. `orc ws archive <id> --remove` refuses anything
else (archive the record and remove the checkout yourself), and `orc ws merge`
removes a worktree only when it is managed. `orc ws archive` alone always works,
and `orc ws restore <id>` un-archives the record — a removed worktree is gone.
`orc ws current` names the workspace this directory is; `orc ws retitle <id>
<title>` changes the label only, never the branch or the directory.

**Work binds to a workspace, not to a directory you retype.** `orc new` files a
task under the workspace of the checkout you typed it in (`--workspace <id>`
re-homes it; a split child inherits its parent's), `orc run` executes in that
task's workspace — `--cwd <dir>` is an override, not the instruction — and `orc
tasks` groups by workspace, with a loud `ORPHANED` group for any task whose
workspace record the log never recorded.

**Landing the work.** `orc ws merge <id>` merges the workspace's branch into
trunk with `--no-ff` — one addressable commit for the merge fact to point at —
in the project root, records `workspace_merged`, archives the record, and removes
the worktree when it is managed. It refuses before git touches anything: the
workspace must have no uncommitted changes (a merge carries only what is
committed), and the project root must be on trunk and clean, since that is the
checkout the branch lands in. Past the merge nothing can be undone, so every
later failure is reported with the way out rather than thrown as though the merge
had not happened. For a branch merged by hand — or an `orc ws merge` that merged
and then failed to record — `orc ws finalize <id>` records the fact, refusing
unless the branch tip is already contained in trunk, and removes nothing.

**`orc ws ls` is the attention-first view** (`--all` includes archived). One row
per workspace: id, state, age, kind, branch, task count,
`[archived]` / `[dirty]` flags, title and path. The state is one derivation, made
by the same call the `workspace_list` tool and `project_status` make:

| state | meaning |
|---|---|
| `dangling` | the checkout is gone with the branch unmerged, or nothing is open in it while it still holds unmerged work |
| `waiting` | a task is at the approval gate, or a step asked a question nobody answered |
| `active` | a task is running |
| `idle` | none of the above — a live checkout with nothing pending |
| `merged` | the branch landed on trunk and the merge is recorded |

No threshold anywhere: the age is printed and you decide what is stale.

Every task names its workspace as a **required** field, so a
project database written without one cannot be folded — the tasks it
holds simply stop appearing. Recreate it with `docker compose down -v && docker
compose up -d --wait && orc db migrate`; a repository whose main checkout has no
`.orc/identity.json` also needs `orc init --name <name>` once. `orc init` is
idempotent and safe to re-run: it always tops up the shipped skills (never
overwriting an edited one) and keeps an existing identity — minting a second one
over a live project needs `--force`.

### A setting a new project usually wants

It is not required to run a task, but it changes what the system can do, and
the failure mode looks like a bug rather than a missing setting.

**An approval rule, if you want tasks to decompose.** A step may split itself
into child tasks with `task_split`. Under the default `manual` policy every
child stops at `awaiting_approval` and the parent waits on `join_splits`
forever — which reads exactly like a hang. To let a tree build on its own:

```jsonc
// .orc/config.json
"approvalPolicy": { "default": "manual", "rules": [{ "maxDepth": 2, "then": "auto" }] }
```

Deliberately no `maxCostUSD` on that rule: a null cost estimate never matches a
cost bound, and `task_split` children carry null estimates — so a
cost-bounded rule silently gates every child. Cap spend with `orc new --budget
<usd>` instead, which the kernel enforces by debiting each child from its
parent's remaining budget.

### When something looks wrong

Most confusing first-run behaviour is one of these, and none of them is a crash
— the system prefers to keep working and tell you what it could not do.

- **`provider_error: API key is missing`** — the key lives in the project
  root's `.env`, which is loaded from any working directory. A key exported in
  one shell is invisible to a supervisor started in another.
- **A split task looks hung** — its children are sitting at
  `awaiting_approval` under the default `manual` policy while the parent waits
  on `join_splits`. `orc tasks` shows them. Approve each, or set the approval
  rule above.
- **A run died mid-step** — it resumes. `orc status <task-id>` shows
  unresolved operations, and a completed model call is not billed twice.

To see exactly what happened rather than guess: `orc log <task-id> --json` for
the full redacted event record, or `orc replay <task-id> --at <seq>` to
freeze-frame the folded state at any point in history. Deeper call paths and
debugging scenarios: [seams reference](docs/seams-reference.md).

### Documentation from the knowledge files

Documentation is an ordinary orchestrated task — no extra runner. `orc init`
seeds the project-local `documentation` skill (plus grounded-planning skills)
without overwriting project edits:

```bash
task_id=$(orc new "generate architecture docs" --spec "Write docs/architecture.md from the project's knowledge claims; declare it as an output")
orc propose "$task_id" --model anthropic/claude-sonnet-5 --skill documentation
orc approve "$task_id"
orc run "$task_id"
```

### Driving orc from another agent (door #2, MCP)

orc is usable from two doors: humans work the web UI (`orc graph`); external agents —
Claude Code, any MCP client — drive the same substrate over stdio.

**Claude Code: install the plugin.** This repository is its own plugin marketplace
(`.claude-plugin/marketplace.json`, plugin in `plugin/`):

```bash
docker compose up -d --wait && bun install && (cd packages/cli && bun link)   # `orc` on PATH
```

Then, inside Claude Code:

```
/plugin marketplace add /path/to/orchestrator      # or the git remote
/plugin install orc@orc
```

The plugin loads in every session and is silent outside an orc project. Inside one it brings
three things:

- **The MCP door.** `plugin/bin/orc-mcp` runs `orc mcp serve` in the session's project directory,
  so the server is bound to the project that directory belongs to — a git worktree resolves to its
  repository. `plugin/bin/orc-run` is how the plugin reaches orc: `orc` on PATH, or the checkout
  named by `ORC_HOME=/path/to/orchestrator` when the CLI is not linked.
- **A brief at session start.** A `SessionStart` hook prints `orc brief` into the model's context:
  this workspace and its health, tasks waiting on someone, decisions in force, the drift advisory.
  It is fail-open — it always exits 0, says nothing in a directory that is not an orc project, and
  when orc cannot answer says one line (`orc: unavailable — <reason>`, URL credentials removed).
  When knowledge cannot be read the brief still prints, marking what it could not read as unknown.
- **Skills** — `/orc:request` (an ask → a request, its plan read back, the human gate),
  `/orc:adr` (enumerate decisions, record, supersede), `/orc:workspace` (which checkout a request
  belongs to). They teach the tools below; the skills under `vault/skills/` are a different
  audience — agents running inside plans.

The plugin serves the door under the default `--autonomy gated`. Any other MCP client, or a
fully autonomous door, registers the server directly:

```bash
claude mcp add orc -- orc mcp serve
# Codex, with the linked `orc` on PATH:
codex mcp add orc -- orc mcp serve
# fully autonomous (approve included, attributed as approvedBy: mcp):
claude mcp add orc -- orc mcp serve --autonomy full
```

Tools served (project-bound, same `OrcActions` validation as the web):

| Kind | Tools |
|---|---|
| Read | `project_status`, `task_plan`, `task_transcript`, `plan_notes`, `recent_activity`, `available_models` (the live provider catalog — call it before naming a `modelRef`, never guess one) |
| Knowledge (degraded-tolerant) | `knowledge_card`, `knowledge_search`; with the mutating door, `decision_list`, `decision_read` |
| Mutate | `new_request` (quick/grounded; `workspaceId` defaults to the workspace this server runs in), `propose`, `run` (in the task's workspace unless a `cwd` says otherwise), `reply`, `retry`, `cancel`, `annotate`, `revise` |
| Decisions | `record_decision` — record an ADR-shaped decision (Context / Decision / Consequences, status, optional `supersedes`); the one knowledge-authoring tool on this door, attributed `mcp` — the same tool in the web copilot writes `cli` |
| Workspaces (served only with the mutating door) | `workspace_list` — the checkouts this project is worked in, each with its health (state, last activity, task counts) and ordered attention-first, read-only; `workspace_new` — a git worktree + branch for ONE request under `.orc/worktrees`, recorded as a workspace, with the request as its first task |
| The gate | `approve` — refuses under the default `--autonomy gated` (the human approves in the UI or `orc approve`); approves under `--autonomy full`, recorded as `approvedBy: mcp` |

stdout carries ONLY protocol frames: boot diagnostics are rebound to stderr, and the
transport owns the real stdout — DBOS's logger cannot corrupt the channel. Trust grants and
`orc init` are never exposed over MCP. Knowledge writing stays with the agents running inside
plans, with one deliberate exception: `record_decision`. A decision made in a driver's session
is exactly the knowledge that otherwise evaporates, so the driver may record decisions — and
nothing else; `knowledge_write` is not served.

### Sourced web research

No bundled web provider and no hard-coded tool names: research runs on whatever
search/fetch MCP server the project declares and trusts, and the step opts in
through ordinary `toolRefs`. `orc init` seeds the tool-agnostic `web-research`
skill alongside the others.

```bash
orc mcp trust search             # after declaring a "search" server in .orc/config.json
task_id=$(orc new "compare pgvector vs qdrant for our recall path" --spec "cite every claim")
orc propose "$task_id" --file research-plan.json   # toolRefs live in the plan draft
orc approve "$task_id" && orc run "$task_id"
orc knowledge search research    # the claims the research step wrote, sources included
```

```jsonc
// research-plan.json — refs are validated at propose time, so a missing skill
// or an untrusted server fails here rather than mid-run
{
  "strategyRef": "template:single", "costEstimateUSD": 0,
  "steps": [{
    "id": "research", "role": "scout", "title": "Compare pgvector and qdrant",
    "instructions": "Answer the task spec. Cite every claim.",
    "executorRef": "api-loop", "modelRef": "anthropic/claude-sonnet-5",
    "skillRefs": ["web-research"],
    "toolRefs": ["search/web_search", "search/fetch"],  // <server-id>/<tool-name>
    "isolation": "local", "zone": [], "maxIterations": 12, "dependsOn": []
  }]
}
```

Fetched page text is untrusted **evidence, never instructions**. The raw
response stays in the redacted audit trail; what reaches the knowledge files is
one distilled claim per finding, carrying its source URLs.

## Guarantees, stated precisely

- **Project identity.** `orc init` writes `projectId`/`projectName` into
  `.orc/identity.json`, which is git-ignored: identity belongs to the
  repository, not to any one checkout — it lives in the main checkout's
  `.orc/identity.json`, and a linked worktree resolves to it through git's
  common dir, so no worktree can mint a second project. The tracked
  `.orc/config.json` carries settings only. Committing the identity meant a
  clone, a worktree or a `git reset --hard` silently repointed every command —
  including `orc purge` — at someone else's project. Every event, journal row,
  DBOS system database is bound to that identity, so
  two projects sharing one deployment cannot read, project, recover, or render
  each other's state.
- **Audit replay.** History is an append-only, redacted, idempotent event log.
  Folding it reconstructs task, execution, and lineage state at any sequence
  (`orc replay`). Replay never mutates history.
- **Interaction identity.** Every event carries an `Origin`: a required,
  nullable `chatId` and a required `Door` (`web`, `cli`, `mcp`, `supervisor`,
  or `hook`). `NO_CHAT(door)` states that a call belongs to no conversation.
  `chat_opened` is the one chat lifecycle event; a `ChatDigest` derives its
  end, cost and effects from the log on each read. A run ends at its own
  task's status change, never a split child's. Copilot chat ids reach the
  browser only after their first exchange is committed.
- **Shared doors and reads.** Doors parse input, name its origin and present
  results; mutations live in `OrcActions` and `WorkspaceOps`. `WorkspaceDoor`
  gives `orc ws` the workspace ops and the kernel's reads, withholding the
  mutating kernel and the task actions it does not use.
  `Scope` names a project, workspace, task (with an explicit subtree choice)
  or chat; `inScope` is the membership rule for `timeline` and `chats`.
- **Operation journal.** Every first-party model/tool effect records a durable
  `started` node *before* the external call and its completion/failure after.
  A crash leaves an explicit unresolved node — never a blind gap.
- **Resume.** Completed operations are reused from the journal; failed ones
  follow retry policy; a node still `started` after a crash is retried as an
  explicitly **at-least-once** attempt (attempts are counted, both start
  transitions stay visible). Exact-once for a remote effect exists only where
  that provider/tool honors a deterministic idempotency key — orc records the
  ambiguity instead of claiming it away.
- **Workflow recovery** (DBOS) is the continuation mechanism underneath —
  it is not the definition of replay.
- **Durable human feedback.** `feedback_provided` events are an idempotent
  outbox: live/startup routing retries committed replies. Grounded `approve`
  replies carry a plan-graph SHA-256; `finalize_plan` accepts only a matching
  approval from the same run, so edits require reapproval.
- **Output lineage.** A success signal may declare workspace-relative
  `outputs`; the runtime verifies each file, computes its SHA-256 receipt, and
  commits `artifact_produced` atomically with `step_completed`.
- **Secrets** are redacted once at the storage boundary (sensitive keys +
  configured env values; add names via `redactEnv` in config). Projections
  and vault files only ever see redacted data.
- **Degraded knowledge.** An unreadable checkout ⇒ explicit unavailable
  results from the knowledge tools, and everything else — history,
  execution, cancellation, vault trace — keeps working.
- **Sourced knowledge.** A claim's sources are bounded, credential-free
  http(s) URLs. Raw fetched text stays in the redacted audit trail; only the
  distilled claim reaches the knowledge files.
- **Observed use, not assumed use.** What a step was handed and what it read
  are events in the log, so `orc knowledge stats` reports from the log rather
  than from a counter that a rebuild could zero. Nothing ranks or expires on
  use — it is measurement.
- **The human gate is structural.** The copilot has no approve tool; over MCP,
  `approve` exists only behind the launch-time `--autonomy full` dial and every
  such approval is recorded as `approvedBy: mcp`. An agent can never widen its
  own autonomy mid-session.
- **Copilot conversations are events.** Each web-chat exchange is journaled as a
  `copilot_exchange` event (user text, assistant text, tool summaries, priced
  usage); the chat pane rebuilds from the log after reload — the browser is a
  cache, never the record.
- **Zone write-fences.** A step declaring `zone` globs can only write inside
  them (`fs_write` refuses with a named fence); reads stay free, empty zone =
  unrestricted. Deterministic env errors (`EACCES`/`ENOENT`/…) fail a step on
  attempt 1 instead of burning retries.
- **Degradation is visible.** `orc graph` polls `/api/health` and shows a red badge
  when the supervisor or the knowledge files cannot be reached — within one 15s poll interval.

## Vault views

- `vault/index.md` — recursive task-expansion graph + live status
- `vault/tasks/<id>/execution.md` — plan steps + operation nodes (attempts, unresolved/completed/failed)
- `vault/tasks/<id>/lineage.md` — producing step → verified output receipts

## Operational notes

- Runs belong to a **supervisor**, not to the terminal that asked for one. The first executing
  command (`run`, `retry`, `reply`, `approve` of a split child, grounded `new`) brings one up in
  the background if none is beating; `orc serve status` shows it, `orc serve stop` stops it, and it
  exits on its own after 30 minutes with no live work. So **ctrl-c stops watching, not the run** —
  `orc cancel <task-id>` is what stops the work. Presence is a heartbeat row refreshed every 5s and
  trusted for 30s, not an exclusive lock; a project has exactly one supervisor.
  `--no-daemon` (or `ORC_NO_DAEMON=1`) keeps the runtime inside the command instead, which is what
  tests, CI and benchmarks want — there, ctrl-c does stop the run.
- `ORC_DATABASE_URL` overrides the default `postgresql://postgres:orc@localhost:5433/orc`.
- `maxIterations` in `.orc/config.json` (or `ORC_MAX_ITERATIONS`) sets the default agent-loop
  budget for authored steps (single-step template, grounded analyze) — default 30. Applies at
  plan-authoring time only; approved plans keep the budgets they were approved with.
- `orc graph [--port 7749]` serves a live WebGL graph of tasks, steps and artifacts for any project in the event log, with per-task chat transcripts, a live event log,
  deep-linkable navigation (`#p=…&n=…&tab=…`), and the Request view: create (quick or
  grounded) → review the decomposition → refine/approve → run → watch it work
  (focus mode dims everything else). Mutations are available only when launched inside a
  project (CSRF-token guarded, 127.0.0.1 only); trust/init stay CLI-only. Logic lives in
  `@orc/ui-core`; the web server and browser renderer are adapters — a TUI can reuse the core
  directly. Before serving, it checks `web/dist` against a content fingerprint of the web app's
  source closure (`web/src`, `@orc/ui-core/src`, `@orc/contracts/src`, test files excluded since
  they never reach the bundle — not file mtimes, which a branch switch or `git checkout` can leave
  lying): missing or stale in a dev checkout rebuilds automatically (one line saying so, a few
  seconds); a checkout with no source tree to rebuild from serves as-is; a rebuild that fails or
  can't be attempted refuses to start and names the build command to run by hand. The web app's own
  `build` script stamps `dist` with that same fingerprint once `vite build` succeeds, so a plain
  `bun run build` or `check:web` leaves dist reading fresh — `orc graph` never rebuilds a dist that
  a prior build already produced.
- `orc watch [--since <seq>] [--kind <kind...>]` follows the project's whole event log from the
  shell — one line per event (`seq`, `kind`, summary) until interrupted. It subscribes through the
  kernel's own LISTEN/NOTIFY path (the same one `orc graph`'s `/api/stream` rides), so it needs no
  HTTP server running. `--since` replays events after that sequence before continuing live (default:
  a live tail from now, nothing replayed); `--kind` filters to the named kinds, repeatable. Every
  line's summary is the same `summarizeEvent` (`@orc/ui-core`) row the web log renders, so a line
  here and a row there read identically: `.summary.kind` is the event kind and `.summary.line` is
  the one-line summary — `/api/stream`'s SSE frames carry that same row under `.summary`.
- Plugins: `.orc/config.json` *declares* (`mcpServers`, `extensions`, `skillsDir`);
  `.orc/trust.json` *grants* — created only by `orc mcp trust` / `orc ext trust`,
  written atomically with mode 0600, never commit it. Grants bind to a
  fingerprint: MCP to (command, args, env *names*), extensions to the entry
  file plus literal local import/dynamic-import/require closure and project
  `bun.lock`. Change any covered input and the grant is invalid until re-trusted.
  MCP servers still run with this user's full permissions — vet before trusting.
- `env` values in `mcpServers` starting with `$` pull from orc's own environment
  at spawn — secrets never go in the config file (and env *values* never enter
  trust fingerprints).
- Schema changes: migrations are committed SQL under `packages/kernel/drizzle/`;
  apply them explicitly with `orc db migrate`. `drizzle-kit` is deliberately
  not installed (its loader chain is vulnerable);
  generate with a pinned one-shot `bunx drizzle-kit@latest generate` + audit
  the output, or write a reviewed SQL migration by hand.
- Resetting development state: `docker compose down -v && docker compose up -d --wait && orc db migrate`
  drops and recreates Postgres (events, journal, DBOS); the vault re-renders
  from events on next use. A repository whose main checkout has no
  `.orc/identity.json` needs `orc init` once before project commands work; a worktree of an
  already-initialized repository needs nothing — it resolves through git's common dir to the
  main checkout's identity. A trust grant whose fingerprint no longer
  matches fails closed until re-granted.
- Environment: `orc` loads `.env` itself rather than relying on Bun's cwd-relative, no-walk-up
  pickup. The checkout's own `.env` is loaded first (a local override), then the repository root's
  — first writer wins, so a command run from a subdirectory, a worktree, or a supervisor spawned
  with a different cwd still gets the project's credentials. Real environment variables always win
  over both files.
- Never bundle the CLI (`bun build`): DBOS must run unbundled via `bun run`.
- Browser imports use leaf `@orc/contracts/<subpath>` modules: their runtime
  imports must not reach Node builtins. `browser-leaves.test.ts` checks those
  dependency paths; `bun run check:web` runs the Svelte checks and builds the
  browser bundle.
- The events table stores a nullable `chat_id` and a `door` that is `NOT NULL`
  with no default: an event outside any chat says so, but a row that does not
  name the door it entered through cannot exist, and a past event's door is
  never guessed. The post-commit hook (`scripts/hooks/post-commit-append.ts`)
  records `Door.hook` and reads `ORC_CHAT_ID` when a commit belongs to a run's
  chat.
- Upgrading orc: finish or `orc cancel` active runs first — DBOS recovery is
  keyed to the app version (`DBOS__APPVERSION`). Then run `orc init` once per project: it seeds
  skills a new version ships that the project's `vault/skills` does not have yet, and a plan
  proposed before that is refused naming the missing one (`unknown skill 'role-finisher'`).
  `orc serve` warns at boot for each role skill its index is missing.
## License

orc is dual-licensed:

- **Noncommercial use — free.** Use it, modify it, share it (with your
  changes) under the [PolyForm Noncommercial License 1.0.0](LICENSE.md) —
  personal projects, research, study, education, and noncommercial
  organizations. Keep the license and the Required Notice with every copy.
- **Commercial / monetized use — by agreement.** Selling it, hosting it as a
  service, building it into a paid product, or using it inside a for-profit
  business requires a commercial license with two standing terms: a fair
  share of the value it helps create, and visible attribution. See
  [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md) — 30-day free evaluation for
  commercial entities included.
