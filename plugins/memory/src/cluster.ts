// The grouping ALGORITHM and nothing else: no database, no embedder, no clock. Kept pure so the
// partition is unit-testable with hand-written vectors, and so swapping it (HDBSCAN, c-TF-IDF labels)
// touches this file alone — that is the designated extension seam.

export interface ClusterInput { id: string; vector: readonly number[] }
export interface Cluster { key: string; members: string[]; medoidClaimId: string }

// Cosine similarity at or above which two claims group together. Lives HERE, with the algorithm it
// tunes, rather than in the persistence module that happens to call it.
//
// MEASURED, and re-measured whenever the embedder OR the corpus size changes — those are one
// decision with the threshold. A cut through a model's cosine distribution does not port across
// models, and it does not port across corpus sizes either: the same value that was well-tuned at 52
// claims fragmented at 93.
//
// Current: `ollama/mxbai-embed-large` (1024d) at 0.65, chosen on a 93-claim sweep of a corpus
// authored by agents through addClaims, because there it DOMINATED the previous 0.675 rather than
// trading against it — identical group structure (23 multi-claim groups, largest 8) with 6 fewer
// isolated claims and one more group spanning multiple notes:
//
//   thresh  topics  single  multi  cross-note  largest
//   0.600     18       4     14       10         20     one 20-claim blob; groups by package
//   0.625     26       7     19       13         14     largest still package-shaped
//   0.650     38      15     23       13          8     <- chosen
//   0.675     44      21     23       12          8     same structure, 6 more singletons
//   0.700     56      30     26       12          5     singletons take over
//
// The groups were READ, not just counted, which is what the numbers cannot tell you: at 0.65 the
// multi-note groups are genuine themes — operation-journal completeOperation/rebuildOperations with
// crashDedupKey and makeOperation (idempotency across storage/kernel/execution), and
// releaseWriteClaims with claimWrite, the zone fence and verifyArtifacts. Below 0.65 the largest
// group degenerates into "claims about the same package" rather than about the same subject.
//
// THE DOMINATION IS GONE AT 113 CLAIMS. Re-swept 2026-07-28, same bands, same embedder, live corpus:
//
//   thresh  topics  single  multi  cross-note  largest
//   0.600     18       5     13       11         21
//   0.625     29       8     21       15         12
//   0.650     34      11     23       16          9     <- shipping
//   0.675     48      16     32       19          5
//   0.700     60      31     29       16          5
//
// 0.675 no longer produces "the same structure with more singletons": it now yields 32 multi-claim
// groups against 0.65's 23 and 19 cross-note against 16, i.e. it splits 0.65's coarser groups into
// more of them. So the choice is a TRADE again — 0.65 keeps 5 fewer claims isolated, 0.675 finds
// more distinct themes — and the argument written above no longer selects it. Left at 0.65
// deliberately: the numbers cannot say whether 0.675's extra groups are themes or splinters, and
// only reading them can, which is what chose 0.65 the last time and has not been redone. This is
// the second time this constant's justification has expired with corpus growth (52 → 93 → 113); it
// is a re-sweep schedule, not a one-time cut.
//
// Previously 0.675, chosen on a 52-claim corpus where 0.670 and 0.680 produced an identical
// partition. That plateau no longer exists at 93 claims — the curve degrades smoothly — which is
// itself the finding: this constant needs re-sweeping as the corpus grows, not once.
//
// Limits, so the next reader does not over-trust it: n=93 from one repository, and grouping quality
// still depends at least as much on how claims are PHRASED (claims naming their source file group
// far better; 69% of this corpus does) as on the threshold. `memory_topic_accessed` is the ongoing
// measurement.
export const MEMORY_CLUSTER_THRESHOLD = 0.65

const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0)

// Zero-scale yields 0, not NaN: one degenerate embedding would otherwise poison every comparison it
// took part in, and NaN fails every threshold test silently rather than visibly.
//
// A DIMENSION MISMATCH is a different failure and must not be quiet. `dot` zero-pads the shorter
// vector, so comparing a 384d claim with a 1024d one returns a plausible number that is not a
// similarity — every cross-model pair scores low, the partition splits along the model boundary
// rather than along meaning, and the inventory looks merely "less clustered" instead of broken.
// Reachable without doing anything wrong: change `memoryEmbedModel` and skip `orc memory rebuild`
// (config.ts documents the rebuild as required; nothing enforces it), and claims re-embed only as
// their notes are rewritten — so the corpus is mixed for as long as that takes.
// Throwing names the real cause at the first comparison instead of letting a rebuild-shaped problem
// masquerade as a threshold-shaped one.
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length)
    throw new Error(`cosine: ${a.length}d vs ${b.length}d — the corpus holds vectors from two embedding models; run 'orc memory rebuild' to re-embed everything with the configured one`)
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

// The topic's NAME, derived from the medoid claim above — an index entry, not the fact itself.
//
// A claim is a standalone sentence (several hundred characters is normal, the cap is 1000), and
// using it whole made the label the entire visible row of `orc memory topics` and the whole of an
// agent's memory_topics budget: one topic could eat the listing the inventory exists to provide.
// The full sentence is one call away — `memory_topics <topicKey>` returns the members verbatim —
// so the inventory's job is to let a reader TELL topics apart, and a head does that: this corpus's
// claims lead with the source path or subject they are about (the paths lint pushes writers that
// way), which is exactly the distinguishing part. Verified against ~20 real claims before settling.
//
// Pure and prefix-verbatim on purpose:
//   * `cap` is passed IN, not imported — this file keeps zero imports so the partition stays
//     unit-testable and rebuild-identical; the value lives with the other ceilings
//     (MEMORY_LIMITS.topicLabelChars) where the contract bound and the CLI row agree on it.
//   * whitespace is collapsed because a label is one terminal row, and a claim may carry newlines.
//   * the cut lands on a word boundary at or before the cap, so no word is halved, and the result
//     is a verbatim prefix — a reader can trust that the label is literally how the claim starts,
//     rather than a paraphrase they then fail to find in the full text.
//   * '…' marks that there IS more, and is counted inside the cap: the promise "never longer than
//     the cap" is what the 80-column row arithmetic depends on.
// No clock, no locale, no arrival order, no model: same claim in, same label out, so a wholesale
// stage-3 rebuild reproduces the inventory byte-for-byte.
//
// If the heads ever stop distinguishing topics (many topics sharing one leading path, say), the
// pre-registered upgrade is c-TF-IDF labels — the spec's deferral rests on the medoid already
// being free, and it stays valid only while a head is legible. That upgrade brings tokenization,
// stopwords and cross-cluster term statistics; it belongs in THIS file, whole, and not as a
// stopword list sprinkled through the callers. An LLM label is not an option here: a model call
// inside a stateless recompute breaks rebuild-identical derivation.
export function topicLabel(claimText: string, cap: number): string {
  const flat = claimText.replace(/\s+/g, ' ').trim()
  if (flat.length <= cap) return flat
  // one character of the budget belongs to the elision mark
  const head = flat.slice(0, cap - 1)
  const cut = head.lastIndexOf(' ')
  // cut === -1 is a single token longer than the whole cap (a URL, a long path): bounded beats
  // whole-word there, since an unbounded row breaks the surface the cap exists to protect.
  return `${cut > 0 ? head.slice(0, cut) : head}…`
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
// Cost: one n(n-1)/2 cosine matrix, then at most n merge rounds, each RESCANNING every surviving
// group pair and recomputing each pair's average link from scratch — naive O(n^3), and the merge
// loop, not the matrix, is what dominates.
//
// MEASURED [sourced], cluster-bench.test.ts, 1024d synthetic vectors shaped to the live corpus's
// own 2026-07-28 sweep (~3.3 claims/topic), threshold 0.65, two independent runs on different
// machines — the spread between them is machine variance, not noise within a run:
//
//   n=100  ->  34 groups   ~100-170ms
//   n=250  ->  84 groups   ~0.8-1.5s
//   n=500  -> 167 groups   ~6-13s
//
// So "microseconds at tens of claims" and "fine to a few thousand claims", which this comment used
// to say, were both wrong by orders of magnitude. At the live corpus (113 claims) a partition costs
// ~150-250ms [derived, interpolated from n=100]; the near-cubic curve crosses the projector's
// 1000ms SLOW_TOPIC_REFRESH_MS ceiling at roughly n≈200-250 claims [derived, interpolated], not at
// the n≈1,000 the grouping spec's own cost table suggested — that table priced the cosine MATRIX
// (~500k pairs ≈ 0.5s at n=1,000) and not this merge loop.
//
// ponytail: CEILING — this stays adequate while the project-scope claim corpus is under ~200 claims
// (currently 113). Past that, the pre-registered upgrade path is, in order:
//   L1  reusable cosine memo keyed by sorted id pair — a new claim costs O(n) cosines, not O(n^2);
//   L2  priority queue + Lance-Williams update, deriving a merged cluster's average link
//       arithmetically from the two pre-merge linkages — O(n^2 log n) instead of this O(n^3).
// Both preserve order-independence and are specified to produce BYTE-IDENTICAL output, so they are
// pure speed and need no re-tuning of MEMORY_CLUSTER_THRESHOLD. Only past those does approximation
// start: kNN sparsification (~10k claims), then HDBSCAN.
//
// NOT YET BUILT, deliberately: L1+L2 were gated at plan approval on first attributing the observed
// >1000ms refresh, and the attribution (see the `attribute-refresh-cost` finding) landed on Surreal
// I/O rather than on cosines at THIS corpus size — the numbers above are exactly why. Build them
// when the corpus approaches ~200 claims or when SLOW_TOPIC_REFRESH_MS fires with partition() itself
// timed as the cost, whichever comes first.
//
// The HDBSCAN pointer this comment used to carry was a mis-aimed reference: HDBSCAN is a separate,
// LATER lever with a different trigger (visibly mis-split groups at ~1,000 claims) and it is a
// behaviour change, not a speed-up. It is not the answer to a slow partition.
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
