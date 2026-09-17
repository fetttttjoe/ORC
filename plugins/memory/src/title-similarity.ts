// How alike two note TITLES are, and nothing else: no store, no embedder, no clock. Character
// trigrams rather than tokens or a vector, because the fork this guards against is a rephrasing —
// "Auth middleware" vs "Authentication middleware" share almost no whole tokens and almost all of
// their trigrams. Lexical is also the honest tool at this call site: the check runs at write time,
// before the new note has an embedding, so a cosine comparison would have nothing to compare.

const TRIGRAM = 3

const trigrams = (s: string): Set<string> => {
  const t = s.toLowerCase().replace(/\s+/g, ' ').trim()
  const out = new Set<string>()
  for (let i = 0; i + TRIGRAM <= t.length; i += 1) out.add(t.slice(i, i + TRIGRAM))
  return out
}

/** Sørensen–Dice over character trigrams: 1 = identical, 0 = nothing shared. Symmetric. */
export function trigramDice(a: string, b: string): number {
  const x = trigrams(a)
  const y = trigrams(b)
  // A title too short to have one trigram cannot be judged similar to anything; 0 keeps the caller
  // silent rather than making it guess.
  if (x.size === 0 || y.size === 0) return 0
  let shared = 0
  for (const g of x) if (y.has(g)) shared += 1
  return (2 * shared) / (x.size + y.size)
}

// Above this, two titles are near enough that the writer may have meant to UPDATE rather than
// create. Never auto-merged — near-identical titles are often genuinely distinct notes, and
// silently folding them destroys knowledge; this only decides whether to SAY something.
//
// NOT a calibration — a FLOOR, and it shipped as one because its first sweep had nothing to read:
// every pair of this project's live semantic-tier note titles scored below 0.40, top pair 0.254, so
// no band could be told apart from any other. THAT HAS SINCE CHANGED, and the floor is now
// positively supported rather than merely defaulted to. Re-swept 2026-07-28 over the same set
// (store.list({ tier: 'semantic' }), project scope, ui-metadata excluded): 17 notes, C(17,2) = 136
// pairs. (Episodic notes are excluded by construction — they live in plan scopes that
// duplicateSubjectWarning's project-scoped search never reaches, so they carry no evidence here.)
//
//   threshold   pairs flagged
//     0.40           3
//     0.50           3
//     0.60           0
//
// All three were READ, and all three are genuine near-duplicates — three notes about the same
// embedding-interfaces map, written by three different runs:
//
//   0.586  'Embedding interfaces: architecture and implementation'
//      vs  'Embedding interfaces map: EmbeddingProvider, implementations, and consumers'
//   0.579  'Embedding interfaces: architecture and implementation'
//      vs  'Embedding interfaces in orc-sim: single interface, one implementation'
//   0.529  'Embedding interfaces map: …'  vs  'Embedding interfaces in orc-sim: …'
//
// 0.60 WOULD HAVE CAUGHT NONE OF THEM. The band this constant was forced DOWN from is the band that
// fails on real data — a result the original sweep could not see, and the reason to record this
// rather than re-derive it. A second corpus (8 notes, 28 pairs) holds a fourth true pair at 0.738
// and the only false positive across both: 0.416, a run-outcome note against an architecture hub
// sharing one phrase — one false positive in 164 pairs. The search-gated path the tool actually
// runs (store.search(title), then trigramDice >= this) recalls all three pairs here: rewriting each
// title id-lessly fires the warning on 3 of 17, every time naming a real sibling.
//
// The band was also constrained from below, independently, and 0.60 does NOT hold there either:
// tools.test.ts's own pre-existing fixture
// ("still forks (with a warning) when the titles merely resemble each other", predating this task)
// asserts a warning for 'Zone write-fence: declaration and enforcement' against 'Zone write-fence:
// something else entirely' — two notes sharing only a subject prefix — which scores 0.439. That
// fixture is a real design decision (its own comment: "a near-match is genuinely ambiguous — it
// stays a warning"), not incidental, so it constrains the floor down to the one requested band
// beneath it: 0.40. At 0.40 it still catches the synthetic fork this check exists for — "Auth
// middleware" vs "Authentication middleware" scores 0.611. So the fixture pushed it down and the
// corpus has since pulled it down: the two constraints now agree, which is the finding, and the
// value needs no change.
//
// LIMITS: four true pairs and one false one, over two machine-authored corpora in one house style,
// and every pair here is about ONE subject that happened to be written up three times. That is
// enough to reject 0.60 and not enough to move 0.40. Re-sweep as the corpus grows — this constant's
// first reading was zero-signal and its second changed what it says, and
// cluster.ts:MEMORY_CLUSTER_THRESHOLD did not survive 52 → 93 claims either.
export const NEAR_SUBJECT = 0.4
