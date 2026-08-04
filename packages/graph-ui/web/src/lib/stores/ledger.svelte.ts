import type { LogRow } from '$lib/api/types'
import { EVENT_KIND, WORKING } from '$lib/event-kinds'

const CAP = 400

// events that create or reshape a plan — the feed shows that task's plan card from here on
const PLAN_SHAPING: ReadonlySet<string> = new Set<string>([
  EVENT_KIND.plan_proposed,
  EVENT_KIND.plan_edited,
  EVENT_KIND.plan_approved,
  EVENT_KIND.split_resolved,
])

export interface OpenGate {
  taskId: string
  stepId: string | null
  question: string
  seq: number
}

class LedgerStore {
  // both arrays are reassigned wholesale on every write (never mutated), so raw skips the
  // deep proxy on the hottest state in the app
  rows = $state.raw<LogRow[]>([])
  // not $state: read only imperatively by add()/backfill, never in a reactive context
  lastRowSeq = 0
  gates = $state.raw<OpenGate[]>([])
  /** tasks whose newest step outcome is a failure — a retry is offered until a new attempt starts */
  retryable = $state.raw<string[]>([])
  /** the newest agent-loop event, shown as ONE live line instead of a row per event */
  working = $state.raw<LogRow | null>(null)
  /** tasks whose plan is worth showing in the feed — set by the events that create or move one */
  planned = $state.raw<string[]>([])

  /** false when the row was already narrated — the seq guard that dedupes backfill vs live */
  add(row: LogRow): boolean {
    if (row.seq <= this.lastRowSeq) return false
    this.lastRowSeq = row.seq
    // A FAILED tool result is never noise, whatever kind carries it: an answer that did not take
    // must say why. Collapsing it into the ticker made a refusal indistinguishable from silence —
    // the exact defect the failure card exists to prevent.
    if (WORKING.has(row.kind) && !row.failure) {
      this.working = row
      return true
    }
    // a lifecycle row supersedes the ticker; it re-appears on the next working event
    this.working = null
    this.rows = [...this.rows.slice(-(CAP - 1)), row]
    if (row.kind === EVENT_KIND.feedback_requested && row.taskId)
      this.gates = [...this.gates.filter(g => g.taskId !== row.taskId), { taskId: row.taskId, stepId: row.stepId, question: row.line, seq: row.seq }]
    if (row.kind === EVENT_KIND.feedback_provided && row.taskId) this.gates = this.gates.filter(g => g.taskId !== row.taskId)
    if (PLAN_SHAPING.has(row.kind) && row.taskId && !this.planned.includes(row.taskId))
      this.planned = [...this.planned, row.taskId]
    if (row.kind === EVENT_KIND.step_failed && row.taskId && !this.retryable.includes(row.taskId))
      this.retryable = [...this.retryable, row.taskId]
    // a new attempt supersedes the offer: a stale retry button must not double-start a run
    if ((row.kind === EVENT_KIND.step_started || row.kind === EVENT_KIND.run_started) && row.taskId)
      this.retryable = this.retryable.filter(id => id !== row.taskId)
    return true
  }

  /** a task that terminated with its question open cannot be answered — retire the gate */
  retireGatesFor(taskId: string, terminal: boolean): void {
    if (terminal) this.gates = this.gates.filter(g => g.taskId !== taskId)
  }

  reset(fromSeq: number): void {
    this.rows = []
    this.gates = []
    this.retryable = []
    this.working = null
    this.planned = []
    this.lastRowSeq = fromSeq
  }
}

export const ledger = new LedgerStore()
