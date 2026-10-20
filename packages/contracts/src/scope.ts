import { z } from 'zod'

// a leaf the browser reads: a runtime edge to ./events would pull in node:crypto

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
  // subtree is required: a default would silently pick one of two different questions
  z.object({ type: z.literal(ScopeType.task), id: z.string().min(1), subtree: z.boolean() }),
  z.object({ type: z.literal(ScopeType.chat), id: z.string().min(1) }),
])
export type Scope = z.infer<typeof Scope>

// narrow: a kernel State, a projection row or a test literal are all substitutable
export interface ScopeIndex {
  workspaceOfTask(taskId: string): string | null
  inSubtree(taskId: string, rootId: string): boolean
}
