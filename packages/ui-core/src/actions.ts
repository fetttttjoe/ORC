// Mutating capabilities, implemented by whoever owns a Kernel + ExecutionPort (the CLI today —
// see packages/cli/src/actions.ts). Adapters (web server, future TUI) receive this interface;
// ui-core itself never constructs one. Implementations return data and never print: each
// adapter renders results its own way (CLI lines, web toasts).
import type { DecisionInput, DecisionStatus, NoteAuthoringDraft, Origin, PlanDraft, Workspace, WorkspaceWithHealth } from '@orc/contracts'

// The two ways a plan is stamped, named rather than merged into one bag of optionals: a template
// the action builds, or a draft the door parsed (--file, --from-vault, an authored request body).
// Validation (every step's model ref) is the ACTION's either way, so an authored draft gets the
// same checks at every door.
export type PlanSource = { template: { modelRef: string; skillRefs: string[] } } | { draft: PlanDraft }

// Every MUTATION takes `origin: Origin` as its required LAST parameter — the interaction and the
// door the call entered by, which the kernel stamps on every event it appends. Identity, never
// authority: no verb here may branch on it. Reads take none; they record nothing.
export interface OrcActions {
  newTask(input: {
    title: string
    spec?: string
    parentId?: string
    // Omitted = the workspace the serving process's own checkout is (the CLI door's default too).
    // Never null: a task without a workspace is refused by the kernel, not stored unbound.
    workspaceId?: string
    // Required-nullable, never optional: a forgotten budget must be a compile error, not a spend
    // cap that silently stops existing (which is what routing `orc new --budget` through an
    // optional key would have done).
    budgetUSD: number | null
    // cwd null = resolve from the task's own workspace at run time. A door that filled it in with
    // the directory the serving process sits in would drag a task created in one worktree into
    // another checkout.
    grounded?: { modelRef: string; cwd: string | null; analyzerRef?: string }
  }, origin: Origin): Promise<{ taskId: string }>
  propose(taskId: string, plan: PlanSource, origin: Origin): Promise<{ version: number; steps: number }>
  // pre-approval only (the kernel enforces it). Same PlanSource as propose: a door that offers a
  // template edit must not carry its own copy of what a template plan is.
  edit(taskId: string, plan: PlanSource, origin: Origin): Promise<{ version: number }>
  // approvedBy: the web door omits it (human click → 'human'); the MCP door under
  // --autonomy full passes 'mcp' so replay shows exactly who approved (P7 attribution).
  // Both optionals collapsed into one options object: TS1016 forbids an optional parameter before
  // the required origin, and two `| undefined` positionals would be passed blind at every door.
  approve(taskId: string, opts: { version?: number; approvedBy?: 'human' | 'mcp' }, origin: Origin): Promise<{ version: number }>
  // A run is REQUESTED, never started here: the supervisor holding the runtime turns the recorded
  // ask into a workflow, so there is no handle to hand back — callers watch the event stream.
  // Omitted cwd = the task's own workspace, resolved by the kernel (requestRun). A door that filled
  // it in with the directory the serving process happens to sit in would drag a task created in one
  // worktree back into another checkout; an explicit cwd is the deliberate override.
  // `since` is the log sequence the request was recorded at — a caller that watches (the CLI's
  // tail) must start from it; re-tailing from the top replays the whole task's history.
  run(taskId: string, cwd: string | null, origin: Origin): Promise<{ requested: true; since: number }>
  // Every usable model ref, discovered — no per-door flag: a door that folded the log answered []
  // for a project with none yet, and a driver told { refs: [] } cannot name a model at all.
  // The stall a flag guarded against is bounded at the discovery seam, per provider.
  listModels(): Promise<string[]>
  // The ACTIVE workspaces of this project — an archived record is finished business (the operator
  // archived that path on purpose) and is not listed.
  //
  // Each record comes WITH its health, from the one derivation `orc ws ls` prints: a driver asking
  // "which checkout is this in" and a human reading the terminal must not be handed two readings of
  // the same workspace. Ordered attention-first (dangling → waiting → active → idle → merged), so a
  // caller that renders the list in order is already showing what needs a person.
  listWorkspaces(): Promise<WorkspaceWithHealth[]>
  // One request, one checkout: creates the git worktree + branch under the project's .orc/worktrees,
  // records it as a managed workspace, and drafts the request as its first task. `base` defaults to
  // the HEAD of the checkout this door serves. taskId is nullable because a workspace can exist
  // WITHOUT a request — the terminal's `orc ws new --no-task`, for a human about to work the tree
  // themselves. This door has no such flag (a driver asking for a workspace is asking for a
  // request), so the shape is shared with that path rather than a case this one produces.
  newWorkspace(input: { title: string; spec?: string; base?: string }, origin: Origin): Promise<{ workspace: Workspace; taskId: string | null }>
  // Knowledge authoring, second and last door: a DECISION made in a driver's session is exactly the
  // knowledge that otherwise evaporates. Deliberately narrow — memory_write stays filtered
  // out of the MCP surface; a decision has a fixed body layout and a lifecycle, a free note has
  // neither. Attributed to authorSourceOf(origin.door) in the workspace the serving process runs
  // in. Recording is not an upsert: an existing id is refused and `supersedes` is how a decision
  // changes.
  recordDecision(input: DecisionInput, origin: Origin): Promise<{ id: string; status: DecisionStatus; superseded: string | null }>
  // `projectId` names the project to answer IN; omitted means this door's own. Answering is the one
  // human action that is not execution: the append only unblocks the parked step, and a supervisor's
  // router carries it into the workflow off feedback_provided — so unlike run/retry/propose it binds
  // to no runtime and no started directory. The graph UI lists and streams every project in the
  // database; fencing this to its home project made it show a question it then refused to let the
  // user answer, sending them to a terminal for a row it already had that project's log to write.
  // `supervised` is false when nothing is live in that project right now: the answer is durable and
  // the next supervisor picks it up, but the human who typed it must be told it is only queued.
  reply(taskId: string, text: string, projectId: string | undefined, origin: Origin): Promise<{ answered: boolean; supervised: boolean }>
  retry(taskId: string, cwd: string | null, origin: Origin): Promise<{ requested: true; since: number }>
  // grounded-plan refinement: annotate queues feedback on one plan-note; revise annotates the
  // scoped notes AND wakes the parked plan agent (the conversational gate). `refs` is required and
  // may be empty — an omitted list and an empty one always meant the same thing.
  annotate(taskId: string, noteId: string, text: string, refs: string[], origin: Origin): Promise<{ noteId: string }>
  revise(taskId: string, text: string, scope: string[], origin: Origin): Promise<{ topic: string | null }>
  // knowledge authoring — the neural interface's write path. NoteAuthoringDraft is the named
  // contract: the web route validates with the SAME schema this consumes (PlanDraft precedent,
  // no duplicate shape anywhere). Omitted fields merge-on-omit at the store gateway. Always
  // writes the durable 'project' scope — plan scopes are agent-owned transients.
  writeNote(note: NoteAuthoringDraft, origin: Origin): Promise<{ id: string; scope: string }>
  // positional like MemoryStore.remove, which this fronts; undefined scope = project scope
  deleteNote(id: string, scope: string | undefined, origin: Origin): Promise<{ id: string }>
  // project chat management: the display name is a memory note; a new project mints identity
  // in the directory AND writes its name note as the first event, making it listable at once.
  // A directory that already holds an orc project is REUSED (reused: true), never re-minted.
  renameProject(name: string, origin: Origin): Promise<{ name: string }>
  newProject(dir: string, name: string, origin: Origin): Promise<{ projectId: string; reused: boolean }>
  cancel(taskId: string, origin: Origin): Promise<{
    swept: Array<{ id: string; scope: string; title: string }>
    sweepError: string | null // sweep is best-effort over a committed cancel — failures report, never throw
  }>
  // destructive test-reset of the CURRENT project: erases pending durable-execution state
  // (crashed runs included — nothing gets recovered into the fresh log), deletes its events +
  // operation journal, and clears the memory read model; identity stays, so the chat survives
  // empty. warnings report best-effort cleanup steps that failed — the log purge itself is
  // committed once this resolves.
  purgeProject(origin: Origin): Promise<{ events: number; operations: number; warnings: string[] }>
  // remove a FOREIGN project outright: events + journal + durable-execution state, no identity
  // re-seed — it disappears from the chats list. The home project refuses (purge is its reset).
  deleteProject(projectId: string, origin: Origin): Promise<{ events: number; operations: number; warnings: string[] }>
}
