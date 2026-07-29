// The BEFORE curve for the claim-grouping spec's L1 (cosine-matrix cache) / L2 (heap + Lance-
// Williams merge) levers — see docs/superpowers/specs/2026-07-26-claim-grouping-design.md's
// scaling section and the attribute-refresh-cost finding this file backs (area-topic-clustering).
//
// Deliberately network-free and embedder-free: partition() takes ClusterInput[] (id + vector) and
// nothing else (cluster.ts is import-free BY DESIGN, see its own header comment), so this file
// SYNTHESIZES vectors instead of calling an embedder — deterministic, fast to set up, and immune to
// an embedder being unavailable in CI.
//
// The synthesis mimics the shape cluster.ts's own 2026-07-28 sweep found in the LIVE corpus (113
// claims -> 34 topics, ~3.3 claims/topic average, largest 9) rather than either extreme: uniform
// random high-dimensional vectors essentially never cross MEMORY_CLUSTER_THRESHOLD (cosine near 0
// for random unit vectors in 1024d), which would make the merge loop terminate after ONE pass over
// the whole sim matrix and never exercise the O(n^3)-worst-case merge rounds the L2 lever targets;
// a single tight cluster would collapse everything into one group after few rounds. Small clusters
// of correlated vectors (cluster center + noise) instead produce a realistic MIX of multi-member
// and singleton topics, so the merge loop actually runs the multi-round path production sees.
import { describe, expect, it } from 'bun:test'
import { MEMORY_CLUSTER_THRESHOLD, partition, type ClusterInput } from './cluster'

// mxbai-embed-large's own width (see cluster.ts's MEMORY_CLUSTER_THRESHOLD comment) — matched here
// so this bench's pair cost is comparable to the claim-grouping spec's own cost table ([sourced,
// spec] ~500k pairs ~= 0.5s at n=1,000), not an arbitrary smaller dimension that would understate
// the real per-cosine cost.
const DIM = 1024
// ~3.3 claims/topic, matching the live sweep — see this file's header.
const CLUSTER_SIZE = 3

// mulberry32: a tiny deterministic PRNG so the corpus is reproducible byte-for-byte across runs
// and machines, unlike Math.random(). Not cryptographic, not meant to be — a bench fixture only
// needs to be stable, not unpredictable.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const unitVector = (rand: () => number, dim: number): number[] => {
  const v = Array.from({ length: dim }, () => rand() * 2 - 1)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map(x => x / norm)
}

// A member is ALPHA*center + BETA*independentNoise, both unit vectors. Two independent random unit
// vectors in 1024d are NEARLY ORTHOGONAL (expected dot product ~0, std ~1/sqrt(1024) ~= 0.03), so
// for two members of the same cluster the cross terms (center against the other's noise, noise
// against noise) wash out and cosine(v1, v2) ~= ALPHA^2 + O(1/sqrt(dim)) — a per-cluster designer
// can choose ALPHA to land wherever the "chosen" line of MEMORY_CLUSTER_THRESHOLD needs it.
// 0.9^2 = 0.81, comfortably above MEMORY_CLUSTER_THRESHOLD (0.65) without being a bit-identical
// duplicate (medoidOf needs real variation to have something to pick among). An EARLIER version of
// this fixture added flat uniform noise directly to the center's own components; at 1024d a
// center's own per-component magnitude is already O(1/sqrt(dim)) (it is a unit vector spread over
// 1024 dims), so that noise was the same ORDER as the signal and every cluster fragmented into
// singletons — measured: groups===n, i.e. zero merges, for every size tried. This mixing form is
// scale-correct: BETA is derived from ALPHA (BETA = sqrt(1-ALPHA^2)) rather than picked
// independently, so ||combined|| stays close to 1 by construction and the noise term's weight does
// not silently drift as DIM changes.
const ALPHA = 0.9
const BETA = Math.sqrt(1 - ALPHA * ALPHA)

// n claims arranged into n/CLUSTER_SIZE correlated groups (a random center mixed with independent
// per-member noise, see ALPHA/BETA above) — see the file header for why this shape, not uniform-
// random or one blob, is what the bench needs. Deterministic in n: seed is fixed, so corpus(250) is
// NOT a prefix of corpus(100) reused (each size gets its own independent draw) — the point is
// reproducibility per size, not cross-size nesting.
function syntheticCorpus(n: number, seed: number): ClusterInput[] {
  const rand = mulberry32(seed)
  const claims: ClusterInput[] = []
  let i = 0
  while (i < n) {
    const center = unitVector(rand, DIM)
    const groupSize = Math.min(CLUSTER_SIZE, n - i)
    for (let m = 0; m < groupSize; m++) {
      const noise = unitVector(rand, DIM)
      const combined = center.map((c, idx) => ALPHA * c + BETA * (noise[idx] ?? 0))
      const norm = Math.sqrt(combined.reduce((s, x) => s + x * x, 0)) || 1
      claims.push({ id: `claim-${i.toString().padStart(6, '0')}`, vector: combined.map(x => x / norm) })
      i++
    }
  }
  return claims
}

// n=1,000 is gated behind this env var rather than run by default: with this synthesis (~333
// clusters of 3 for n=1,000) the merge loop's group-pair rescan is bounded by roughly
// sum(g^2) for g declining from ~1,000 to ~333 -- tens of millions of linkage evaluations, each
// itself O(members^2) -- which is exactly the O(n^3)-worst-case cost the L2 (heap + Lance-Williams)
// lever exists to remove. Measured locally it runs, but slow enough (multi-second) that forcing it
// into every `bun test` invocation would make this bench file the thing that makes the suite slow,
// which is the opposite of what a regression-guarding test suite should do. Run explicitly with
// `MEMORY_BENCH_1000=1 bun test plugins/memory/src/cluster-bench.test.ts` to reproduce the n=1,000
// point of the BEFORE curve.
const RUN_1000 = process.env.MEMORY_BENCH_1000 === '1'

describe('cluster partition() bench — BEFORE curve (attribute-refresh-cost)', () => {
  // [n, timeoutMs] — timeoutMs is generous headroom for a loaded CI box, not a target; the actual
  // measured wall-clock is what gets reported to memory, not a pass/fail assertion on speed. The
  // test's only functional assertion is that partition() still returns a partition of the input
  // (sanity: bench inputs stay valid `ClusterInput[]`), matching cluster.test.ts's own style of
  // never asserting timing itself in a way that makes the suite flaky on a slow machine.
  const sizes: [number, number][] = [[100, 5_000], [250, 10_000], [500, 20_000]]

  for (const [n, timeoutMs] of sizes) {
    it(`partitions n=${n} synthetic claims and reports wall-clock`, () => {
      const claims = syntheticCorpus(n, 1_000_003 + n)
      const started = performance.now()
      const groups = partition(claims, MEMORY_CLUSTER_THRESHOLD)
      const elapsed = performance.now() - started
      // sanity, not a timing assertion: every input id appears in exactly one output group
      expect(groups.flatMap(g => g.members)).toHaveLength(n)
      // [sourced] measured here, this run, this machine — not a portable absolute number.
      console.log(`[cluster-bench] n=${n} dim=${DIM} threshold=${MEMORY_CLUSTER_THRESHOLD} groups=${groups.length} elapsed=${elapsed.toFixed(1)}ms`)
    }, timeoutMs)
  }

  it.skipIf(!RUN_1000)('partitions n=1000 synthetic claims and reports wall-clock (opt-in, see RUN_1000)', () => {
    const claims = syntheticCorpus(1_000, 1_000_003 + 1_000)
    const started = performance.now()
    const groups = partition(claims, MEMORY_CLUSTER_THRESHOLD)
    const elapsed = performance.now() - started
    expect(groups.flatMap(g => g.members)).toHaveLength(1_000)
    console.log(`[cluster-bench] n=1000 dim=${DIM} threshold=${MEMORY_CLUSTER_THRESHOLD} groups=${groups.length} elapsed=${elapsed.toFixed(1)}ms`)
  }, 120_000)
})
