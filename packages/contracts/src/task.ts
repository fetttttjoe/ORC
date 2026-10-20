import { z } from 'zod'

export enum TaskStatus {
  draft = 'draft',
  awaiting_approval = 'awaiting_approval',
  approved = 'approved',
  running = 'running',
  blocked = 'blocked',
  done = 'done',
  failed = 'failed',
  cancelled = 'cancelled',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const TASK_STATUS = TaskStatus

// statuses no further work will move
export const TERMINAL_TASK_STATUS: ReadonlySet<TaskStatus> =
  new Set([TASK_STATUS.done, TASK_STATUS.failed, TASK_STATUS.cancelled])

export enum TaskType {
  generic = 'generic',
  grounded = 'grounded',
  split = 'split',
}

export const TaskNode = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  // required: boot adopts its cwd before any task exists, so a missing value is a wiring bug
  workspaceId: z.string().min(1),
  type: z.enum(TaskType),
  title: z.string().min(1),
  spec: z.string(),
  status: z.enum(TaskStatus),
  zone: z.array(z.string()),
  budgetUSD: z.number().nonnegative().nullable(),
  depth: z.number().int().min(0),
  createdAt: z.string(),
})
export type TaskNode = z.infer<typeof TaskNode>
