import type { LogRow } from '$lib/api/types'
import { WORKING } from '$lib/event-kinds'
import { mergeOlder } from './ledger-merge'

const CAP = 400

/**
 * The project's event feed, as the operator scrolls it. Open questions, retryability and which
 * tasks have a plan worth showing all moved to operator.svelte.ts — the server pushes them as one
 * value on the stream frame (`OperatorState`), so a second fold of the SAME events here could only
 * disagree with it. This store owns exactly what is left: the row list itself and the live-tail
 * ticker.
 */
class LedgerStore {
  // both arrays are reassigned wholesale on every write (never mutated), so raw skips the
  // deep proxy on the hottest state in the app
  rows = $state.raw<LogRow[]>([])
  // Bumped by reset(): the pane's GENERATION. Paging state (cursor, exhausted) belongs to one
  // seq numbering, and a reset is the signal that numbering died — project switch, purge,
  // seq regression — while the project id alone misses the same-project reseeds. $state so a
  // consumer can key an effect on it.
  generation = $state(0)
  // not $state: read only imperatively by add()/backfill, never in a reactive context
  lastRowSeq = 0
  // The live-tail window. Grows when the operator pages into history (prepend) to the merged
  // length PLUS a fresh CAP of headroom: with cap set to the merged length exactly, the very
  // next lifecycle add() evicted the oldest just-loaded row (slice(-(cap-1)) + append lands
  // back at cap), silently eating the page one live event at a time. reset() restores the
  // default. not $state: read only inside add(), never rendered.
  private cap = CAP
  /** the newest agent-loop event, shown as ONE live line instead of a row per event */
  working = $state.raw<LogRow | null>(null)

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
