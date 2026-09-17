import { z } from 'zod'

export const TaskStatus = z.enum([
  'draft', 'awaiting_approval', 'approved', 'running',
  'blocked', 'done', 'failed', 'cancelled',
])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TASK_STATUS = TaskStatus.enum

// Statuses no further work will move. A driver uses it to decide whether a task it spawned still
// needs someone to execute it.
export const TERMINAL_TASK_STATUS: ReadonlySet<TaskStatus> =
  new Set([TASK_STATUS.done, TASK_STATUS.failed, TASK_STATUS.cancelled])

export const TaskNode = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  // The workspace (checkout) this task belongs to. REQUIRED: every boot adopts its cwd before a
  // task can be created, so a missing value is a wiring bug and the schema is the guard that
  // catches it. No legacy decoder — the operator asked for none, and the log is reset.
  workspaceId: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  spec: z.string(),
  status: TaskStatus,
  zone: z.array(z.string()),
  budgetUSD: z.number().nonnegative().nullable(),
  depth: z.number().int().min(0),
  createdAt: z.string(),
})
export type TaskNode = z.infer<typeof TaskNode>
