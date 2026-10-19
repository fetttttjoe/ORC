// the event vocabulary comes from contracts, never a second spelling: event-kinds.ts is a leaf
// module (zod + a type-only import), so the browser can take this file without the rest of
// @orc/contracts
import { EVENT_KIND } from '@orc/contracts/event-kinds'

// How a kind READS to someone holding a rendered view: does it move something, or is it the agent
// loop talking to itself? Both sides of the wire ask that question — the views decide what one
// event makes stale, the ledger decides which rows collapse into a ticker — and a per-side copy of
// either set is a disagreement nothing reports: the pane simply stops refreshing, or the feed
// scrolls past the one line an operator was waiting for.

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
  EVENT_KIND.plan_note_written,
  EVENT_KIND.split_proposed,
  EVENT_KIND.split_resolved,
  EVENT_KIND.analysis_completed,
  EVENT_KIND.feedback_requested,
  EVENT_KIND.feedback_provided,
  EVENT_KIND.models_discovered,
  // an artifact appears in the task view
  EVENT_KIND.artifact_produced,
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
