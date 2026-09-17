// The retrieval arms' decision rules, as pure functions: query → SurrealQL fragments, row → score,
// and (at the bottom) the semantic arm's within-query margin rule. Zero imports by design (the
// shape cluster.ts set) — no database, no embedder, no clock — so each rule has exactly ONE
// spelling for both the note arm and the claim arm, and every rule here is testable without a
// server. The keyword rules dominate the file for historical reasons; meetsMargin lives here for
// the same reason meetsQuorum does, not because it belongs to the keyword arm.

// Search-term cap. Each term contributes one match clause per searchable field to the WHERE, plus a
// search::score() and a match predicate to the projection: 8 terms over the note's four fields is
// 96 expressions in one statement. MEASURED against SurrealDB 3.2.0 — a raw-string query of that
// shape parses and runs, and so does 32 terms (384 expressions). The cap is NOT about the parser
// anymore (the surqlize-nested WHERE it originally bounded blew "Exceeded query recursion depth
// limit" around 40 terms); it is kept because terms past the eighth cost recall under the quorum
// rule below — they raise the denominator without adding evidence the corpus can answer.
// ponytail: takes the FIRST eight terms. Ranking terms by rarity before truncating would keep the
// distinctive ones, but that needs a df lookup this arm does not otherwise make.
export const MAX_SEARCH_TERMS = 8

// Query → the distinct terms the arm searches for.
//
// DEDUPED on the RAW whitespace token, which is honest only for an exact repeat: `plan`, `plan,`
// and `plan's` are three terms here, and each one separately raises the quorum denominator and adds
// its own coverage. The analyzer would fold all three to one token, so the natural fix is to split
// on non-alphanumeric runs (what the `class` tokenizer effectively does) instead of whitespace.
// MEASURED on the live corpus, isolated keyword arm: that costs 13/15 → 12/15 top-3 and 12/15 →
// 11/15 top-1. It loses "how does work survive a kill -9 in the middle of a step" outright, because
// `-9` — the only distinctive token in that query — becomes `9`, falls under the one-character
// floor, and the budget it freed fills with function words. So the split stays whitespace-based and
// the double-count stands; revisit if a corpus appears where punctuation-attached repeats are
// common enough to outweigh that.
//
// One-character tokens are dropped: beside real terms they are punctuation fragments and articles
// that match nearly every note, so they raise the quorum denominator without carrying any signal.
//
// BUT THE DROP MAY NEVER EMPTY THE QUERY. An empty term list matches nothing, so `orc memory search
// x` returned "_no notes_" for a note tagged 'x' — and single short tokens are a real usage pattern
// here, since tags are routinely one or two characters and an identifier search is often one token.
// The floor is calibrated on multi-term natural-language queries; it has nothing to say about a
// query that consists entirely of what it discards.
//
// The fallback is the UNFILTERED tokens rather than "the longest ones", because on this branch the
// two are the same set: it only fires when no token survived, which means every token is one
// character. "Longest" would be a rule for a case that cannot occur, so it is the same behaviour
// with more code. The cap applies to whichever list survives, so MAX_SEARCH_TERMS still holds.
export const keywordTerms = (query: string): string[] => {
  const all = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))]
  const real = all.filter(t => t.length > 1)
  return (real.length > 0 ? real : all).slice(0, MAX_SEARCH_TERMS)
}

// THE QUORUM RULE: a row is a hit when it carries at least half of the query's terms.
//
// It replaces AND-across-every-term, which is why this file exists. MEASURED on the live corpus
// through the public API at f224520: the note arm returned nothing on 13 of 20 bench probes and the
// claim arm on 16 of 20 — EVERY probe of 5+ terms was silent, without exception, because a
// natural-language question always contains a word the note does not use. Plain OR fixes that and
// breaks the other end: all five negative probes then answer confidently.
//
// A SCORE FLOOR WAS TRIED FIRST AND REJECTED — it is not portable across corpus sizes. SurrealDB's
// BM25 uses the classic unsmoothed IDF, ln((N - df + 0.5)/(df + 0.5)), which is exactly 0 when a
// term appears in half the corpus and negative above that (measured: N=2/df=1 → 0.000, N=3/df=1 →
// 0.472, N=10/df=1 → 1.650, df=N → 0.000). So the same probe set, scored by summed BM25:
//
//   corpus        negatives (top score)          positives (top score)
//   27 notes      2.15 … 13.85                   10.50 … 46.90     → a floor of 10 works
//    6 notes      0.00 …  3.46                    3.98 … 20.46     → a floor of 10 silences 11/15
//
// A constant tuned on this corpus would make a young project's memory — and every unit test in this
// package — silently return nothing. The brief's other candidate, the sum NORMALISED by matched-term
// count, is worse still: it collapses the separation outright (negatives 2.15…13.85 vs positives
// 3.37…20.06 — eleven of fifteen positives sit BELOW the worst negative), because dividing by the
// count discards exactly the evidence that a row covered more of the query.
//
// A quorum is a ratio of COUNTS, so it does not move with N — confirmed, but only for the
// DENOMINATOR; see the corpus-shape limit below. Swept over bench/probes.json against the live
// corpus, isolated keyword arm, ranking as keywordCompare below. Re-swept 2026-07-28 over the
// current 26-probe file (19 positive, 7 negative; 37 notes) by replicating keywordSearch from the
// pure helpers in this file, which reproduces the shipping row's graph-bench output exactly:
//
//   quorum   top-3   top-1   negatives silent   positives silenced   note
//   none     18/26   16/19        1/7                 0/19           plain OR: every negative answers
//   >= 1/4   20/26   16/19        3/7                 0/19
//   >= 1/3   21/26   16/19        4/7                 0/19
//   >= 2/5   21/26   16/19        4/7                 0/19
//   >= 1/2   22/26   16/19        5/7                 0/19           <-- chosen: strictest that costs no positive
//   >= 3/5   23/26   15/19        7/7                 1/19           buys the last two negatives for one top-1
//   >= 2/3   22/26   14/19        7/7                 2/19           cross-page falls off
//   >= 3/4   20/26   13/19        7/7                 3/19
//   = all    18/26   11/19        7/7                 7/19           the AND rule this replaces
//
// Chosen on the same principle SEMANTIC_FLOOR was: take the strictest setting that costs no true
// positive. It is a corner, not a plateau midpoint — top-1 is flat at 16/19 from `none` through 1/2
// and drops at 3/5, while negatives improve monotonically, so 1/2 is where the two curves stop
// agreeing. NOTE THE TOTAL COLUMN NO LONGER PEAKS AT THE CORNER: 3/5 scores 23/26 against 1/2's
// 22/26, because the probe file grew from 5 negatives to 7 and each negative is worth as much as a
// positive there. That is a property of the benchmark's mix, not evidence about the rule — the
// corner is still 1/2. 3/5 is the knob to turn if confident wrong answers ever matter more than
// recall; nothing between 1/2 and 3/5 exists, because these are integer counts.
//
// THE RULE IS CORPUS-SHAPED, which the sweep above cannot show and a second corpus did. Swept the
// same nine bands against a single-subject corpus (8 knowledge notes, 22 probes), this file's own
// selection principle picks 1/3 there, not 1/2: going 1/3 → 1/2 costs FOUR of fifteen true
// positives (keyword top-3 20/22 → 16/22) and buys ZERO negatives, because the keyword arm is
// already silent on all seven at 1/3. Mechanism: the ratio is N-invariant, but the achievable
// numerator is not — an 8-term question needs 4 of its terms in one note at 1/2 and 3 at 1/3, and a
// small corpus about one subject simply carries fewer of any question's terms in any single note.
// DELIBERATELY NOT RETUNED: n=15 positives over 8 notes, one probe is 6.7%, and the seven negatives
// are shared between the two corpora, so the columns are not independent samples. What would settle
// it is a corpus with independent negatives and n >= 50 positives. If it becomes a real complaint
// the direction to test first is a floor on the absolute matched count (">= half OR >= 3 terms"),
// which both corpora would tolerate — untested, a direction only.
//
// THE TWO SURVIVING NEGATIVES are "graphql resolver schema stitching" (2 of its 4 terms appear in
// real notes) and "stripe cli" — which are also the two highest-cosine negatives SEMANTIC_FLOOR
// cannot silence (0.5920 and 0.5922, its ceiling). No per-row rule can reject either: the corpus
// genuinely talks about schemas, resolution and CLIs. They need the margin rule SEMANTIC_FLOOR's
// comment already describes — return nothing when the top score is not meaningfully above the
// candidate set's median — and this constant is the free half of that fix.
//
// CALIBRATED ON THE NOTE ARM, APPLIED TO BOTH. Every number above comes from bench/probes.json,
// which grades NOTES — not one claim was scored in that sweep, so keywordClaims inherits this
// threshold unverified. What is measured for the claim arm is recall only: over the same 20 probes
// its zero-result rate went 16/20 to 8/20 (the note arm's went 13/20 to 4/20). Its top-k quality is
// unknown, and a claim is a different match unit — one sentence, so a query term is far likelier to
// be absent, which makes half-the-terms a STRICTER rule there than here. If claim retrieval is ever
// graded and this needs its own value, split the constant rather than retuning one for both: the
// same mistake SEMANTIC_FLOOR documents (calibrated on notes, then measured on claims, where it
// silences a positive and buys no negative) is available here in the opposite direction.
//
// LIMITS: 15 positive probes and 5 negative ones, ONE corpus, ONE language. The rule is only as
// strong as the query is long — a two-word query passes on one word, so quorum does nothing for
// short queries. That is the right asymmetry (short queries were never the failure) but it means a
// SHORT nonsense query still reaches the ranker. And the denominator counts stop-words: a
// natural-language question about a subject this corpus lacks ("how do I configure the kubernetes
// ingress controller") gets its quorum half-paid by "how", "do", "the".
//
// A stopword list was the obvious fix and was measured BOTH WAYS against the truncation above,
// because where it runs decides whether the eight-term budget is spent on function words:
//
//   variant                                   top-3   top-1   negatives silent   zero-result
//   no stopword filter (shipping)             13/15   12/15        4/5              4/20
//   dropped BEFORE the MAX_SEARCH_TERMS cap   13/15   12/15        4/5              5/20
//   dropped AFTER the cap                     13/15   12/15        4/5              4/20
//
// Filtering first DOES change what gets searched — "the fence that stops a step writing outside the
// globs it declared" spends its budget on `fence stops step writing outside globs declared` instead
// of stopping at `outside`. It scores identically anyway, and costs one extra zero-result: dropping
// stop-words shrinks the denominator, so the quorum gets harder and "where does an agent record a
// finding so the next run reuses it" goes silent. On this corpus the stop-words are load-bearing for
// RECALL, which is the opposite of the intuition. Not carried; re-measure if a natural-language
// negative probe appears, since that is the case the list would actually help.
export const meetsQuorum = (matchedTerms: number, queryTerms: number): boolean =>
  matchedTerms * 2 >= queryTerms

// THE WITHIN-QUERY MARGIN RULE — the semantic arm's half of the negative fix, and the one candidate
// SEMANTIC_FLOOR's comment names but never priced ("return nothing when the top COSINE is not
// meaningfully above the candidate set's median cosine"). It lives INSIDE the semantic arm, so the
// fusion seam is untouched: a semantic-only hit still survives rrfFuse, which semantic-search.test.ts
// asserts and an arm-consensus rule would have broken.
//
// WHY A MARGIN AND NOT A BETTER FLOOR. A floor asks "is this score high?", which the measured
// distributions say is unanswerable — positives and negative top-hits overlap on both corpora. A
// margin asks a DIFFERENT question, about one query's own result set: "did anything here stand out?"
// A query the corpus cannot answer pulls back a flat field — its top note is no better than the
// tenth — while a query it CAN answer pulls back a peak. That is a within-query comparison, so it
// needs no constant that ports across corpora... except the size of "meaningfully", below.
//
// RAW cosine, never the re-ranked score: cos × heat would let a much-read bystander widen the very
// gap this checks for, turning heat into evidence of relevance. Compared against the median of a
// FIXED WINDOW of the top candidates, not of the whole candidate set, because the whole set's size
// is a property of the corpus (50 rows here, 15 on the second corpus) and its median then means two
// different things — a long weak tail would manufacture a margin for a flat query.
//
// SWEPT 2026-07-29 on both bench corpora (orc-sim: 50 embedded notes, 26 note probes / 19 positive;
// orc-sim-b: 15 notes, 22 probes / 15 positive), ollama/mxbai-embed-large, raw cosine post-
// knowledge(), pre-floor, pre-re-rank. The column that matters is the FUSED scoreboard, since
// silencing this arm only changes an answer where the keyword arm is also silent (negatives) or
// where this arm was carrying the rank (positives). Measured margins, top minus window median:
//
//   margin    corpus A negatives silenced        corpus B negatives silenced   positives lost
//   0.000     (rule off) 1/7                     2/7                           —
//   0.020     1/7                                2/7                           0
//   0.030     3/7  (+kubernetes, +k8s pod)       3/7  (+k8s pod)               0
//   0.033     3/7                                4/7  (+graphql)               0   <-- shipping
//   0.035     3/7                                4/7                           0
//   0.037     3/7                                4/7 but partial-recall top-1 falls   1 top-1
//   0.040     3/7                                4/7, partial-recall top-1 gone       1 top-1
//   0.045     3/7, synonym top-1 at risk         4/7, partial-recall top-1 gone       2 top-1
//
// The shipping value is the MIDPOINT OF A PLATEAU bounded by measured probes on both sides, which
// is the same selection rule SEMANTIC_FLOOR used: the plateau is (0.0295, 0.0370), opened by
// corpus B's "graphql resolver schema stitching" negative at 0.0295 and closed by corpus B's
// "the one function every backend has to implement" positive at 0.0370, whose fused top-1 comes
// from this arm (keyword has it at rank 2). Corpus A's own binding positive is "which package is
// every other one allowed to import" at 0.0398. Midpoint 0.0333, rounded to 0.033.
//
// LIMITS, and they are tighter than the table looks. The plateau is 0.0075 wide and bounded by ONE
// probe at each end, so this constant is worth about two probes of evidence — n=1 either side, not
// a distribution. The seven negatives are shared verbatim between the two corpora, so the two
// negative columns are not independent samples. And the rule cannot silence "graphql resolver
// schema stitching" or "stripe cli" on corpus A, where the keyword arm answers them anyway: no
// change inside one arm can, which is the finding search()'s fusion comment owns. Re-measure with
// the embedder, and re-measure before trusting the plateau's edges — `bun bench/graph-bench.ts`
// against both probe files is the whole test.
export const SEMANTIC_MARGIN = 0.033
// How many top candidates the median is taken over. Ten because both corpora's candidate sets are
// at least that deep (15 and 50) while the smaller one cannot fill 50, so a fixed window is the
// only statistic the two sweeps share. It is also the abstention threshold below.
export const MARGIN_WINDOW = 10

// The rule. `scoresDesc` is the raw cosine list the arm's own SELECT already ordered descending.
//
// ABSTAINS below one full window: the median of a 3-row set is not the statistic swept above, and a
// young project (or any of this package's own fixtures) would otherwise have its semantic arm
// silenced by a corpus that is merely small. A 1-row set is the degenerate case — its median IS its
// top, so the rule would silence every query forever. Absence of evidence about a corpus this
// narrow is not evidence to refuse; SEMANTIC_FLOOR is still the judge there.
export function meetsMargin(
  scoresDesc: readonly number[],
  minMargin: number = SEMANTIC_MARGIN,
  window: number = MARGIN_WINDOW,
): boolean {
  if (scoresDesc.length < window) return true
  const top = scoresDesc[0]
  if (top === undefined) return true
  const w = [...scoresDesc.slice(0, window)].sort((a, b) => a - b)
  const mid = Math.floor(w.length / 2)
  // even window → the mean of the two middles, the ordinary median; the input is already sorted
  // descending, but re-sorting ascending here keeps this correct if a caller ever passes otherwise
  const median = w.length % 2 === 1 ? (w[mid] ?? 0) : ((w[mid - 1] ?? 0) + (w[mid] ?? 0)) / 2
  return top - median >= minMargin
}

// The SurrealQL fragments one keyword query needs. Built here rather than in the arms because the
// note arm and the claim arm differ only in their field list, and a second spelling of the match-
// reference arithmetic is a second chance to get it wrong.
export interface FtsQuery {
  // OR across every (term, field) pair — the AND this replaces is the whole defect
  where: string
  // `search::score(ref)` per (term, field), term-major, for foldRow's `bm25`
  scores: string
  // the same pairs as match PREDICATES. Needed because search::score cannot report "this term
  // matched": it returns 0 both for a clause that missed and for one that hit a term appearing in
  // half the corpus or more (unsmoothed IDF, see meetsQuorum). Counting matched terms from the
  // scores would therefore make the quorum unreachable on a small corpus.
  matches: string
  vars: Record<string, string>
}

// `fields` is the field list; the caller's weights must be in the SAME order (foldRow relies on it).
export function ftsQuery(terms: readonly string[], fields: readonly string[]): FtsQuery {
  const ref = (ti: number, fi: number): number => ti * fields.length + fi
  const pair = (ti: number, fi: number): string => `${fields[fi]} @${ref(ti, fi)}@ $kw${ti}`
  return {
    where: terms.map((_, ti) => `(${fields.map((_f, fi) => pair(ti, fi)).join(' OR ')})`).join(' OR '),
    scores: terms.flatMap((_, ti) => fields.map((_f, fi) => `search::score(${ref(ti, fi)})`)).join(', '),
    matches: terms.flatMap((_, ti) => fields.map((_f, fi) => `(${pair(ti, fi)})`)).join(', '),
    // `kw` prefix, not `t`: these bind alongside the arms' own $scopes/$q parameters.
    vars: Object.fromEntries(terms.map((t, i) => [`kw${i}`, t])),
  }
}

export interface KeywordScore {
  // distinct query terms this row carries anywhere — the quorum's numerator
  matched: number
  // field-weighted count of matching (term, field) pairs: how much of the query the row covers,
  // weighted by where it covers it. This is the PRIMARY rank key, see keywordCompare.
  coverage: number
  // summed field-weighted BM25 — the tiebreak, and the only term carrying IDF
  bm25: number
}

// One row's `matches`/`scores` arrays (term-major, `weights.length` entries per term) folded into
// its three rank inputs. Tolerant of a short array so a row is scored, never thrown on.
export function foldRow(
  matches: readonly boolean[], scores: readonly number[], weights: readonly number[],
): KeywordScore {
  const out: KeywordScore = { matched: 0, coverage: 0, bm25: 0 }
  for (let i = 0; i < matches.length; i += weights.length) {
    let any = false
    for (let fi = 0; fi < weights.length; fi++) {
      const w = weights[fi] ?? 0
      out.bm25 += (scores[i + fi] ?? 0) * w
      if (matches[i + fi]) { out.coverage += w; any = true }
    }
    if (any) out.matched += 1
  }
  return out
}

// RANK ORDER: coverage first, BM25 only to break its ties.
//
// This is deliberately NOT "ranked by BM25", which is what the standard OR+BM25 recipe prescribes
// and what this task set out to build. MEASURED on the live corpus (27 notes), isolated keyword arm,
// quorum >= 1/2 held fixed, all four candidates over the same 15 positive probes:
//
//   rank key                            top-3   top-1
//   BM25 sum                            12/15    9/15
//   BM25 sum x matched terms            12/15   10/15
//   BM25 sum x coverage                 12/15   11/15
//   coverage, tiebreak BM25             13/15   12/15   <-- chosen
//
// RE-CHECKED 2026-07-28 at 26 probes / 37 notes: same order, same winner — 21/26 13@1, 21/26 14@1,
// 21/26 15@1, 22/26 16@1. The choice survived the corpus growing by a third; the ceiling below did
// not move with it.
//
// Why coverage wins here: at 27 notes almost every content word is rare, so IDF barely separates
// anything, while "this note uses six of your eight words, three of them in its title" separates a
// lot. Coverage is also what AND-across-terms was really enforcing — the fix keeps its PREFERENCE
// for covering the whole query and drops only its REQUIREMENT. And unlike BM25 it is a count, so it
// still orders correctly on a corpus small enough that every IDF is 0 (see meetsQuorum), which is
// what makes this package's own two-note fixtures rank the way their tests assert.
//
// The ceiling is IDF: as the corpus grows, common words start covering many notes at once and
// coverage ties get long. BM25 breaking those ties is exactly the upgrade path, already wired —
// if it stops being enough, swap the keys (BM25 primary, coverage tiebreak) and re-run
// `bun bench/graph-bench.ts` with the table above as the baseline. n=15 positives, one corpus.
export const keywordCompare = (a: KeywordScore, b: KeywordScore): number =>
  b.coverage - a.coverage || b.bm25 - a.bm25
