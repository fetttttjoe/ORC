// Pure merge for backward paging: older rows fold in front of those on screen; zero runtime imports
import type { LogRow } from '$lib/api/types'

// A fetched page filtered by the live tail's rule: ticker kinds collapse, a failed one never does
export function dropTicker(rows: readonly LogRow[], ticker: ReadonlySet<string>): LogRow[] {
  return rows.filter(r => !ticker.has(r.kind) || Boolean(r.failure))
}

// Prepend older rows keeping seq ascending: rows at or past the head are dropped, not trusted
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
