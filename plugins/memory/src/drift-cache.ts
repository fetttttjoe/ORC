// Drift is `f(corpus, tree)`, and both inputs have an exact, cheap identity — the projection CURSOR
// and a tree fingerprint. Recomputing it costs 336ms of per-revision `git diff` calls (measured,
// 13 distinct revisions over 112 notes) and the console's banner asks for it every 3 seconds, so
// the read path spent roughly a sixth of wall-clock re-deriving an answer that had not changed.
//
// EXACT invalidation, never a TTL. A TTL trades correctness for cost and picks the trade by
// guessing; keying on (cursor, fingerprint) cannot serve a stale answer, because every way the
// answer could change moves one of the two. That distinction is the whole reason this is safe to
// put on a polled path.
//
// Pure over its dependencies so the rule is testable without git, Surreal or a clock.

/**
 * Returns a function of (cursor, compute). Same cursor AND same tree → the memoized value; either
 * moved → recompute. An unfingerprintable tree recomputes every time: with nothing to invalidate
 * against, a hit could serve a verdict for a tree that has completely changed.
 *
 * `compute` is passed PER CALL rather than captured once, because the caller's handle (a Surreal
 * connection re-opened per probe) is younger than the cache. Capturing it would memoize a closure
 * over a connection that is already closed.
 */
export function createDriftCache<T>(
  fingerprint: () => Promise<string | null>,
): (cursor: number, compute: () => Promise<T>) => Promise<T> {
  let memo: { key: string; value: T } | null = null
  return async (cursor, compute) => {
    const fp = await fingerprint()
    // the cursor alone is not enough: the corpus can sit still while the tree moves under it, which
    // is precisely the case drift exists to detect
    const key = fp === null ? null : `${cursor}:${fp}`
    if (key !== null && memo !== null && memo.key === key) return memo.value
    const value = await compute()
    if (key !== null) memo = { key, value }
    return value
  }
}
