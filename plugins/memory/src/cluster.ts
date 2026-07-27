// The grouping ALGORITHM and nothing else: no database, no embedder, no clock. Kept pure so the
// partition is unit-testable with hand-written vectors, and so swapping it (HDBSCAN, c-TF-IDF labels)
// touches this file alone — that is the designated extension seam.

export interface ClusterInput { id: string; vector: readonly number[] }
export interface Cluster { key: string; members: string[]; medoidClaimId: string }

// Cosine similarity at or above which two claims group together. Lives HERE, with the algorithm it
// tunes, rather than in the persistence module that happens to call it.
//
// MEASURED, and re-measured whenever the embedder changes — the two are ONE decision. A threshold
// is a cut through a particular model's cosine distribution, so porting a number across models is
// meaningless. Swept 0.50→0.90 over a real 52-claim corpus authored by agents through addClaims.
//
// Current: `ollama/mxbai-embed-large` (1024d) at 0.675, chosen from a genuine plateau — 0.670 and
// 0.680 produce an identical partition — giving 19 topics over 52 claims with 4 singletons, a
// largest group of 6, and 5 topics that span more than one note. Reading those groups confirms the
// arithmetic: synthesis claims land beside the specific claims they generalise, which is the lateral
// navigation topics exist for. Below ~0.55 the corpus collapses toward one blob; above ~0.72
// singletons take over and the inventory degenerates into one entry per claim, which is the thing
// topics exist to prevent.
//
// Previously `nomic-embed-text` (768d) at 0.70 — on the SAME corpus that scored 22 topics, 6
// singletons and only 3 cross-note groups, so the change is an improvement on every axis, not a
// preference. Before that, 0.75 was a pure guess and produced 16 singletons out of 22 topics.
//
// Limits, so the next reader does not over-trust it: n=52 from one repository, and grouping quality
// turned out to depend at least as much on how claims are PHRASED (claims that name their source
// file group far better) as on the model. `memory_topic_accessed` is the ongoing measurement.
export const MEMORY_CLUSTER_THRESHOLD = 0.675

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
