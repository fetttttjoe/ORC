import { z } from 'zod'

export const TaskStatus = z.enum([
  'draft', 'awaiting_approval', 'approved', 'running',
  'blocked', 'done', 'failed', 'cancelled',
])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TASK_STATUS = TaskStatus.enum

export const TaskNode = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
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
