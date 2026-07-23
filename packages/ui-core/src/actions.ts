// Mutating capabilities, implemented by whoever owns a Kernel + ExecutionPort (the CLI today —
// see packages/cli/src/actions.ts). Adapters (web server, future TUI) receive this interface;
// ui-core itself never constructs one. Implementations return data and never print: each
// adapter renders results its own way (CLI lines, web toasts).
import type { NoteAuthoringDraft, PlanDraft } from '@orc/contracts'

export interface OrcActions {
  newTask(input: {
    title: string
    spec?: string
    parentId?: string
    grounded?: { modelRef: string; cwd: string; analyzerRef?: string }
  }): Promise<{ taskId: string }>
  propose(taskId: string, opts: { modelRef: string; skillRefs?: string[] }): Promise<{ version: number; steps: number }>
  edit(taskId: string, draft: PlanDraft): Promise<{ version: number }> // full-draft edit, pre-approval only (kernel enforces)
  // approvedBy: the web door omits it (human click → 'human'); the MCP door under
  // --autonomy full passes 'mcp' so replay shows exactly who approved (P7 attribution)
  approve(taskId: string, version?: number, approvedBy?: 'human' | 'mcp'): Promise<{ version: number }>
  run(taskId: string, cwd: string): Promise<{ workflowId: string }>
  reply(taskId: string, text: string): Promise<{ answered: boolean }>
  retry(taskId: string): Promise<{ workflowId: string }>
  // grounded-plan refinement: annotate queues feedback on one plan-note; revise annotates the
  // scoped notes AND wakes the parked plan agent (the conversational gate)
  annotate(taskId: string, noteId: string, text: string, refs?: string[]): Promise<{ noteId: string }>
  revise(taskId: string, text: string, scope: string[]): Promise<{ topic: string | null }>
  // knowledge authoring — the neural interface's write path. NoteAuthoringDraft is the named
  // contract: the web route validates with the SAME schema this consumes (PlanDraft precedent,
  // no duplicate shape anywhere). Omitted fields merge-on-omit at the store gateway. Always
  // writes the durable 'project' scope — plan scopes are agent-owned transients.
  writeNote(note: NoteAuthoringDraft): Promise<{ id: string; scope: string }>
  // positional like MemoryStore.remove, which this fronts; omitted scope = project scope
  deleteNote(id: string, scope?: string): Promise<{ id: string }>
  // project chat management: the display name is a memory note; a new project mints identity
  // in the directory AND writes its name note as the first event, making it listable at once.
  // A directory that already holds an orc project is REUSED (reused: true), never re-minted.
  renameProject(name: string): Promise<{ name: string }>
  newProject(dir: string, name: string): Promise<{ projectId: string; reused: boolean }>
  cancel(taskId: string): Promise<{
    swept: Array<{ id: string; scope: string; title: string }>
    sweepError: string | null // sweep is best-effort over a committed cancel — failures report, never throw
  }>
  // destructive test-reset of the CURRENT project: erases pending durable-execution state
  // (crashed runs included — nothing gets recovered into the fresh log), deletes its events +
  // operation journal, and clears the memory read model; identity stays, so the chat survives
  // empty. warnings report best-effort cleanup steps that failed — the log purge itself is
  // committed once this resolves.
  purgeProject(): Promise<{ events: number; operations: number; warnings: string[] }>
  // remove a FOREIGN project outright: events + journal + durable-execution state, no identity
  // re-seed — it disappears from the chats list. The home project refuses (purge is its reset).
  deleteProject(projectId: string): Promise<{ events: number; operations: number; warnings: string[] }>
}
