import { z } from 'zod'
import { TaskNode, TaskStatus } from './task'
import { Plan } from './plan'
import { FailureClass, Signal, Usage } from './execution'

export const EventKind = z.enum([
  'task_created', 'plan_proposed', 'plan_edited', 'plan_approved', 'task_status_changed',
  'run_started', 'step_started', 'agent_call', 'tool_call', 'tool_result',
  'signal_received', 'step_completed', 'step_failed',
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
  run_started: z.object({
    taskId: z.string().min(1),
    planVersion: z.number().int().positive(),
    retryIndex: z.number().int().nonnegative(),
    workflowId: z.string().min(1),
    cwd: z.string().nullable(),
  }),
  step_started: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    attempt: z.number().int().positive(),
  }),
  agent_call: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    iteration: z.number().int().positive(),
    request: z.unknown(),
    response: z.unknown(),
  }),
  tool_call: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    iteration: z.number().int().positive(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.unknown(),
  }),
  tool_result: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    iteration: z.number().int().positive(),
    toolCallId: z.string().min(1),
    toolName: z.string().min(1),
    output: z.unknown(),
    isError: z.boolean(),
  }),
  signal_received: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    signal: Signal,
  }),
  step_completed: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    summary: z.string(),
  }),
  step_failed: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    class: FailureClass,
    message: z.string(),
  }),
}

export const EventInput = z.object({
  taskId: z.string().min(1),
  stepId: z.string().min(1).nullable(),
  runToken: z.string().min(1).nullable(),
  kind: EventKind,
  payload: z.record(z.string(), z.unknown()),
  usage: Usage.nullable().optional(),
})
export type EventInput = z.infer<typeof EventInput>

export interface EventRecord extends Omit<EventInput, 'usage'> {
  seq: number
  ts: string
  usage: Usage | null
}
