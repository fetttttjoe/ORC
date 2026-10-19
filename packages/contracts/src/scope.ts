import { z } from 'zod'

// A leaf the browser reads: a runtime edge to ./events would pull node:crypto in through ./knowledge.

// Ordered widest to narrowest.
export enum ScopeType {
  project = 'project',
  workspace = 'workspace',
  task = 'task',
  chat = 'chat',
}

export const Scope = z.discriminatedUnion('type', [
  z.object({ type: z.literal(ScopeType.project) }),
  z.object({ type: z.literal(ScopeType.workspace), id: z.string().min(1) }),
  // subtree is REQUIRED: a caller that did not say whether children count is asking two different
  // questions, and a default would silently pick one of them.
  z.object({ type: z.literal(ScopeType.task), id: z.string().min(1), subtree: z.boolean() }),
  z.object({ type: z.literal(ScopeType.chat), id: z.string().min(1) }),
])
export type Scope = z.infer<typeof Scope>

// The task tree, as the two questions the rule asks of it. Narrow on purpose: an implementation
// over the kernel's State, a projection row or a test literal are all substitutable.
export interface ScopeIndex {
  workspaceOfTask(taskId: string): string | null
  inSubtree(taskId: string, rootId: string): boolean
}
