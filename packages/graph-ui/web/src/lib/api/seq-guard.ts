// Zero imports on purpose — the cluster.ts shape: the seq-ordering rule is a pure comparison,
// testable and reusable with no query-client or fetch behind it.

/**
 * Keep whichever of two seq-stamped answers is FRESHER, never the one that merely arrived last.
 *
 * A view's fetch can race a fresher one queued behind it: an SSE touch invalidates a query and
 * triggers a refetch while an earlier request for the same key is still in flight, and if that
 * earlier one resolves SECOND it must not overwrite the fresher cached value with stale data. Equal
 * seqs take the incoming answer — same log position, so the newer response is at least as current
 * and a strict `>` would pin the client to whichever one happened to be held first.
 */
export function newer<T extends { seq: number }>(held: T | undefined, incoming: T): T {
  return held !== undefined && held.seq > incoming.seq ? held : incoming
}
