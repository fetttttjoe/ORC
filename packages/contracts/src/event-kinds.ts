import { z } from 'zod'
import type { Usage } from './execution'

// The event vocabulary and the stored envelope, in a LEAF module (zod + a type-only import).
// `events` holds the PAYLOAD schemas, several of which live in modules that in turn need the
// event kinds — `memory` folds by kind, `analysis` is read back by kind. Keeping the vocabulary
// here means those modules never have to import `events` itself, so there is no cycle to reason
// about: a payload schema and the kind that names it can be defined in either order.
export const EventKind = z.enum([
  'task_created', 'plan_proposed', 'plan_edited', 'plan_approved', 'task_status_changed',
  'run_requested', 'run_started', 'step_started', 'skill_loaded', 'agent_call', 'tool_call', 'tool_result',
  'signal_received', 'step_completed', 'step_failed', 'split_proposed', 'split_resolved',
  'operation_started', 'operation_completed', 'operation_failed', 'artifact_produced',
  'memory_written', 'memory_deleted', 'memory_accessed', 'memory_topic_accessed', 'memory_verified',
  'feedback_requested', 'feedback_provided', 'plan_annotated', 'analysis_completed',
  'models_discovered', 'copilot_exchange', 'reaction_failed', 'commit_recorded',
])
export type EventKind = z.infer<typeof EventKind>

export const EVENT_KIND = EventKind.enum

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
