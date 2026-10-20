import { z } from 'zod'

// managed gates git worktree remove: orc deletes only what it created; cwd is the key
export enum WorkspaceKind {
  checkout = 'checkout',
  worktree = 'worktree',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const WORKSPACE_KIND = WorkspaceKind

export const WORKSPACE_TITLE_MAX = 120

export const Workspace = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(WORKSPACE_TITLE_MAX),
  cwd: z.string().min(1),
  branch: z.string().min(1).nullable(),
  baseBranch: z.string().min(1).nullable(),
  kind: z.enum(WorkspaceKind),
  managed: z.boolean(),
  // Captured at creation/adoption: branch === the project's trunk.
  onTrunk: z.boolean(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(), // required key: nothing about a workspace record defaults silently
})
export type Workspace = z.infer<typeof Workspace>

// the whole state vocabulary lives here: the browser cannot import the kernel's derivation
export enum WorkspaceState {
  active = 'active',
  waiting = 'waiting',
  idle = 'idle',
  merged = 'merged',
  dangling = 'dangling',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const WORKSPACE_STATE = WorkspaceState

export const WorkspaceHealth = z.object({
  state: z.enum(WorkspaceState),
  // no threshold: the age is printed and the human decides; null when the log shows nothing
  lastActivityAt: z.string().nullable(),
  taskCount: z.number().int(),
  openTaskCount: z.number().int(),
  // independent of state: a landed workspace with a running task reads active
  merged: z.boolean(),
  dirExists: z.boolean(),
  // null means git declined to answer, which is not the same as 'has uncommitted work'
  clean: z.boolean().nullable(),
})
export type WorkspaceHealth = z.infer<typeof WorkspaceHealth>

export const WorkspaceWithHealth = z.object({ workspace: Workspace, health: WorkspaceHealth })
export type WorkspaceWithHealth = z.infer<typeof WorkspaceWithHealth>

export const WorkspaceMergedPayload = z.object({ workspaceId: z.string().min(1), mergeCommit: z.string().min(1), trunk: z.string().min(1), at: z.string() })
export type WorkspaceMergedPayload = z.infer<typeof WorkspaceMergedPayload>

export const WorkspaceCreatedPayload = z.object({ workspace: Workspace })
export type WorkspaceCreatedPayload = z.infer<typeof WorkspaceCreatedPayload>
export const WorkspaceRetitledPayload = z.object({ workspaceId: z.string().min(1), title: z.string().min(1).max(WORKSPACE_TITLE_MAX) })
export type WorkspaceRetitledPayload = z.infer<typeof WorkspaceRetitledPayload>
// `archived` is a parameter, not two event kinds, so restore cannot drift from archive.
export const WorkspaceArchivedPayload = z.object({ workspaceId: z.string().min(1), archived: z.boolean(), at: z.string() })
export type WorkspaceArchivedPayload = z.infer<typeof WorkspaceArchivedPayload>
