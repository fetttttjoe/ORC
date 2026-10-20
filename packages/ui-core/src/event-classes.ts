// a leaf-only import: the browser takes this file without the rest of @orc/contracts
import { EVENT_KIND } from '@orc/contracts/event-kinds'

// both sides of the wire ask this: a per-side copy of either set is a disagreement nothing reports

// kinds that can move a fetched view; the rest is agent-loop noise the ledger carries
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

// agent-loop noise: no state change, and a row each would bury lifecycle rows in the ledger
export const WORKING: ReadonlySet<string> = new Set<string>([
  EVENT_KIND.agent_call,
  EVENT_KIND.tool_call,
  EVENT_KIND.tool_result,
  EVENT_KIND.operation_started,
  EVENT_KIND.operation_completed,
  EVENT_KIND.skill_loaded,
])
