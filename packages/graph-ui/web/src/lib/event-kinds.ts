import { EVENT_KIND } from '@orc/contracts/event-kinds'

// Kinds this UI reasons about, derived from the contract enum so a renamed kind fails the build
// instead of silently dropping out of invalidation, badges, or gate tracking.

/** kinds that can move a fetched view — the rest is agent-loop noise the ledger already carries */
export const STATE_CHANGE: ReadonlySet<string> = new Set<string>([
  EVENT_KIND.task_created,
  EVENT_KIND.task_status_changed,
  EVENT_KIND.run_requested,
  EVENT_KIND.run_started,
  EVENT_KIND.step_started,
  EVENT_KIND.step_completed,
  EVENT_KIND.step_failed,
  EVENT_KIND.plan_proposed,
  EVENT_KIND.plan_edited,
  EVENT_KIND.plan_approved,
  EVENT_KIND.plan_annotated,
  EVENT_KIND.split_proposed,
  EVENT_KIND.split_resolved,
  EVENT_KIND.analysis_completed,
  EVENT_KIND.feedback_requested,
  EVENT_KIND.feedback_provided,
  EVENT_KIND.memory_written,
  EVENT_KIND.memory_deleted,
  EVENT_KIND.memory_verified,
  EVENT_KIND.models_discovered,
  // both move a rendered pane: an artifact appears in the task view, a pull bumps its counter
  EVENT_KIND.artifact_produced,
  EVENT_KIND.memory_accessed,
])

/**
 * Agent-loop noise: every iteration emits several, they carry no state change, and one row each
 * buries the lifecycle rows an operator actually reads. The ledger collapses these into a single
 * in-place ticker line.
 */
export const WORKING: ReadonlySet<string> = new Set<string>([
  EVENT_KIND.agent_call,
  EVENT_KIND.tool_call,
  EVENT_KIND.tool_result,
  EVENT_KIND.operation_started,
  EVENT_KIND.operation_completed,
  EVENT_KIND.skill_loaded,
])

export { EVENT_KIND }
