// The grouping ALGORITHM and nothing else: no database, no embedder, no clock. Kept pure so the
// partition is unit-testable with hand-written vectors, and so swapping it (HDBSCAN, c-TF-IDF labels)
// touches this file alone — that is the designated extension seam.

export interface ClusterInput { id: string; vector: readonly number[] }
export interface Cluster { key: string; members: string[]; medoidClaimId: string }

// Cosine similarity at or above which two claims group together. A GUESS, not a measured value: tens
// of claims cannot distinguish a good split from luck. Settled from `memory_topic_accessed` events —
// see the claim-grouping spec's "How it gets settled". Lives HERE, with the algorithm it tunes,
// rather than in the persistence module that happens to call it.
export const MEMORY_CLUSTER_THRESHOLD = 0.75

const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0)

// Zero-scale yields 0, not NaN: one degenerate embedding would otherwise poison every comparison it
// took part in, and NaN fails every threshold test silently rather than visibly.
export function cosine(a: readonly number[], b: readonly number[]): number {
  const scale = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b))
  return scale === 0 ? 0 : dot(a, b) / scale
}

// Ascending by plain `<`, not `localeCompare`: a pure function must not read the ambient ICU locale,
// and claim ids are content hashes, not natural-language text, so locale collation buys nothing —
// used for every "lowest id wins" tie-break below so they all agree with each other and with the key.
export const ascending = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// The member with the highest MEAN similarity to the rest — the cluster's most representative
// statement, which is what a reader sees as its label. Sorted first and compared with strict `>`, so a
// tie resolves on the lowest id rather than on iteration order.
export function medoidOf(members: readonly ClusterInput[]): string {
  const sorted = [...members].sort((a, b) => ascending(a.id, b.id))
  // sorted[0] is undefined only for an empty `members`; `partition` never calls this with one (every
  // group it builds holds at least one id), so this is the boundary value if that ever stops holding.
  let best = { id: sorted[0]?.id ?? '', mean: -Infinity }
  for (const m of sorted) {
    const others = sorted.filter(o => o.id !== m.id)
    const mean = others.length === 0
      ? 1
      : others.reduce((sum, o) => sum + cosine(m.vector, o.vector), 0) / others.length
    if (mean > best.mean) best = { id: m.id, mean }
  }
  return best.id
}

// Lexicographic order over components, zero-padding the shorter vector exactly as `dot` does. Only
// used to pick between two vectors claiming the same id (see `partition`), where any total order
// derived from the values will do — what matters is that it reads no position and no clock.
const lowerVector = (a: readonly number[], b: readonly number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

// Average-link agglomerative clustering with a cosine threshold.
//
// Merging the GLOBALLY best pair each round — rather than the first pair that clears the threshold —
// is what makes the result independent of input order. A leader/threshold-join algorithm assigns each
// point as it arrives and is documented to produce different partitions for different arrival orders;
// that also made "re-cluster on rebuild" a no-op, since a rebuild replays the same order.
//
// Cost: one n(n-1)/2 cosine matrix, then at most n merge rounds over the surviving group pairs. At the
// corpus this is sized for (tens of claims) that is microseconds.
// ponytail: naive O(n^3) worst case in the merge loop — fine to a few thousand claims; past that,
// see the spec's HDBSCAN revisit trigger.
export function partition(claims: readonly ClusterInput[], threshold: number): Cluster[] {
  // Dedupe by id first, then build the matrix and the group list from that map — not from `claims`
  // directly — so a claim id that appears twice (e.g. re-embedded mid-corpus) can't make the matrix
  // depend on which occurrence is later in array order. That would smuggle input-order dependence back
  // into a function whose whole contract is that there is none.
  //
  // A conflicting duplicate is resolved by vector CONTENT, never by array position. `new Map(
  // claims.map(…))` kept the LAST occurrence — but so would keeping the FIRST: both are positional,
  // and either one still returns a different partition for `[a:v1, a:v2, b]` than for the same three
  // reversed. Reachable when two claim rows share a claimId and their vectors differ, i.e. after an
  // embedding-model change without a rebuild. Which vector is "right" is unknowable here; that the
  // answer not depend on the order SurrealDB handed the rows back is the whole contract.
  const byId = new Map<string, ClusterInput>()
  for (const c of claims) {
    const prev = byId.get(c.id)
    if (!prev || lowerVector(c.vector, prev.vector)) byId.set(c.id, c)
  }
  const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`)
  const sim = new Map<string, number>()
  for (const a of byId.values())
    for (const b of byId.values())
      if (a.id < b.id) sim.set(pairKey(a.id, b.id), cosine(a.vector, b.vector))

  // groups stay id-sorted, and so does the list of groups, so every tie below breaks the same way
  let groups = [...byId.keys()].sort().map(id => [id])

  const linkage = (left: readonly string[], right: readonly string[]): number => {
    let total = 0
    for (const a of left) for (const b of right) total += sim.get(pairKey(a, b)) ?? 0
    return total / (left.length * right.length)
  }

  for (;;) {
    let best = { left: -1, right: -1, score: -Infinity }
    for (let i = 0; i < groups.length; i++)
      for (let j = i + 1; j < groups.length; j++) {
        const score = linkage(groups[i], groups[j])
        // strict `>` keeps the earliest (lowest-id) pair when scores tie
        if (score >= threshold && score > best.score) best = { left: i, right: j, score }
      }
    if (best.left === -1) break
    const merged = [...groups[best.left], ...groups[best.right]].sort()
    groups = groups.filter((_, k) => k !== best.left && k !== best.right)
    groups.push(merged)
    groups.sort((a, b) => ascending(a[0], b[0]))
  }

  return groups.map(members => ({
    // the lowest member id: content-derived (claim ids are hashes) and reproducible from the member
    // set alone, so it is not a positional identifier
    key: members[0],
    members,
    medoidClaimId: medoidOf(
      members.map(id => byId.get(id)).filter((c): c is ClusterInput => c !== undefined),
    ),
  }))
}
