// Mutating capabilities, implemented by whoever owns a Kernel + ExecutionPort (the CLI today —
// see packages/cli/src/actions.ts). Adapters (web server, future TUI) receive this interface;
// ui-core itself never constructs one. Implementations return data and never print: each
// adapter renders results its own way (CLI lines, web toasts).
export interface OrcActions {
  newTask(input: {
    title: string
    spec?: string
    parentId?: string
    grounded?: { modelRef: string; cwd: string; analyzerRef?: string }
  }): Promise<{ taskId: string }>
  propose(taskId: string, opts: { modelRef: string; skillRefs?: string[] }): Promise<{ version: number; steps: number }>
  approve(taskId: string, version?: number): Promise<{ version: number }>
  run(taskId: string, cwd: string): Promise<{ workflowId: string }>
  reply(taskId: string, text: string): Promise<{ answered: boolean }>
  retry(taskId: string): Promise<{ workflowId: string }>
  cancel(taskId: string): Promise<{
    swept: Array<{ id: string; scope: string; title: string }>
    sweepError: string | null // sweep is best-effort over a committed cancel — failures report, never throw
  }>
}
