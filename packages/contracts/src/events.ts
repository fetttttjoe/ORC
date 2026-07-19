import { z } from 'zod'
import { TaskNode, TaskStatus } from './task'
import { Plan } from './plan'
import { FailureClass, RunOutcome, Signal, Usage } from './execution'
import { OperationCompletedPayload, OperationFailedPayload, OperationStartedPayload } from './operations'
import { MemoryDeletedPayload, MemoryWrittenPayload } from './memory'
import { AnalysisCompletedPayload, FeedbackProvidedPayload, FeedbackRequestedPayload, PlanAnnotatedPayload } from './analysis'

// typed so folds can parse receipts without casts
export const ArtifactProducedPayload = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
})
export type ArtifactProducedPayload = z.infer<typeof ArtifactProducedPayload>

export const EventKind = z.enum([
  'task_created', 'plan_proposed', 'plan_edited', 'plan_approved', 'task_status_changed',
  'run_started', 'step_started', 'skill_loaded', 'agent_call', 'tool_call', 'tool_result',
  'signal_received', 'step_completed', 'step_failed', 'split_proposed', 'split_resolved',
  'operation_started', 'operation_completed', 'operation_failed', 'artifact_produced',
  'memory_written', 'memory_deleted',
  'feedback_requested', 'feedback_provided', 'plan_annotated', 'analysis_completed',
])
export type EventKind = z.infer<typeof EventKind>

export const EVENT_KIND = EventKind.enum

export const PAYLOAD_SCHEMAS = {
  task_created: z.object({ task: TaskNode }),
  plan_proposed: z.object({ plan: Plan }),
  plan_edited: z.object({ plan: Plan }),
  plan_approved: z.object({
    taskId: z.string().min(1),
    version: z.number().int().positive(),
    approvedAt: z.string(),
    approvedBy: z.enum(['human', 'policy']),
    ruleIndex: z.number().int().nonnegative().optional(), // which ApprovalPolicy rule matched
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
  skill_loaded: z.object({
    stepId: z.string().min(1),
    runToken: z.string().min(1),
    name: z.string().min(1),
    hash: z.string().min(1),
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
  split_proposed: z.object({
    splitId: z.string().min(1),
    taskId: z.string().min(1),      // parent task
    stepId: z.string().min(1),
    runToken: z.string().min(1),    // parent step workflow id = DBOS.send target
    childTaskId: z.string().min(1),
  }),
  split_resolved: z.object({
    splitId: z.string().min(1),
    childTaskId: z.string().min(1),
    outcome: RunOutcome,            // done | blocked | cancelled — NOT SignalOutcome (spec D5)
    summary: z.string(),
    notes: z.array(z.object({ id: z.string(), scope: z.string() })),
  }),
  operation_started: OperationStartedPayload,
  operation_completed: OperationCompletedPayload,
  operation_failed: OperationFailedPayload,
  artifact_produced: ArtifactProducedPayload,
  memory_written: MemoryWrittenPayload,
  memory_deleted: MemoryDeletedPayload,
  feedback_requested: FeedbackRequestedPayload,
  feedback_provided: FeedbackProvidedPayload,
  plan_annotated: PlanAnnotatedPayload,
  analysis_completed: AnalysisCompletedPayload,
} satisfies Record<EventKind, z.ZodType>

export const EventInput = z.object({
  taskId: z.string().min(1).nullable(),
  stepId: z.string().min(1).nullable(),
  runToken: z.string().min(1).nullable(),
  kind: EventKind,
  payload: z.record(z.string(), z.unknown()),
  usage: Usage.nullable().optional(),
  // deterministic writers supply a key; the log's project/key uniqueness absorbs retries
  idempotencyKey: z.string().min(1).nullable().default(null),
})
export type EventInput = z.input<typeof EventInput>

// the stored envelope: project binding and idempotency are explicit on every record
export interface EventRecord {
  seq: number
  projectId: string
  idempotencyKey: string | null
  taskId: string | null
  stepId: string | null
  runToken: string | null
  kind: EventKind
  payload: Record<string, unknown>
  usage: Usage | null
  ts: string
}
