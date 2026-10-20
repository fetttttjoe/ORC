import { z } from 'zod'
import { TaskNode, TaskStatus } from './task'
import { Plan } from './plan'
import { FailureClass, Signal, SplitResult, Usage } from './execution'
import { EventKind } from './event-kinds'
import { OperationCompletedPayload, OperationFailedPayload, OperationStartedPayload } from './operations'
import { SHA256_HEX_RE } from './ids'
import { Origin } from './origin'
import { AnalysisCompletedPayload, FeedbackProvidedPayload, FeedbackRequestedPayload, PlanAnnotatedPayload } from './analysis'
import { WorkspaceArchivedPayload, WorkspaceCreatedPayload, WorkspaceMergedPayload, WorkspaceRetitledPayload } from './workspace-entity'
import { ChatOpenedPayload } from './chat'
import { ProjectIdentity } from './project-identity'
import { PlanNoteWrittenPayload } from './plan-note'
import { KnowledgeCheckedPayload, KnowledgeDeliveredPayload, KnowledgeWrittenPayload } from './knowledge-events'

// typed so folds can parse receipts without casts
export const ArtifactProducedPayload = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX_RE),
  size: z.number().int().nonnegative(),
})
export type ArtifactProducedPayload = z.infer<typeof ArtifactProducedPayload>

// append-on-change: the latest event per provider is the catalog; history shows drift
export const ModelsDiscoveredPayload = z.object({
  providerId: z.string().min(1).max(64),
  models: z.array(z.string().min(1).max(128)).max(500),
})
export type ModelsDiscoveredPayload = z.infer<typeof ModelsDiscoveredPayload>

// one completed copilot exchange, appended by the graph server after the stream ends
export const CopilotExchangePayload = z.object({
  user: z.string(),
  assistant: z.string(),
  toolCalls: z.array(z.object({ toolName: z.string().min(1), summary: z.string() })).max(64),
  modelRef: z.string().min(1),
  // stated here: a copilot chat roams across tasks, so the envelope's taskId cannot answer it
  taskId: z.string().min(1).nullable(),
  workspaceId: z.string().min(1).nullable(),
})
export type CopilotExchangePayload = z.infer<typeof CopilotExchangePayload>

export { EventKind, EVENT_KIND, type EventRecord } from './event-kinds'

export const RATE_LIMIT_MESSAGE_CHARS = 300

export const RateLimitWaitPayload = z.object({
  stepId: z.string().min(1),
  runToken: z.string().min(1),
  waitMs: z.number().int().positive(),
  waitsSoFar: z.number().int().nonnegative(),
  errorMessage: z.string().max(RATE_LIMIT_MESSAGE_CHARS),
})
export type RateLimitWaitPayload = z.infer<typeof RateLimitWaitPayload>

export enum Reaction {
  runRequested = 'run_requested',
  cancelled = 'cancelled',
  childApproved = 'child_approved',
  feedback = 'feedback',
  splitResolve = 'split_resolve',
  // auto-heal reactor: a recorded out-of-task commit triggers the heal pass
  commitRecorded = 'commit_recorded',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const REACTION = Reaction

export const ReactionFailedPayload = z.object({
  // derives from the enum so a new reaction cannot first fail on the failure-recording path
  reaction: z.enum(Reaction),
  taskId: z.string().min(1).nullable(),
  message: z.string(),
  // null when the trigger was a split's state rather than one event
  causeSeq: z.number().int().nonnegative().nullable(),
})
export type ReactionFailedPayload = z.infer<typeof ReactionFailedPayload>

// paths may be empty: an empty commit touches nothing
const HEX_RE = /^[a-f0-9]+$/i
export const CommitRecordedPayload = z.object({
  sha: z.string().min(1).regex(HEX_RE, 'sha must be hex digits'),
  paths: z.array(z.string().min(1)),
  // required, not derived at read time: worktrees come and go and a later lookup misattributes
  workspaceId: z.string().min(1).nullable(),
})
export type CommitRecordedPayload = z.infer<typeof CommitRecordedPayload>

// an explicit ask: orc propose + orc approve deliberately start nothing
export const RunRequestedPayload = z.object({
  taskId: z.string().min(1),
  cwd: z.string().nullable(),
  retry: z.boolean(),
})
export type RunRequestedPayload = z.infer<typeof RunRequestedPayload>

// who approved the plan; distinct from AuthorSource, which is a write's door
export enum ApprovedBy {
  human = 'human',
  policy = 'policy',
  mcp = 'mcp',
}

export const PAYLOAD_SCHEMAS = {
  task_created: z.object({ task: TaskNode }),
  plan_proposed: z.object({ plan: Plan }),
  plan_edited: z.object({ plan: Plan }),
  plan_approved: z.object({
    taskId: z.string().min(1),
    version: z.number().int().positive(),
    approvedAt: z.string(),
    approvedBy: z.enum(ApprovedBy),
    ruleIndex: z.number().int().nonnegative().optional(), // which ApprovalPolicy rule matched
  }),
  task_status_changed: z.object({ taskId: z.string().min(1), from: z.enum(TaskStatus), to: z.enum(TaskStatus) }),
  run_requested: RunRequestedPayload,
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
  rate_limit_wait: RateLimitWaitPayload,
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
    class: z.enum(FailureClass),
    message: z.string(),
  }),
  split_proposed: z.object({
    splitId: z.string().min(1),
    taskId: z.string().min(1),      // parent task
    stepId: z.string().min(1),
    runToken: z.string().min(1),    // parent step workflow id = DBOS.send target
    childTaskId: z.string().min(1),
  }),
  split_resolved: SplitResult,      // the join payload IS the event payload — composed, not re-spelled
  operation_started: OperationStartedPayload,
  operation_completed: OperationCompletedPayload,
  operation_failed: OperationFailedPayload,
  artifact_produced: ArtifactProducedPayload,
  knowledge_delivered: KnowledgeDeliveredPayload,
  knowledge_written: KnowledgeWrittenPayload,
  knowledge_checked: KnowledgeCheckedPayload,
  feedback_requested: FeedbackRequestedPayload,
  feedback_provided: FeedbackProvidedPayload,
  plan_annotated: PlanAnnotatedPayload,
  plan_note_written: PlanNoteWrittenPayload,
  analysis_completed: AnalysisCompletedPayload,
  models_discovered: ModelsDiscoveredPayload,
  copilot_exchange: CopilotExchangePayload,
  reaction_failed: ReactionFailedPayload,
  commit_recorded: CommitRecordedPayload,
  workspace_created: WorkspaceCreatedPayload,
  workspace_retitled: WorkspaceRetitledPayload,
  workspace_archived: WorkspaceArchivedPayload,
  workspace_merged: WorkspaceMergedPayload,
  chat_opened: ChatOpenedPayload,
  project_identified: ProjectIdentity,
} satisfies Record<EventKind, z.ZodType>

export type EventPayload<K extends EventKind> = z.input<(typeof PAYLOAD_SCHEMAS)[K]>

type EventBody<K extends EventKind> = { kind: K; payload: EventPayload<K> }

export type EventDraft = {
  [K in EventKind]: EventBody<K> & { usage?: Usage | null; idempotencyKey?: string }
}[EventKind]

// built on Origin so chatId and door are spelled once
const EventStamp = Origin.extend({
  taskId: z.string().min(1).nullable(),
  stepId: z.string().min(1).nullable(),
  runToken: z.string().min(1).nullable(),
  usage: Usage.nullable().optional(),
  // deterministic writers supply a key; the log's project/key uniqueness absorbs retries
  idempotencyKey: z.string().min(1).nullable().default(null),
})

// opaque until redaction: a zod error must never quote a secret
export const EventEnvelope = EventStamp.extend({
  kind: z.enum(EventKind),
  payload: z.record(z.string(), z.unknown()),
})

export type EventInput = {
  [K in EventKind]: z.input<typeof EventStamp> & EventBody<K>
}[EventKind]

