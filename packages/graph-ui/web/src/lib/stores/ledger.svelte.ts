import type { LogRow } from '$lib/api/types'
import { WORKING } from '$lib/event-kinds'
import { mergeOlder } from './ledger-merge'

const CAP = 400

// The event feed: the row list and the live-tail ticker; operator state lives elsewhere
class LedgerStore {
  // arrays are reassigned wholesale, so raw skips the deep proxy on the hottest state
  rows = $state.raw<LogRow[]>([])
  // Bumped by reset(): one pane GENERATION is one seq numbering; $state so effects can key on it
  generation = $state(0)
  // not $state: read only imperatively by add()/backfill, never in a reactive context
  lastRowSeq = 0
  // Live-tail window: grows on prepend by the merged length PLUS a fresh CAP, or add() evicts rows
  private cap = CAP
  /** the newest agent-loop event, shown as ONE live line instead of a row per event */
  working = $state.raw<LogRow | null>(null)

  /** false when the row was already narrated — the seq guard that dedupes backfill vs live */
  add(row: LogRow): boolean {
    if (row.seq <= this.lastRowSeq) return false
    this.lastRowSeq = row.seq
    // A FAILED tool result is never noise: an answer that did not take must say why
    if (WORKING.has(row.kind) && !row.failure) {
      this.working = row
      return true
    }
    // a lifecycle row supersedes the ticker; it re-appears on the next working event
    this.working = null
    this.rows = [...this.rows.slice(-(this.cap - 1)), row]
    return true
  }

  /** fold a backward page (rows older than rows[0]) in front of the pane — see mergeOlder */
  prepend(older: LogRow[]): void {
    this.rows = mergeOlder(this.rows, older)
    this.cap = this.rows.length + CAP
  }

  reset(fromSeq: number): void {
    this.rows = []
    this.working = null
    this.lastRowSeq = fromSeq
    this.cap = CAP
    this.generation += 1
  }
}

export const ledger = new LedgerStore()
