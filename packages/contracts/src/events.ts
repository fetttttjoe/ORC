import { z } from 'zod'
import { TaskNode, TaskStatus } from './task'
import { Plan } from './plan'
import { FailureClass, Signal, SplitResult, Usage } from './execution'
import { EventKind } from './event-kinds'
import { OperationCompletedPayload, OperationFailedPayload, OperationStartedPayload } from './operations'
import { MemoryAccessedPayload, MemoryDeletedPayload, MemoryOutcomePayload, MemoryVerifiedPayload, MemoryWrittenPayload } from './memory'
import { MemoryTopicAccessedPayload } from './cluster'
import { SHA256_HEX_RE } from './ids'
import { AnalysisCompletedPayload, FeedbackProvidedPayload, FeedbackRequestedPayload, PlanAnnotatedPayload } from './analysis'

// typed so folds can parse receipts without casts
export const ArtifactProducedPayload = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(SHA256_HEX_RE),
  size: z.number().int().nonnegative(),
})
export type ArtifactProducedPayload = z.infer<typeof ArtifactProducedPayload>

// the provider's live catalog at discovery time — append-on-change only, so the latest event
// per provider IS the catalog and history shows drift. Bounded: a catalog is not a blob dump.
export const ModelsDiscoveredPayload = z.object({
  providerId: z.string().min(1).max(64),
  models: z.array(z.string().min(1).max(128)).max(500),
})
export type ModelsDiscoveredPayload = z.infer<typeof ModelsDiscoveredPayload>

// one completed copilot exchange (P6): the conversation that CAUSED an action is part of the
// record, not browser state — appended by the graph server after the stream ends, usage on the
// envelope, redacted at the storage boundary like every event. Tool calls are one-line
// summaries; the actions they triggered have their own full-fidelity events.
export const CopilotExchangePayload = z.object({
  user: z.string(),
  assistant: z.string(),
  toolCalls: z.array(z.object({ toolName: z.string().min(1), summary: z.string() })).max(64),
  modelRef: z.string().min(1),
})
export type CopilotExchangePayload = z.infer<typeof CopilotExchangePayload>

export { EventKind, EVENT_KIND, type EventRecord } from './event-kinds'

// A supervisor reaction that threw. The reactions are the runtime's whole job — turn a recorded ask
// into a workflow, cancel what a client stamped cancelled, carry an answer into a parked step — and
// a throw used to leave nothing but a console.warn on the supervisor's stdout: the client had
// already been told its ask was recorded, `orc status` showed a task that simply never moved, and
// the only evidence sat in a log nobody reads. Recorded instead, so "nobody could start this" is
// DATA — visible in status, the graph, and a bench row — rather than a silence that reads as a hang.
export const REACTION = {
  runRequested: 'run_requested',
  cancelled: 'cancelled',
  childApproved: 'child_approved',
  feedback: 'feedback',
  splitResolve: 'split_resolve',
  // the auto-heal reactor: a recorded out-of-task commit triggers the restamp/heal pass the
  // operator otherwise runs by hand (knowledge provenance plan T2)
  commitRecorded: 'commit_recorded',
} as const
export type Reaction = (typeof REACTION)[keyof typeof REACTION]

export const ReactionFailedPayload = z.object({
  // derives from the map — a sixth reaction added to REACTION must not first surface as a
  // parse failure on the failure-RECORDING path when that reaction first fails
  reaction: z.enum(REACTION),
  taskId: z.string().min(1).nullable(),
  message: z.string(),
  // the seq of the event whose reaction failed, so the read side can point at the exact cause.
  // Null when the trigger was a split's STATE rather than one event (an unresolved join).
  causeSeq: z.number().int().nonnegative().nullable(),
})
export type ReactionFailedPayload = z.infer<typeof ReactionFailedPayload>

// A hand-made commit recorded outside any task by a post-commit hook, captured for log traceability
// and drift healing. sha is the commit's 40-hex SHA-1 (or other VCS sha), paths are the changed files.
// paths MAY be empty — an empty commit touches nothing.
const HEX_RE = /^[a-f0-9]+$/i
export const CommitRecordedPayload = z.object({
  sha: z.string().min(1).regex(HEX_RE, 'sha must be hex digits'),
  paths: z.array(z.string().min(1)),
})
export type CommitRecordedPayload = z.infer<typeof CommitRecordedPayload>

// The explicit ask for a run. NOT inferred from "approved with no live run": `orc propose` +
// `orc approve` deliberately does not start anything, and inference would silently change that.
// It also carries what only the caller knows — a --cwd override, and whether this is a retry —
// so a client holding no execution port can still express both.
export const RunRequestedPayload = z.object({
  taskId: z.string().min(1),
  cwd: z.string().nullable(),
  retry: z.boolean(),
})
export type RunRequestedPayload = z.infer<typeof RunRequestedPayload>

export const PAYLOAD_SCHEMAS = {
  task_created: z.object({ task: TaskNode }),
  plan_proposed: z.object({ plan: Plan }),
  plan_edited: z.object({ plan: Plan }),
  plan_approved: z.object({
    taskId: z.string().min(1),
    version: z.number().int().positive(),
    approvedAt: z.string(),
    approvedBy: z.enum(['human', 'policy', 'mcp']), // mcp = an external agent under --autonomy full (P7)
    ruleIndex: z.number().int().nonnegative().optional(), // which ApprovalPolicy rule matched
  }),
  task_status_changed: z.object({ taskId: z.string().min(1), from: TaskStatus, to: TaskStatus }),
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
  split_resolved: SplitResult,      // the join payload IS the event payload (spec D5) — composed, not re-spelled
  operation_started: OperationStartedPayload,
  operation_completed: OperationCompletedPayload,
  operation_failed: OperationFailedPayload,
  artifact_produced: ArtifactProducedPayload,
  memory_written: MemoryWrittenPayload,
  memory_deleted: MemoryDeletedPayload,
  memory_accessed: MemoryAccessedPayload,
  memory_topic_accessed: MemoryTopicAccessedPayload,
  memory_verified: MemoryVerifiedPayload,
  memory_outcome: MemoryOutcomePayload,
  feedback_requested: FeedbackRequestedPayload,
  feedback_provided: FeedbackProvidedPayload,
  plan_annotated: PlanAnnotatedPayload,
  analysis_completed: AnalysisCompletedPayload,
  models_discovered: ModelsDiscoveredPayload,
  copilot_exchange: CopilotExchangePayload,
  reaction_failed: ReactionFailedPayload,
  commit_recorded: CommitRecordedPayload,
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


