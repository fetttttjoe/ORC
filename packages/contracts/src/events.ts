import { z } from 'zod'
import { TaskNode, TaskStatus } from './task'
import { Plan } from './plan'

export const EventKind = z.enum([
  'task_created', 'plan_proposed', 'plan_edited', 'plan_approved', 'task_status_changed',
])
export type EventKind = z.infer<typeof EventKind>

export const EVENT_KIND = EventKind.enum

export const PAYLOAD_SCHEMAS: Record<EventKind, z.ZodType> = {
  task_created: z.object({ task: TaskNode }),
  plan_proposed: z.object({ plan: Plan }),
  plan_edited: z.object({ plan: Plan }),
  plan_approved: z.object({
    taskId: z.string().min(1),
    version: z.number().int().positive(),
    approvedAt: z.string(),
  }),
  task_status_changed: z.object({ taskId: z.string().min(1), from: TaskStatus, to: TaskStatus }),
}

export const EventInput = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1).nullable(),
  runToken: z.string().min(1).nullable(),
  kind: EventKind,
  payload: z.record(z.string(), z.unknown()),
})
export type EventInput = z.infer<typeof EventInput>

export interface EventRecord extends EventInput {
  seq: number
  ts: string
}
