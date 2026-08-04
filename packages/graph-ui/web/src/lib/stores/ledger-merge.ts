// Pure merge for backward paging: rows fetched from before the ledger's oldest row, folded in
// front of what is already on screen. Zero runtime imports — the dedupe/order contract lives
// here and the test pins it.
import type { LogRow } from '$lib/api/types'

/**
 * A fetched history page filtered by the SAME rule the live tail applies in add(): ticker kinds
 * collapse into the working line, except a failed one, which is never noise. Without this, paging
 * backward rendered what the live feed suppresses — observed 2026-08-03: a 150-row page was mostly
 * tool_call/operation_* rows, burying the lifecycle rows the ledger is read by. The ticker set is
 * a parameter so this file keeps zero runtime imports (the cluster.ts shape).
 */
export function dropTicker(rows: readonly LogRow[], ticker: ReadonlySet<string>): LogRow[] {
  return rows.filter(r => !ticker.has(r.kind) || Boolean(r.failure))
}

/**
 * Prepend `older` to `existing`, keeping seq strictly ascending. Rows at or past the current
 * head are dropped rather than trusted: the fetch races live SSE appends, and a row that arrived
 * twice would render twice under a keyed each — the exact failure the copilot pane had.
 */
export function mergeOlder(existing: readonly LogRow[], older: readonly LogRow[]): LogRow[] {
  const head = existing[0]?.seq ?? Number.POSITIVE_INFINITY
  const seen = new Set<number>()
  const kept: LogRow[] = []
  for (const row of older) {
    if (row.seq >= head || seen.has(row.seq)) continue
    seen.add(row.seq)
    kept.push(row)
  }
  kept.sort((a, b) => a.seq - b.seq)
  return [...kept, ...existing]
}
