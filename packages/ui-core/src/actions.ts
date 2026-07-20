// Mutating capabilities, implemented by whoever owns a Kernel + ExecutionPort (the CLI today —
// see packages/cli/src/actions.ts). Adapters (web server, future TUI) receive this interface;
// ui-core itself never constructs one. Implementations return data and never print: each
// adapter renders results its own way (CLI lines, web toasts).
import type { PlanDraft } from '@orc/contracts'

export interface OrcActions {
  newTask(input: {
    title: string
    spec?: string
    parentId?: string
    grounded?: { modelRef: string; cwd: string; analyzerRef?: string }
  }): Promise<{ taskId: string }>
  propose(taskId: string, opts: { modelRef: string; skillRefs?: string[] }): Promise<{ version: number; steps: number }>
  edit(taskId: string, draft: PlanDraft): Promise<{ version: number }> // full-draft edit, pre-approval only (kernel enforces)
  approve(taskId: string, version?: number): Promise<{ version: number }>
  run(taskId: string, cwd: string): Promise<{ workflowId: string }>
  reply(taskId: string, text: string): Promise<{ answered: boolean }>
  retry(taskId: string): Promise<{ workflowId: string }>
  // grounded-plan refinement: annotate queues feedback on one plan-note; revise annotates the
  // scoped notes AND wakes the parked plan agent (the conversational gate)
  annotate(taskId: string, noteId: string, text: string, refs?: string[]): Promise<{ noteId: string }>
  revise(taskId: string, text: string, scope: string[]): Promise<{ topic: string | null }>
  cancel(taskId: string): Promise<{
    swept: Array<{ id: string; scope: string; title: string }>
    sweepError: string | null // sweep is best-effort over a committed cancel — failures report, never throw
  }>
}
