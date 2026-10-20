// implemented by whoever owns a Kernel and ExecutionPort; return data, never print
import type { ApprovedBy, Decision, DecisionFilter, DecisionInput, DecisionStatus, DecisionSummary, Origin, PlanDraft, Workspace, WorkspaceWithHealth } from '@orc/contracts'

// a template the action builds or a draft the door parsed; validation is the action's either way
export type PlanSource = { template: { modelRef: string; skillRefs: string[] } } | { draft: PlanDraft }

// every mutation takes origin last: identity, never authority; no verb may branch on it
export interface OrcActions {
  newTask(input: {
    title: string
    spec?: string
    parentId?: string
    // omitted = the serving process's own workspace; never null: the kernel refuses unbound tasks
    workspaceId?: string
    // required-nullable, never optional: a forgotten budget must not silently remove the cap
    budgetUSD: number | null
    // cwd null = the task's own workspace at run time, not the serving process's directory
    grounded?: { modelRef: string; cwd: string | null; analyzerRef?: string }
  }, origin: Origin): Promise<{ taskId: string }>
  propose(taskId: string, plan: PlanSource, origin: Origin): Promise<{ version: number; steps: number }>
  // pre-approval only (the kernel enforces it); same PlanSource as propose
  edit(taskId: string, plan: PlanSource, origin: Origin): Promise<{ version: number }>
  // approvedBy: web omits it ('human'); MCP under --autonomy full passes 'mcp'
  approve(taskId: string, opts: { version?: number; approvedBy?: ApprovedBy.human | ApprovedBy.mcp }, origin: Origin): Promise<{ version: number }>
  // requested, not started: the supervisor owns the runtime; tail from since, not the top
  run(taskId: string, cwd: string | null, origin: Origin): Promise<{ requested: true; since: number }>
  // no per-door flag: a door that folded the log answered [] for a project with none yet
  listModels(): Promise<string[]>
  // active workspaces only, each with its health from the derivation orc ws ls prints
  listWorkspaces(): Promise<WorkspaceWithHealth[]>
  // taskId is nullable: a workspace can exist without a request (orc ws new --no-task)
  newWorkspace(input: { title: string; spec?: string; base?: string }, origin: Origin): Promise<{ workspace: Workspace; taskId: string | null }>
  listDecisions(filter: DecisionFilter, origin: Origin): Promise<DecisionSummary[]>
  readDecision(id: string, origin: Origin): Promise<Decision>
  recordDecision(input: DecisionInput, origin: Origin): Promise<{ id: string; status: DecisionStatus; superseded: string | null }>
  // projectId defaults to this door's; reply binds to no runtime; supervised=false means only queued
  reply(taskId: string, text: string, projectId: string | undefined, origin: Origin): Promise<{ answered: boolean; supervised: boolean }>
  retry(taskId: string, cwd: string | null, origin: Origin): Promise<{ requested: true; since: number }>
  // annotate queues feedback on one plan-note; revise also wakes the parked plan agent
  annotate(taskId: string, noteId: string, text: string, refs: string[], origin: Origin): Promise<{ noteId: string }>
  revise(taskId: string, text: string, scope: string[], origin: Origin): Promise<{ topic: string | null }>
  // a display name is a project_identified event; an existing orc directory is reused
  renameProject(name: string, origin: Origin): Promise<{ name: string }>
  newProject(dir: string, name: string, origin: Origin): Promise<{ projectId: string; reused: boolean }>
  // the subtree's task ids the cancel marked; one already terminal is not among them
  cancel(taskId: string, origin: Origin): Promise<{ cancelled: string[] }>
  // destructive test-reset of the current project; identity and knowledge files stay
  purgeProject(origin: Origin): Promise<{ events: number; operations: number; warnings: string[] }>
  // remove a foreign project outright; the home project refuses (purge is its reset)
  deleteProject(projectId: string, origin: Origin): Promise<{ events: number; operations: number; warnings: string[] }>
}
