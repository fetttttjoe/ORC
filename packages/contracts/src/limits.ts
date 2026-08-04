// Size/count ceilings shared across the memory schemas, in a LEAF module on purpose: `claim.ts`
// needs it for Claim's text bound, and `memory.ts` needs it for the note schemas — if either of
// those imported it FROM the other, the cycle would break at module load (zod schemas evaluate
// their bounds immediately, so the still-initializing side would read undefined). A leaf has no
// such ordering.

export const MEMORY_LIMITS = {
  labelItems: 50,
  labelChars: 64,
  detailItems: 100,
  detailChars: 1_000,
  // A note's one-line pointer, shown in every listing and every preload — which is why it is short.
  // Named here rather than inlined at the schema so the boundary that ACCOMMODATES an over-long one
  // and the schema that stores it cannot drift on the number.
  // A note's one-line name, spelled here because five call sites had it inline (budget.ts's fitter,
  // consolidate.ts, step.ts's ambient capture, the schema, the write boundary's truncation) and a
  // cap that disagrees between the thing that TRIMS and the thing that VALIDATES rejects writes
  // nobody can explain.
  titleChars: 200,
  summaryChars: 500,
  // A derived TOPIC label (cluster.ts topicLabel): one scannable index row, not the sentence it
  // was cut from. Sized against the row `orc memory topics` prints — a 12-char topicKey, two
  // spaces, a 3-wide size column, two spaces — so 12+2+3+2+60 = 79 fits an 80-column terminal
  // with nothing to wrap. Named here, next to the other ceilings, so the contract bound
  // (cluster.ts Topic.label), the derivation's caller (surreal.ts refreshTopics) and the tests
  // cannot drift onto three different numbers.
  // If it proves wrong: widen it here alone — the derivation takes the cap as an argument and has
  // no opinion about the value. Widening past ~66 costs the 80-column guarantee; narrowing below
  // ~40 starts cutting the leading source path that makes these labels distinguishable at all.
  topicLabelChars: 60,
  // What the STORE accepts. Deliberately far above the searchable ceiling: this bound is also
  // applied when re-parsing history, so tightening it would make older notes fail to parse and
  // vanish from every fold.
  bodyChars: 100_000,
  // What the EMBEDDER can see (embedWritten's slice, sized to the encoder's context). Text past it
  // is stored and readable but invisible to semantic search — so this is the honest number to
  // advertise to a writer, and the only length worth warning about. Leaves room for title+summary
  // inside the same window.
  searchableBodyChars: 7_000,
  embedInputChars: 8_000,
  rationaleChars: 20_000,
  // Ceiling on a model-supplied read budget, and on how many items a search may ask for. The budget
  // IS the response ceiling on every memory tool — `applyBudget`/`fitMemoryNoteToBudget` bound the
  // reply to it and to nothing else — and it arrived from the model unbounded, so `budget: 1e9` was
  // a request for the whole corpus in one reply. bodyChars/4 (approxTokens is chars/4) is the
  // smallest bound that can still return the largest storable note whole, so it costs nothing real.
  budgetTokens: 25_000,
  // Ceiling on ONE signal's knowledge report (ids per side), not on the evidence itself: the fold
  // reads every recorded memory_outcome event, so this cap can never hide records from the
  // aggregator — capping the record below what the aggregator reads was a measured defect in the
  // reference implementation this design banks (citations 11+ silently never scored).
  outcomeIds: 20,
} as const
