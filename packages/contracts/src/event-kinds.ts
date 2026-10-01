import type { Usage } from './execution'
import type { Door } from './origin'

// The event vocabulary and the stored envelope, in a LEAF module (zod + type-only imports, which
// erase at build time and so cannot put this module in an import cycle).
// `events` holds the PAYLOAD schemas, several of which live in modules that in turn need the
// event kinds — `memory` folds by kind, `analysis` is read back by kind. Keeping the vocabulary
// here means those modules never have to import `events` itself, so there is no cycle to reason
// about: a payload schema and the kind that names it can be defined in either order.
export enum EventKind {
  task_created = 'task_created',
  plan_proposed = 'plan_proposed',
  plan_edited = 'plan_edited',
  plan_approved = 'plan_approved',
  task_status_changed = 'task_status_changed',
  run_requested = 'run_requested',
  run_started = 'run_started',
  step_started = 'step_started',
  skill_loaded = 'skill_loaded',
  rate_limit_wait = 'rate_limit_wait',
  agent_call = 'agent_call',
  tool_call = 'tool_call',
  tool_result = 'tool_result',
  signal_received = 'signal_received',
  step_completed = 'step_completed',
  step_failed = 'step_failed',
  split_proposed = 'split_proposed',
  split_resolved = 'split_resolved',
  operation_started = 'operation_started',
  operation_completed = 'operation_completed',
  operation_failed = 'operation_failed',
  artifact_produced = 'artifact_produced',
  memory_written = 'memory_written',
  memory_deleted = 'memory_deleted',
  memory_accessed = 'memory_accessed',
  memory_topic_accessed = 'memory_topic_accessed',
  memory_verified = 'memory_verified',
  memory_outcome = 'memory_outcome',
  knowledge_delivered = 'knowledge_delivered',
  knowledge_written = 'knowledge_written',
  knowledge_checked = 'knowledge_checked',
  feedback_requested = 'feedback_requested',
  feedback_provided = 'feedback_provided',
  plan_annotated = 'plan_annotated',
  analysis_completed = 'analysis_completed',
  models_discovered = 'models_discovered',
  copilot_exchange = 'copilot_exchange',
  reaction_failed = 'reaction_failed',
  commit_recorded = 'commit_recorded',
  workspace_created = 'workspace_created',
  workspace_retitled = 'workspace_retitled',
  workspace_archived = 'workspace_archived',
  workspace_merged = 'workspace_merged',
  chat_opened = 'chat_opened',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const EVENT_KIND = EventKind

// the stored envelope: project binding and idempotency are explicit on every record
export interface EventRecord {
  seq: number
  projectId: string
  idempotencyKey: string | null
  // which interaction caused this event, null for one outside any. Never recoverable later: no
  // stored field says which of the interactions live at that instant this event belonged to.
  chatId: string | null
  // where this call entered. Never null: a chatless event that also lost its door would be
  // anonymous forever, indistinguishable from a CLI call, an MCP call or a hook's commit.
  door: Door
  taskId: string | null
  stepId: string | null
  runToken: string | null
  kind: EventKind
  payload: Record<string, unknown>
  usage: Usage | null
  ts: string
}
