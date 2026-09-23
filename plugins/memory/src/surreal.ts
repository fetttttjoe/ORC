import { z } from 'zod'
import { RecordId, Surreal } from 'surrealdb'
import { edge, orm, table, t } from 'surqlize'
import {
  activation, activationBoost, bumpAccess, Claim, ClaimAnchor, ClaimClass, DEFAULT_HALF_LIFE_DAYS,
  decodeMemoryEvent, DecisionStatus, deriveNoteProvenance, EDGE_DIRECTION, edgeKey, LinkKind, MEMORY_USE, MemoryScope, MutationOp, Topic, viaEdge,
  MemoryNote, VerifiedStamp, type MemoryWrittenPayload,
  MEMORY_LIMITS, SEARCH_MODE, errorMessage, inferTier, isUiMetaNote, noteKey, NoteKind, NoteTier,
  type EmbeddingProvider, type EventRecord, type NeighborQuery, type MemoryFilter, type NoteFields, type NoteView, type UseStats,
  type MemorySearchOpts, type NeighborResult, type NoteSummary,
  linkLookupScopes,
} from '@orc/contracts'
import { rankNeighbors, rrfFuse, type Edge } from './rank'
import { dedupeByNote, type ClaimHit, type ClaimSearchOpts } from './claim-search'
import { ascending, MEMORY_CLUSTER_THRESHOLD, partition, topicLabel, type ClusterInput } from './cluster'
import { foldRow, ftsQuery, keywordCompare, keywordTerms, meetsMargin, meetsQuorum } from './keyword'
// The shape is DEFINED there: drift.ts owns the citation/currency domain (notesCiting is its
// exported entry point) and must stay DB-free, so the query body lives here and the shape there —
// one declaration, no runtime edge in either direction for the TYPE. `pathCovers` IS a runtime
// import, deliberately: it is the one spelling of "does this declared path cover this candidate
// file", shared with noteHasDrifted, so notesCitingPaths below cannot silently diverge from what
// drift already means by "covers".
import { pathCovers, type CitingNote } from './drift'

// The read model's table names — single spelling for every builder call and RecordId.
enum Tb { Note = 'note', Meta = 'meta', Link = 'link', Claim = 'claim', Topic = 'topic' }

// `noteId` holds the note's own string id (surqlize reserves `id` for the auto-added RecordId).
// hits/lastAccessedAt are projected from memory_accessed like every other field — they survive a
// rebuild — and are stripped back out in toNote() before the row reaches the public MemoryNote
// shape (they belong to the summary, not to the authored note). Both are optional in the row
// type so a note projected before the counter existed still selects without a rebuild.
// literal-typed link kind, derived from the contract's LinkKind — rows come back as LinkKind.

// The full-text analyzer both keyword arms match through, and the searchable field of each table
// with what a match there is worth. ONE spelling: the schema setup below builds a DEFINE INDEX per
// entry, and the arms build their match clauses from the same list in the same order (foldRow pairs
// weights with fields positionally).
//
// An analyzer is REQUIRED, not an optimisation. The arms OR across terms now (see keyword.ts), and
// without token boundaries every note containing the substring 'a' would match every query; without
// stemming a question phrased 'declared' would miss a note that wrote 'declare'. `class` splits on
// character-class changes so 'write-fence' yields both words; `snowball(english)` stems both the
// stored text and the query term (measured: 'glob' matches a note that stored 'globs').
const FTS_ANALYZER = 'orc_en'
// `keyof typeof noteTable.type` / `claimTable.type`, not `string`: these names become DEFINE INDEX
// ... FIELDS <name> below, and SurrealDB does not reject an index over a column that does not
// exist — it defines the index, the column just never receives it, and that field silently stops
// matching forever, with no build failure and no test failure. Typing `name` against the table's
// own inferred row shape turns a column rename that forgets to update this list into a compile
// error instead. (noteTable/claimTable are defined below; a `typeof` type query may forward-
// reference a value declared later in the same module — this is resolved by the type checker, not
// evaluated at runtime.)
type NoteColumn = keyof typeof noteTable.type
type ClaimColumn = keyof typeof claimTable.type
const NOTE_SEARCH_FIELDS: readonly { name: NoteColumn; weight: number }[] = [
  { name: 'title', weight: 3 }, { name: 'summary', weight: 2 },
  { name: 'body', weight: 1 },
  // FULLTEXT over an ARRAY field works and matches per element — measured against 3.2.0. Tags were
  // searchable under the substring arm at body's weight; keeping them costs one index.
  { name: 'tags', weight: 1 },
] as const
const CLAIM_SEARCH_FIELDS: readonly { name: ClaimColumn; weight: number }[] = [{ name: 'text', weight: 1 }] as const
const weightsOf = (fields: readonly { weight: number }[]): number[] => fields.map(f => f.weight)
const namesOf = (fields: readonly { name: string }[]): string[] => fields.map(f => f.name)
// SurrealDB 3.2.0 takes ONE field per FULLTEXT index (the 2.x field-list form is gone), so the
// index name is derived from the pair rather than spelled — a second spelling would drift.
const ftsIndexes = (tb: Tb, fields: readonly { name: string }[]): string =>
  fields.map(f => `DEFINE INDEX IF NOT EXISTS ${tb}_${f.name}_fts ON ${tb} FIELDS ${f.name} FULLTEXT ANALYZER ${FTS_ANALYZER} BM25;`).join(' ')

// spelled once for the note row and the derived claim row
const anchorColumn = () => t.array(t.object({ path: t.string(), symbol: t.option(t.string()), blob: t.option(t.string()) }))
// t.option infers `string | undefined`, so the optional keys are materialized as the note row's links are
const anchorRow = (a: ClaimAnchor) => ({ path: a.path, symbol: a.symbol ?? undefined, blob: a.blob ?? undefined })
// the verification stamp as the row holds it — its claim snapshot is what claim drift compares against
const verifiedRow = (v: VerifiedStamp | undefined) => v === undefined
  ? undefined
  : {
      revision: v.revision, at: v.at, by: v.by,
      claims: v.claims?.map(c => ({ claimId: c.claimId, anchors: c.anchors.map(anchorRow) })),
    }

const kindType = t.union(Object.values(LinkKind).map(k => t.literal(k)))
const noteKindType = t.union(Object.values(NoteKind).map(k => t.literal(k)))
const decisionStatusType = t.union(Object.values(DecisionStatus).map(s => t.literal(s)))

// Tier-specific columns are optional because a row only HAS the columns its tier owns — a plan
// note has no `claims` column at all, not an empty one. `tier` itself is optional so a row
// projected before the split still selects; `orc memory rebuild` re-derives it from the log.
const noteTable = table(Tb.Note, {
  noteId: t.string(), scope: t.string(), title: t.string(), tier: t.option(t.string()),
  // only a decision ever has one (the note schema refuses it on every other kind), so it is
  // optional for the same reason `kind` is: a row only has the columns its note actually filled
  kind: t.option(noteKindType), status: t.option(decisionStatusType), sourceRevision: t.option(t.string()),
  categories: t.option(t.array(t.string())), tags: t.array(t.string()),
  links: t.array(t.object({ id: t.string(), kind: kindType, confidence: t.option(t.number()) })),
  paths: t.option(t.array(t.string())),
  // stored on the note row like `links` is, and — like `links` — ALSO materialized into a derived
  // per-claim table for retrieval. The row is the note's own live set (what a read returns); the
  // derived table is what search matches statement-by-statement.
  claims: t.option(t.array(t.object({
    id: t.string(), text: t.string(), class: t.string(), anchors: anchorColumn(), sourceRevision: t.option(t.string()),
  }))),
  summary: t.string(), body: t.string(),
  retention: t.string(),
  sources: t.option(t.array(t.object({ url: t.string(), title: t.option(t.string()), retrievedAt: t.string() }))),
  rationale: t.option(t.string()), uncertainty: t.option(t.array(t.string())), zone: t.option(t.array(t.string())),
  dependsOn: t.option(t.array(t.string())), skillRefs: t.option(t.array(t.string())),
  toolRefs: t.option(t.array(t.string())), modelRef: t.option(t.string()),
  createdAt: t.string(), createdBy: t.string(), updatedAt: t.string(), updatedBy: t.string(),
  // The checkout the last write came from — the ONE input every read surface derives `provisional`
  // from. REQUIRED, unlike the optional columns above that exist so an un-rebuilt row still selects:
  // a row that answers "which workspace?" with nothing would read as trunk knowledge, which is the
  // one wrong answer. The cost is that a read model projected before this column must be replayed —
  // `orc memory rebuild` — or every select throws, the same way a required `seq` once wedged the
  // meta row's stage read. The fact is on the event, so the replay re-derives it.
  workspaceId: t.string(),
  revision: t.number(), hits: t.option(t.number()), lastAccessedAt: t.option(t.string()),
  // observed-use OUTCOMES (memory_outcome), Tier-2 like hits: two separate counters, never one
  // signed score — contested displays BOTH. Optional so rows projected before the kind existed
  // still select without a rebuild.
  usefulHits: t.option(t.number()), lastUsefulAt: t.option(t.string()),
  deadEndHits: t.option(t.number()), lastDeadEndAt: t.option(t.string()),
  // Set by memory_verified and by nothing else — the only note column no memory_written can
  // originate (a write can carry it forward or drop it; see deriveNoteProvenance). Optional so
  // every row projected before the stamp existed still selects, without a rebuild.
  verified: t.option(t.object({
    revision: t.string(), at: t.string(), by: t.string(),
    claims: t.option(t.array(t.object({ claimId: t.string(), anchors: anchorColumn() }))),
  })),
  // the note's dense vector (embedder-derived, Tier-2 like hits) — set only when an embedder was
  // configured at write/rebuild; the semantic scan reads it raw, toNote/toSummary drop it.
  embedding: t.option(t.array(t.number())),
})
// `seq` is the projection cursor. `stage`/`stageAt` publish WHAT the projector is doing, and exist
// because the health probe runs in a DIFFERENT PROCESS from the projector (the graph server opens
// its own connection; the projector lives in the supervisor). A shared row is the only channel the
// two already have. Advisory presentation state — never read back into a decision.
// Every column is OPTIONAL because this table holds two DIFFERENT rows: 'cursor' carries `seq` and
// no stage, 'stage' carries the stage pair and no seq. A required `seq` made reading the stage row
// throw "Expected number but found undefined" on every call — silently, because the caller wrapped
// it in a catch, so the whole boot-stage feature was dead and looked merely idle.
const metaTable = table(Tb.Meta, {
  seq: t.option(t.number()), stage: t.option(t.string()), stageAt: t.option(t.number()), stagePid: t.option(t.number()),
  // Replay progress, flat like the rest of this row rather than a nested object — the pair is
  // re-nested at getStage's typed boundary, where "both or neither" is enforced once.
  stageApplied: t.option(t.number()), stageTotal: t.option(t.number()),
})

// Derived claim index, materialized from note.claims by the projector as `link` is from note.links
// and just as disposable — though NOT by the same clear-and-recreate, see applyEvent. It exists so a
// claim can carry its OWN embedding: search matches a statement directly instead of matching a
// document and making the reader find the sentence.
// `validFrom` lives here and nowhere in the note payload: it is the ts of the first event that
// carried the claim, which only a fold can know — so the projector is the only thing that can
// honestly stamp it, and it is preserved across rewrites below.
// Deliberately carries NO hits/lastAccessedAt, unlike `note` and `link`: memory_accessed identifies
// a note, so nothing could ever increment a claim's own counters, and semanticClaims has no
// activation re-rank to read them. Two columns and a preservation branch that only ever copied
// zero forward, advertising an activation feature that did not exist — the owning note already
// records the access, which is what the heat re-rank is computed from.
const claimTable = table(Tb.Claim, {
  claimId: t.string(), noteId: t.string(), scope: t.string(), text: t.string(),
  class: t.string(), anchors: anchorColumn(),
  validFrom: t.string(), sourceRevision: t.option(t.string()),
  embedding: t.option(t.array(t.number())),
})

// Stage 3 (see the claim-grouping spec): derived from claim embeddings. After a refresh the table
// holds EXACTLY the new partition and nothing else — it needs no cursor because nothing in it is
// meant to survive across one. Deliberately carries no `hits` column — topic use is measured from
// the log, and a counter a rebuild erases is not a measurement.
// No `label` column: a topic's label is DERIVED from the medoid claim at read time (see topics()).
// Storing it made the read model hold a second copy of a fact the claim table already owns, and the
// copy is what broke — bounding contracts' Topic.label rejected all 54 rows a previous build had
// written, so `orc memory topics` failed as a shape error until someone guessed at a rebuild.
// Disposable is not the same as already-disposed: a read parses what is on disk NOW.
const topicTable = table(Tb.Topic, {
  topicKey: t.string(), medoidClaimId: t.string(),
  members: t.array(t.string()),
})

// Derived edge index (spec D2/D3): materialized from note.links by the projector, rebuilt on
// replay. Explicit fromId/toId/scope string fields so fetch needs no RecordId parsing.
const linkTable = edge(Tb.Note, Tb.Link, Tb.Note, {
  kind: kindType, confidence: t.option(t.number()),
  fromId: t.string(), toId: t.string(), scope: t.string(),
  // observed use, per-EDGE (see memory_accessed's `via` branch below) — optional so a
  // pre-existing link row projected before these fields existed still selects without a rebuild.
  hits: t.option(t.number()), lastAccessedAt: t.option(t.string()),
})

// RecordId key = `${scope}:${id}` (scope/id are separately restricted to [a-z0-9-], so ':' is
// an unambiguous separator); the table itself is always 'note'.
const key = (scope: string, id: string) => `${scope}:${id}`
// A claim row is identified by its OWNING note plus its content hash, not by the hash alone: the
// same statement asserted on two notes is two claims, each with its own provenance and activation.
const claimKey = (scope: string, noteId: string, claimId: string) => `${scope}:${noteId}:${claimId}`
// Fusion key for a claim hit — the claim's own identity, which is note-scoped like its row id.
const claimHitKey = (h: ClaimHit) => claimKey(h.scope, h.noteId, h.claimId)

// ui-metadata is infrastructure, not knowledge — never a retrieval hit, still readable by id.
// ONE spelling of the exclusion for every retrieval surface (note search, claim search, topics): it
// drifted once already, and the reason it exists is that a real run was handed 'ui-project-name' as
// project context and then cited it as provenance.
const knowledge = <T extends { scope: string; id: string }>(ns: readonly T[]): T[] =>
  ns.filter(n => !isUiMetaNote(n.scope, n.id))

// The notes a claim hit is allowed to name, by noteKey — built once per search (see claimOwners).
type OwnerMap = ReadonlyMap<string, NoteSummary>

// Attach each claim row's owning note. A row whose owner is absent from the map is one the filter
// excluded, one knowledge() excluded, or one whose note is gone — either way, not a hit.
const joinClaimOwners = (
  rows: ReadonlyArray<z.infer<typeof ClaimRowBase>>,
  owners: OwnerMap,
): ClaimHit[] =>
  rows.flatMap(r => {
    const owner = owners.get(noteKey(r.scope, r.noteId))
    return owner
      ? [{
          claimId: r.claimId, noteId: r.noteId, scope: r.scope, title: owner.title,
          text: r.text, class: r.class, anchors: r.anchors, validFrom: r.validFrom,
          // the owner's drift inputs ride along — already resolved here, and the only way a claim
          // in the preload can be dated against the tree
          sourceRevision: owner.sourceRevision, paths: owner.paths,
          // and its workspace, for the same reason: a claim has no workspace of its own — the note
          // that ASSERTS it does, and that is what decides whether the statement is trunk knowledge
          workspaceId: owner.workspaceId,
        }]
      : []
  })

// Raw rows from the two RAW selects (cosine and full-text), parsed (never cast) at the boundary
// like every other DB read. hits/lastAccessedAt are optional (a note may predate them).
const SummaryRow = z.object({
  noteId: z.string(), scope: z.string(), title: z.string(),
  // projected like every other summary field: without it toSummary would fall back to shape
  // inference over a row that carries none of the columns inference reads, and label every
  // vector hit 'semantic' — including the plan and episodic notes it surfaced.
  tier: z.enum(NoteTier).optional(),
  // Projected so a `kind` FILTER works on this arm too. matchesRow reads it off the row, and the
  // raw selects project exactly SUMMARY_COLUMNS — so without it here every kind-filtered search
  // matched nothing (r.kind undefined), while the same filter worked on list(), which selects the
  // whole row. Optional like `tier`: a row projected before the column existed still parses.
  kind: z.enum(NoteKind).optional(),
  categories: z.array(z.string()).optional(), tags: z.array(z.string()), summary: z.string(),
  hits: z.number().optional(), lastAccessedAt: z.string().nullable().optional(),
  // observed-use outcomes — optional like hits, a row may predate the columns
  usefulHits: z.number().optional(), lastUsefulAt: z.string().nullable().optional(),
  deadEndHits: z.number().optional(), lastDeadEndAt: z.string().nullable().optional(),
  // the two drift inputs — optional because a row projected before either column existed still
  // selects, and both fall back to the "uncheckable" value rather than a fabricated one
  sourceRevision: z.string().nullable().optional(), paths: z.array(z.string()).optional(),
  // the third drift input (see NoteSummary.verified): a summary without it makes every consumer of
  // the either-clean rule fall back to the source stamp alone, which is what it exists to correct
  verified: VerifiedStamp.optional(),
  // the provisional input. Required like the note column it projects: an arm that could not report
  // the workspace would return rows reading as trunk knowledge, which is worse than failing loudly.
  workspaceId: z.string(),
})
// the SELECT list is derived from SummaryRow's own keys, so widening the row shape widens the
// projection in the same edit; a hand-kept second spelling drifts silently, because zod strips
// unknown keys and half a change produces no error.
//
// It is a NARROWING for the keyword arm, which used to select the whole row through the builder:
// toSummary falls back to `inferTier(r)` for a row with no stored `tier`, and inference reads
// kind/zone/uncertainty/rationale/retention — none of which are projected here. So a tier-less row
// is now labelled `semantic` by both arms rather than by neither, and drops out of a `filter.tier`
// search entirely. MEASURED on the live corpus: 37 notes, ZERO without a stored tier, so the
// fallback is currently dead code and this costs nothing today. It is only reachable on a read model
// that has not been rebuilt since the tier split, which `orc memory rebuild` is the answer to (see
// the `tier` field on noteTable). Widen this list rather than re-adding a full-row select if that
// ever stops being true — five more columns on the hottest path is the smaller price.
const SUMMARY_COLUMNS = Object.keys(SummaryRow.shape).join(', ')
const SemanticRow = SummaryRow.extend({ score: z.number() })

// The path-intersection read's row: exactly what a heal-or-confirm caller acts on — which note
// (noteId + scope address it; `id` is the record id), what it claims to be about, and the revision
// its currency is measured against. Narrow on purpose: this runs over the whole corpus on every
// audited change, and nothing downstream reads a body from it.
// `sourceRevision` is optional like SummaryRow's, so a row projected before that column existed
// still parses, falling back to the uncheckable value rather than a fabricated one.
const CitingRow = z.object({
  noteId: z.string(), scope: z.string(), title: z.string(),
  sourceRevision: z.string().nullable().optional(),
  // the note's OWN declared paths — needed client-side by pathCovers below, since a directory
  // declaration ('packages/graph-ui') covering a changed FILE under it ('packages/graph-ui/x.css')
  // is not expressible as SurrealQL array equality (CONTAINSANY), only as string-prefix matching.
  paths: z.array(z.string()).optional(),
})
// derived from the parse's own keys, like SUMMARY_COLUMNS/CLAIM_COLUMNS: one edit widens both the
// projection and the parse (zod strips unknown keys, so a hand-kept second list went stale silently)
const CITING_COLUMNS = Object.keys(CitingRow.shape).join(', ')

// `search::score` is parsed as a plain number, NOT `nullable()`: MEASURED against SurrealDB 3.2.0,
// a match clause that did not match yields 0, not NONE, so the `?? 0` this pattern is usually
// written with is dead code here. Nothing about the SCORING depends on that — kwMatches carries
// which terms matched, so a coalesced NONE could not have been mistaken for a hit.
//
// What DOES depend on it is failure shape, and it is asymmetric: semanticSearch wraps its whole
// select in a catch and degrades to the other arm, keywordSearch has no catch at all. So on a
// server that returned NONE, the semantic arm would keep working and the keyword arm would take
// hybrid search down with it — a throw out of search(), not a degraded result. That asymmetry
// predates this change (the substring arm had no catch either) and SHOULD be closed, in the
// direction of giving the keyword arm the same degrade-to-the-other-arm guard; deliberately not
// done here, because "both arms failed" and "one arm failed" want different logging and that is a
// contract question, not a comment fix.
const ftsColumns = z.object({ kwScores: z.array(z.number()), kwMatches: z.array(z.boolean()) })
// updatedAt rides along as the LAST tiebreak, preserving the recency order the substring arm got
// from its `ORDER BY updatedAt DESC` for rows the relevance keys cannot separate.
const KeywordRow = SummaryRow.extend({ updatedAt: z.string() }).extend(ftsColumns.shape)

// Raw claim rows, from the cosine select and the full-text one.
const ClaimRowBase = z.object({
  claimId: z.string(), noteId: z.string(), scope: z.string(), text: z.string(),
  class: z.enum(ClaimClass), anchors: z.array(ClaimAnchor),
  validFrom: z.string(),
})
// a claim field missing from this hand-mapped row fails the build; `id` is `claimId`, `sourceRevision` is the owner's
type ClaimRowCoversClaim =
  Exclude<keyof Claim, keyof typeof ClaimRowBase.shape | 'id' | 'sourceRevision'> extends never ? true : never
const claimRowCoversClaim: ClaimRowCoversClaim = true
void claimRowCoversClaim
// derived like SUMMARY_COLUMNS above: the parse's keys are the projection, one edit widens both
const CLAIM_COLUMNS = Object.keys(ClaimRowBase.shape).join(', ')
const ClaimRow = ClaimRowBase.extend({ score: z.number() })
const KeywordClaimRow = ClaimRowBase.extend(ftsColumns.shape)

// The filter fields a RAW select cannot push into matchFilter's builder. Applied in TS by both raw
// arms, from one spelling, so semantic and keyword cannot disagree about what a filter means.
const matchesRow = (
  r: { tier?: string; kind?: string; categories?: string[]; tags: string[] }, filter: MemoryFilter,
): boolean =>
  (!filter.tier || r.tier === filter.tier)
  && (!filter.kind || r.kind === filter.kind)
  && (!filter.category || (r.categories ?? []).includes(filter.category))
  && (!filter.tag || r.tags.includes(filter.tag))

// How many NOTES a claim search may return when the caller names no limit. Deliberately the same
// order as the note search's own page: dedupeByNote counts notes, so this is comparable.
const CLAIM_SEARCH_LIMIT = 10

// Cosine below which a hit is not evidence of anything. Without it the ranker always answers: both
// arms take the top 50 by cosine with no minimum, so a query about a subject this project has never
// touched still returns its least-unlike notes, and memory_search's own "absence is not proof"
// wording (tools.ts) described a behaviour the code did not have.
//
// MEASURED over bench/probes.json against the live corpus (37 notes carrying embeddings),
// `ollama/mxbai-embed-large` (1024d), raw cosine before the re-rank. Rows are post-knowledge(): a
// ui-metadata note is never returnable, so counting one measures a distribution the floor does not
// act on. It bites — the android probe's raw top is ui-project-name @0.4731, its real top is
// outcome-embedding-interfaces @0.4416, and that gap is the whole of the 0.46 row below: post-
// knowledge that probe is the ONE negative 0.46 silences, raw it would silence none.
//
//   probe class            n    min      median   max
//   positive (correct)    19    0.4336   0.5742   0.7689
//   negative (top hit)     7    0.4416   0.5403   0.5922
//
// THE TWO DISTRIBUTIONS OVERLAP — not a separating threshold, and cannot be made into one. Silencing
// every negative needs > 0.5922 ("stripe cli"); keeping every positive needs < 0.4336 ("x" →
// area-ui). No value does both, and 0.495 is not at the recall end of that range: IT COSTS TWO
// POSITIVES — "x" @0.4336 and "rrfFuse" @0.4725, both one-identifier queries — while silencing two
// of the seven negatives and leaving five answering. The keyword arm carries both lost positives
// (exact-token matching is what a one-word identifier query wants), so the FUSED surface loses
// neither and this arm alone does. This block used to say "0.495 costs no positive": true at the 15
// positives it was swept on, false since the identifier probes were added, and nothing re-ran it.
//
// Chosen as the midpoint of a measured PLATEAU, not of a gap. `bun bench/graph-bench.ts` grades the
// FUSED surface, so the table is a property of BOTH arms. Re-swept 2026-07-28 over the current
// 26-probe file, semantic arm replicated at each floor and fused through the real rrfFuse against
// the real keyword arm; the shipping row reproduces graph-bench's own output exactly.
//
//   floor   derived     synonym partial cross negative  fused   fused@1  sem 0-res
//   0.00    13/14 12@1    2/2     1/2    1/1    0/7      17/26   16/19     0/26   floor off: always answers
//   0.46    13/14 11@1    2/2     1/2    1/1    1/7      18/26   15/19     1/26
//   0.485   13/14 11@1    2/2     1/2    1/1    2/7      19/26   15/19     3/26  <-\
//   0.49    13/14 11@1    2/2     1/2    1/1    2/7      19/26   15/19     3/26    |
//   0.495   13/14 12@1    2/2     1/2    1/1    2/7      19/26   16/19     4/26  <-- shipping
//   0.50    13/14 12@1    2/2     1/2    1/1    2/7      19/26   16/19     4/26  <-/
//   0.505   13/14 12@1    1/2     1/2    1/1    2/7      18/26   15/19     5/26   synonym falls off
//   0.53    13/14 10@1    1/2     2/2    1/1    3/7      20/26   13/19     7/26   top-1 collapses
//   0.60    14/14 13@1    1/2     1/2    1/1    5/7      22/26   16/19    15/26   see below
//
// The plateau holds at 26 probes — 0.485-0.50 all score 19/26, 0.505 degrades, and 0.495/0.50 are
// strictly better on top-1 (16/19) than 0.485/0.49 — and that plateau is the whole justification.
// It is a property of THIS corpus, not of the constant: swept against a second, single-subject
// corpus (8 knowledge notes, 22 probes) there is no plateau at all — 0.485/0.49/0.50 score 15/22
// and 0.495 dips to 14/22, one probe wide — and there the floor costs three positives, two of them
// the natural-language synonym probes an embedder exists to serve. The overlap above is also worse
// on the narrow corpus (67% of positives inside the negative range, against 53% here), which is the
// predicted single-topic effect.
//
// 0.60 IS NOT AN IMPROVEMENT AND MUST NOT BE ADOPTED. This was recorded here as an open decision
// ("scores one better, someone decide") and is now settled, measured on both corpora: 0.60 wins the
// scoreboard by SILENCING THE SEMANTIC ARM — zero-result on 15 of 26 probes here and 20 of 22 on
// the second corpus — and at 0.60 the fused row is numerically identical to the keyword arm's own
// (22/26 top-3, 16/19 top-1, zero-result 5/26 here; 16/22 there). The benchmark's negative column is
// worth 7 of 26 points, so switching an arm off outscores what that arm contributes. The metric was
// rewarding an absent arm, never a better floor. "Raise the floor to 0.60" means "run keyword-only",
// which is a MODE (search already has one), not a threshold.
//
// It DE-NOISES, it does not only refuse: a low-cosine but much-read note outranks a better match
// once heat applies, and the floor removes those bystanders before they crowd the fused top-3. No
// probe's PASS is attributable to it, though — the positive columns at 0.00 and at 0.495 are
// identical, because the keyword arm answers those probes on its own. Its whole measurable
// contribution is the negative column.
//
// CALIBRATED ON THE NOTE ARM, applied to both — and NO LONGER INERT on the claim arm, which it was
// when tuned. Claim cosines still run higher (one sentence is a tighter match unit: positives median
// 0.6452 against the note arm's 0.5742) and all seven claim-arm negatives are still above it
// (0.4984 … 0.5814, so it buys nothing there), but one claim positive now falls below at 0.4752
// (n=19). It is pure cost on that arm today. Re-tuning against the table above moves the claim arm
// blind; re-measure both.
//
// MUST STAY >= 0, and the filter must stay AHEAD of the re-rank — see semanticSearch's re-rank
// comment, which owns the formula and this coupling.
//
// Limits: n=19 positives, n=7 negatives, ONE corpus and ONE model. IN `mode: 'semantic'` a genuine
// question phrased worse than any probe here WILL be silenced, and now demonstrably is, on two. The
// default mode is hybrid, where the fused surface is silent only when BOTH arms are and the keyword
// arm has no score floor at all (its zero-result rate is 5/26, and all five are negatives — 0/19 on
// positives), so this constant bounds one arm's confidence, not the system's willingness to answer.
// Re-measure when the embedder changes (a cut through one model's cosine distribution does not port,
// exactly as cluster.ts's MEMORY_CLUSTER_THRESHOLD does not) and as the corpus grows: every number
// above went stale between 27 notes and 37 without anything failing.
//
// The five negatives above the floor are NOT fixable by any scalar: they need a margin rule (return
// nothing when the top COSINE is not meaningfully above the candidate set's median cosine — raw
// cosine, not the re-ranked score, or a hot bystander widens the very gap the rule checks for).
// This constant is the free half of that fix, not the whole of it. THE OTHER HALF NOW EXISTS and is
// applied in semanticSearch below, ahead of this filter: keyword.ts's meetsMargin / SEMANTIC_MARGIN,
// swept 2026-07-29 on both corpora. It takes two of those five here and two on the second corpus;
// the two it cannot take ("graphql resolver schema stitching", "stripe cli") are the ones the
// KEYWORD arm answers, which no rule inside this arm can reach.
//
// AND THIS ARM'S NEGATIVE COUNT DOES NOT SURVIVE FUSION. The keyword arm silences 5 of 7 negatives,
// this arm 2, and the fused surface lands on the LOWER of the two — structurally, not by luck; see
// search()'s fusion comment, which owns that finding, and keyword.ts's meetsQuorum, which owns the
// other half of the coupling.
export const SEMANTIC_FLOOR = 0.495

const CONNECT_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 2_000

// Bound a driver call that may never settle. The timer is always cleared, so a resolved promise
// never holds the process open past its own work.
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function makeOrm(surreal: Surreal) {
  return orm(surreal, noteTable, metaTable, linkTable, claimTable, topicTable)
}
type Db = ReturnType<typeof makeOrm>

// The one test seam: observes every orm transaction's `tx` before the body runs (the first line of
// each transaction below), so a test can fail a statement mid-transaction. Nothing in production
// passes it; the alternative was reaching the private orm, and TypeScript has no cast-free read of
// a private field.
export interface OpenSeams { onTransaction?: (tx: unknown) => void }
// ReturnType picks the last overload, which is the no-callback one returning the tx itself.
type Tx = Awaited<ReturnType<Db['transaction']>>

// The ONE stats-preserving edge materialization. Both writers of the link table — applyEvent's
// per-note rewrite and refreshLinks' global derivation — route through here, so the survivor rule
// cannot drift between them (it was spelled twice, with two different stats keys, while claiming to
// live in one place). Stats key by the canonical edgeKey from contracts, the same identity the log
// fold uses. Delete-then-RELATE is safe for edges because RELATE mints a fresh record id per call;
// a FIXED id deleted and re-created inside one Surreal transaction stays deleted at commit —
// measured, which is why the claim re-materialization in applyEvent upserts in place instead.
const linkStatsOf = (rows: ReadonlyArray<{ scope: string; fromId: string; toId: string; kind: LinkKind; hits?: number; lastAccessedAt?: string }>) =>
  new Map(rows.map(l => [edgeKey(l.scope, l.fromId, l.toId, l.kind), l] as const))
async function relateLinks(
  tx: Tx, scope: string, fromId: string,
  links: ReadonlyArray<{ id: string; kind: LinkKind; confidence?: number }>,
  stats: ReadonlyMap<string, { hits?: number; lastAccessedAt?: string }>,
): Promise<void> {
  for (const l of links) {
    const prev = stats.get(edgeKey(scope, fromId, l.id, l.kind))
    await tx.relate(Tb.Link, new RecordId(Tb.Note, key(scope, fromId)), new RecordId(Tb.Note, key(scope, l.id))).set({
      kind: l.kind, fromId, toId: l.id, scope,
      ...(l.confidence !== undefined && { confidence: l.confidence }),
      hits: prev?.hits ?? 0,
      ...(prev?.lastAccessedAt !== undefined && { lastAccessedAt: prev.lastAccessedAt }),
    })
  }
}

export class SurrealMemory {
  private constructor(
    private readonly surreal: Surreal,
    private readonly db: Db,
    private readonly embedder?: EmbeddingProvider,
    // where this store lives — needed only by drop(), which removes the database object itself
    // rather than its rows, and so cannot go through the ORM
    private readonly at?: { ns: string; db: string },
    private readonly seams: OpenSeams = {},
  ) {}

  static async open(t: {
    url: string; ns: string; db: string; username: string; password: string
    connectTimeoutMs?: number
  }, embedder?: EmbeddingProvider, seams: OpenSeams = {}): Promise<SurrealMemory> {
    const surreal = new Surreal()
    try {
      // The driver's connect() does NOT reject on an unreachable endpoint — measured still
      // pending after 400s against a closed port, because its reconnect budget governs a dropped
      // established connection, not the initial dial. Every degraded-memory path in the system
      // is downstream of this throwing: probeMemory's catch, and the CLI runtime's fallback to
      // unavailableMemoryTools. Unbounded, `orc status` and every `orc memory` command hang
      // forever instead of degrading, which is the opposite of the stated guarantee.
      // ponytail: one constant, not a setting — promote it if a real deployment needs longer.
      // authentication as a connect-option PROVIDER, not a one-shot .signin(): when the
      // session expires or the socket reconnects, the driver's renewal chain re-invokes the
      // provider with these credentials. A .signin() covers only the current session — after
      // expiry every query fails 'Anonymous access not allowed' until the process restarts.
      await withTimeout(
        surreal.connect(t.url, { authentication: { username: t.username, password: t.password } }),
        t.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
        `surreal unreachable at ${t.url}`)
      await surreal.use({ namespace: t.ns, database: t.db })
      // ESCAPE HATCH (raw): surqlize's builder assumes tables already exist — it has no DEFINE
      // TABLE op. On a brand-new namespace/database, SurrealDB v3.2.0 throws "table does not
      // exist" on SELECT (even though CREATE/UPSERT auto-vivify it), so applyWritten's read-before-
      // write would fail on the very first write. Defining both tables up front avoids that.
      // `link` (default TYPE ANY, so RELATE works) is defined too: neighbors() SELECTs from it
      // even when no edge was ever materialized.
      // ONE batched statement, executed in order: the analyzer must exist before an index names it,
      // and the tables before either. `IF NOT EXISTS` throughout because this runs on EVERY open.
      //
      // THIS SETS THE SERVER VERSION FLOOR: `FULLTEXT ANALYZER` is SurrealDB 3.x syntax (2.x spelled
      // it `SEARCH ANALYZER` and took a field LIST per index). docker-compose pins v3.2.0, which is
      // what every measurement in this file was taken against. Against a 2.x server this batch is a
      // parse error and open() throws — loud and immediate, which is the right failure, but it is a
      // floor a reader would otherwise have to discover by hitting it. Note the CLIENT dependency in
      // plugins/memory/package.json is still declared at 2.0.4; the driver spans both, the SERVER
      // does not.
      // MEASURED against the live project database: warm, the whole batch is 0.2-0.6 ms (a metadata
      // check) out of a ~20 ms open(); cold, DEFINE INDEX BACKFILLS the rows already present — 4
      // indexes over 27 notes / 42 KB of text in 12 ms — so an existing project becomes searchable
      // on its next command, with no `orc memory rebuild`. The cold path is linear in corpus text;
      // move it off open() if a project ever makes that 12 ms a visible pause.
      //
      // THE CEILING `IF NOT EXISTS` BUYS: it makes the analyzer and the indexes IMMUTABLE on a
      // database that already has them. Changing FTS_ANALYZER's filters here would then apply to
      // new databases only, silently, and every existing project would keep matching under the old
      // rules — the worst kind of drift, because search still works and just answers differently
      // per machine. MEASURED: after re-sending this batch with `snowball(english)` added, a query
      // for 'declare' still missed a stored 'declared'; `DEFINE ANALYZER OVERWRITE` alone did NOT
      // fix it either (the index holds tokens produced by the OLD analyzer) — only re-sending
      // `DEFINE INDEX OVERWRITE`, which rebuilds it, did. So the upgrade path for any analyzer
      // change is BOTH statements as OVERWRITE, paying the cold build again. A versioned name
      // (`orc_en_v2`) is the alternative and costs the same rebuild, since every index definition
      // below names the analyzer. Field WEIGHTS are exempt: they live in NOTE_SEARCH_FIELDS and are
      // applied in TS by foldRow, never in the index, so changing one takes effect immediately.
      //
      // The indexes outlive a rebuild: `clear()` DELETEs rows and never touches the table, so the
      // definitions and their maintenance survive the replay (measured: delete-all, re-create, the
      // row is matchable again). Only `drop()` removes them, by removing the database — and open()
      // is what re-creates it.
      await surreal.query([
        [Tb.Note, Tb.Meta, Tb.Link, Tb.Claim, Tb.Topic].map(tb => `DEFINE TABLE IF NOT EXISTS ${tb} SCHEMALESS;`).join(' '),
        `DEFINE ANALYZER IF NOT EXISTS ${FTS_ANALYZER} TOKENIZERS class FILTERS lowercase, snowball(english);`,
        ftsIndexes(Tb.Note, NOTE_SEARCH_FIELDS),
        ftsIndexes(Tb.Claim, CLAIM_SEARCH_FIELDS),
      ].join(' '))
      return new SurrealMemory(surreal, makeOrm(surreal), embedder, { ns: t.ns, db: t.db }, seams)
    } catch (err) {
      // connect() opens a live socket; if signin/use/DEFINE then throws, don't leak it
      // (symmetry with PostgresStore.open, which pool.end()s on an assertMigrated throw).
      // Bounded too: after a connect timeout the driver is still retrying underneath, and an
      // unbounded close here would re-introduce exactly the hang this method now prevents.
      await withTimeout(surreal.close(), CLOSE_TIMEOUT_MS, 'surreal close').catch(() => {})
      throw err
    }
  }

  // The ONE apply path: note/edges/cursor commit in a single Surreal
  // transaction, gated by the ordered cursor — redelivery of any memory event is a no-op,
  // and revision counts distinct accepted writes, never delivery attempts.
  //
  // The DECODE is shared with foldMemoryInto (contracts' decodeMemoryEvent) — only the apply lives
  // here, and the switch's `never` default makes a mutation this side forgets a compile error: the
  // divergence class that once dropped memory_verified from the fold while this side honoured it.
  async applyEvent(e: EventRecord): Promise<boolean> {
    const m = decodeMemoryEvent(e)
    // Embed BEFORE opening the transaction: an embedder round-trip must never be held inside a
    // Surreal tx. Embedding is derived data (recomputed on every rebuild), so re-embedding a
    // redelivered event is harmless waste, not a correctness issue. Upserts only: an archive
    // deletes the note's rows, so a vector for it would be computed and thrown away.
    // ponytail: re-embeds even a redelivered memory_written; gate behind the cursor if it bites.
    const embedding = m?.op === MutationOp.upsert ? await this.embedWritten(m.payload, e.seq) : undefined
    const claimEmbeddings = m?.op === MutationOp.upsert ? await this.embedClaims(m.payload, e.seq) : new Map<string, number[]>()
    return this.db.transaction(async tx => {
      this.seams.onTransaction?.(tx)
      const cursor = (await tx.select(Tb.Meta, 'cursor'))[0]?.seq ?? 0
      if (e.seq <= cursor) return false
      if (m !== null) switch (m.op) {
        case MutationOp.skip:
          // skip-and-advance: an unparseable/legacy payload costs this ONE event, never the whole
          // read model. Strict .parse used to abort drainFrom at this seq and re-hit it on every
          // reconcile AND every rebuild(), permanently wedging memory — the log is immutable, so
          // the wedge could never be operated away. The cursor still advances below.
          console.warn(`[memory] skipping unparseable ${e.kind} at seq ${e.seq}: ${m.reason}`)
          break
        case MutationOp.archive: {
          // ARCHIVED notes leave the read model entirely rather than sitting in it behind a filter.
          // Deleting the rows is what makes archival free at every read site — search, neighbours,
          // ranking, topics and `ls` exclude it with no query change and no chance of one path
          // forgetting the filter. It stays fully recoverable: every revision is in the event log,
          // so writing the same id with archived:false re-upserts it on the next drain. Surreal drops
          // a note's RELATE edges when its record goes, so only the claim rows need saying.
          const { note } = m.payload
          await tx.delete(Tb.Note, key(note.scope, note.id))
          // The CLAIM rows go too, exactly as the 'delete' case does it. Dropping only the
          // note left its statements in the claim table, and refreshTopics/topicClaims select
          // claims by scope with no owner join — so a retired note kept clustering into topics and
          // memory_topics returned its statements verbatim, while memory_read said it was gone.
          // Measured after this comment first claimed topics were excluded; they were not.
          await tx.delete(Tb.Claim).where(c => c.noteId.eq(note.id).and(c.scope.eq(note.scope)))
          break
        }
        case MutationOp.upsert: {
          const { note, author } = m.payload
          const k = key(note.scope, note.id)
          // read-then-write: createdAt/By + hits/lastAccessedAt preserved; updated/rev advance
          const ex = (await tx.select(Tb.Note, k))[0]
          // provenance + retrievedAt stamping shared with the kernel plan-note fold (deriveNoteProvenance):
          // the one place this is computed, so projector and log-side fold cannot disagree.
          const prov = deriveNoteProvenance(note, author, e.ts, ex && { ...ex, verified: VerifiedStamp.safeParse(ex.verified).data })
          // read through NoteView so one write path covers every tier: a column the note's tier does
          // not own is OMITTED from the SET rather than nulled. An omitted key survives `UPSERT … SET`
          // untouched (that is exactly why the embedding fields use the same pattern), so a note that
          // flips semantic→plan keeps a stale `claims` column on its row — harmless only because
          // toNote() re-parses through the tier schema, which strips it. UNSET it here if that ever
          // stops being true.
          const n: NoteFields = note
          await tx.upsert(Tb.Note, k).set({
            noteId: note.id, scope: note.scope, title: note.title, tier: note.tier,
            ...(n.kind !== undefined && { kind: n.kind }),
            ...(n.status !== undefined && { status: n.status }),
            ...(note.sourceRevision !== null && { sourceRevision: note.sourceRevision }),
            ...(n.categories !== undefined && { categories: n.categories }),
            tags: note.tags,
            // materialize the optional confidence key: t.option infers `number | undefined`, required
            links: note.links.map(l => ({ id: l.id, kind: l.kind, confidence: l.confidence })),
            ...(n.paths !== undefined && { paths: n.paths }),
            // materialize the optional sourceRevision key, same reason as links' confidence above
            ...(n.claims !== undefined && {
              claims: n.claims.map(c => ({
                id: c.id, text: c.text, class: c.class, anchors: c.anchors.map(anchorRow),
                sourceRevision: c.sourceRevision ?? undefined,
              })),
            }),
            summary: note.summary, body: note.body,
            retention: note.retention,
            // ORM row wants the title key always present (OptionType); retrievedAt already stamped by deriveNoteProvenance
            ...(prov.sources !== undefined && { sources: prov.sources.map(s => ({ url: s.url, title: s.title, retrievedAt: s.retrievedAt })) }),
            ...(n.rationale !== undefined && { rationale: n.rationale }),
            ...(n.uncertainty !== undefined && { uncertainty: n.uncertainty }),
            ...(n.zone !== undefined && { zone: n.zone }),
            ...(n.dependsOn !== undefined && { dependsOn: n.dependsOn }),
            ...(n.skillRefs !== undefined && { skillRefs: n.skillRefs }),
            ...(n.toolRefs !== undefined && { toolRefs: n.toolRefs }),
            ...(n.modelRef !== undefined && { modelRef: n.modelRef }),
            createdAt: prov.createdAt, createdBy: prov.createdBy,
            updatedAt: prov.updatedAt, updatedBy: prov.updatedBy,
            // off the event's author, via the one provenance derivation — never off this process's
            // cwd: a supervisor serves every workspace at once and its own directory says nothing
            // about where a given write came from
            workspaceId: prov.workspaceId,
            revision: prov.revision,
            // CARRY-or-CLEAR, and the one place a write may touch the stamp. Omit-if-absent is NOT
            // available here, unlike every other optional column above: clearing is the whole point
            // when content moved, and an omitted key survives `UPSERT … SET` untouched — which would
            // leave a stale "verified" on a note the write just rewrote. `undefined` is what UNSETs
            // the column, so this names the key unconditionally.
            verified: verifiedRow(prov.verified),
            hits: ex?.hits ?? 0,
            // OptionType fields validate against `undefined`, not `null` — omit rather than null it out.
            ...(ex?.lastAccessedAt !== undefined && { lastAccessedAt: ex.lastAccessedAt }),
            // the embedder-derived vector when configured (omit-if-undefined like the fields above —
            // a keyword-only deployment simply never sets it, and a rebuild re-derives it)
            ...(embedding && { embedding }),
          })
          // Re-materialize this note's out-edges (delete-then-RELATE, relateLinks owns the survivor
          // rule) — deterministic on replay. PRESERVE stats first: read the existing out-edges before
          // the delete wipes them, so a link that SURVIVES the rewrite carries its earned hits/
          // lastAccessedAt into the re-RELATE. A link the update REMOVES loses its stats with it —
          // correct, the connection no longer exists. Skipping this read is the blocker T6 was named
          // for: every note UPDATE would otherwise silently wipe its edges' accumulated activation.
          const existingLinks = await tx.select(Tb.Link).where(l => l.fromId.eq(note.id).and(l.scope.eq(note.scope)))
          await tx.delete(Tb.Link).where(l => l.fromId.eq(note.id).and(l.scope.eq(note.scope)))
          await relateLinks(tx, note.scope, note.id, note.links, linkStatsOf(existingLinks))
          // Claims re-materialize from the note's live set. Deliberately NOT the edges' clear-and-
          // recreate above: a claim row has a DETERMINISTIC id (note + content hash), and a fixed
          // record id deleted and re-created inside one Surreal transaction stays deleted at commit —
          // measured, three claims upserted after the delete left only the two the delete had not
          // touched. The edge path is immune because RELATE mints a fresh id per call rather than
          // reusing a key. So retire only the rows this write actually dropped, and update the rest in
          // place: a claim that SURVIVES keeps its original validFrom, because re-stating a fact does
          // not make it new. A retired one goes — it is no longer live, and the log still holds it.
          const existingClaims = await tx.select(Tb.Claim).where(c => c.noteId.eq(note.id).and(c.scope.eq(note.scope)))
          const prevClaims = new Map(existingClaims.map(c => [c.claimId, c]))
          const liveClaims = n.claims ?? []
          const liveIds = new Set(liveClaims.map(c => c.id))
          for (const row of existingClaims) if (!liveIds.has(row.claimId)) await tx.delete(row.id)
          for (const c of liveClaims) {
            const prev = prevClaims.get(c.id)
            const vec = claimEmbeddings.get(c.id)
            await tx.upsert(Tb.Claim, claimKey(note.scope, note.id, c.id)).set({
              claimId: c.id, noteId: note.id, scope: note.scope, text: c.text,
              class: c.class, anchors: c.anchors.map(anchorRow),
              // the payload carries no date — the FIRST event that carried this claim is its validFrom
              validFrom: prev?.validFrom ?? e.ts,
              // `?? undefined` here is deliberate and NOT the omit-pattern below: resolveClaims carries
              // a survivor's own revision forward, so this value always equals what is stored and a
              // null only ever unsets a field whose absence already means null.
              sourceRevision: c.sourceRevision ?? undefined,
              // Omit-if-undefined, exactly like the note row's `embedding` above — a named key with an
              // undefined value is emitted as `SET embedding = NONE`, which REMOVES the column, while
              // an omitted key survives `UPSERT … SET` untouched. embedClaims is best-effort and
              // returns an EMPTY map on any embedder failure, so writing it unconditionally let one
              // Ollama blip erase the stored vectors of every surviving claim on the note: those
              // statements drop out of semanticClaims and out of refreshTopics (collapsing their
              // topics) with nothing but one warn line, and nothing re-embeds them until the note is
              // written again or `orc memory rebuild` runs with the embedder up.
              ...(vec !== undefined && { embedding: vec }),
            })
          }
          break
        }
        case MutationOp.access: {
          const p = m.payload
          const k = key(p.scope, p.id)
          // read-then-write, not a blind upsert: an access whose note was never projected (or was
          // since deleted) must not conjure a row carrying nothing but a counter. lastAccessedAt is
          // the event ts, so a replay lands on the same value the first pass did.
          const ex = (await tx.select(Tb.Note, k))[0]
          if (ex) await tx.upsert(Tb.Note, k).set(bumpAccess(ex, e.ts))
          // the walked EDGE strengthens too, not just the node. No row matched (edge since removed,
          // or this access carries no provenance) → no-op.
          const edge = viaEdge(p)
          if (edge) {
            const link = (await tx.select(Tb.Link).where(l =>
              l.scope.eq(edge.scope).and(l.kind.eq(edge.kind)).and(l.fromId.eq(edge.from)).and(l.toId.eq(edge.to))))[0]
            if (link) await tx.update(link.id).set(bumpAccess(link, e.ts))
          }
          break
        }
        case MutationOp.outcome: {
          const p = m.payload
          const k = key(p.scope, p.id)
          // read-then-write like access: an outcome for a note never projected (or archived since)
          // must not conjure a row carrying nothing but a counter. The FOLD keeps the stats
          // regardless, so a restored note sees its history on the next rebuild.
          const ex = (await tx.select(Tb.Note, k))[0]
          // same increment rule as bumpAccess (+1, stamp the event ts), applied to the outcome's
          // own column pair so the two sides can never net
          if (ex) await tx.upsert(Tb.Note, k).set(p.outcome === MEMORY_USE.useful
            ? { usefulHits: (ex.usefulHits ?? 0) + 1, lastUsefulAt: e.ts }
            : { deadEndHits: (ex.deadEndHits ?? 0) + 1, lastDeadEndAt: e.ts })
          break
        }
        case MutationOp.verify: {
          const p = m.payload
          const k = key(p.scope, p.id)
          // read-then-write, the same rule memory_accessed follows: a stamp for a note that was never
          // projected (or has since been deleted) must not conjure a row carrying nothing but a
          // verification. The store refuses an unknown id before appending, so this only catches the
          // deleted-since case and a replay against a partially rebuilt model.
          const ex = (await tx.select(Tb.Note, k))[0]
          // ONLY this column: the act declares a note checked and asserts nothing about its content,
          // so revision/updatedAt/updatedBy stay exactly where the last write left them. A verify that
          // moved `updatedBy` would report the auditor as the note's author.
          if (ex) await tx.upsert(Tb.Note, k).set({ verified: verifiedRow(p.stamp) })
          break
        }
        case MutationOp.delete: {
          const p = m.payload
          await tx.delete(Tb.Note, key(p.scope, p.id))
          // Only the edges this note AUTHORED — one condition per side, dropping an `.or().and()`
          // whose precedence was never pinned (the same class as the `.inside().not()` trap).
          //
          // This does NOT preserve the inbound edges other live notes authored toward this one, and
          // narrowing the WHERE cannot: MEASURED against SurrealDB, deleting the `note` record removes
          // every RELATE edge attached to it in both directions, ours or not. So a note that comes
          // back under the same id has lost edges its neighbours still assert in their own `links`,
          // and only `orc memory rebuild` restores them. Fixing that means re-materializing inbound
          // edges on write, which is a scan of the note table on the hottest path — a deliberate
          // trade, not a patch.
          await tx.delete(Tb.Link).where(l => l.fromId.eq(p.id).and(l.scope.eq(p.scope)))
          // the derived claim rows go with the note, same as its edges
          await tx.delete(Tb.Claim).where(c => c.noteId.eq(p.id).and(c.scope.eq(p.scope)))
          break
        }
        default: {
          const unhandled: never = m
          void unhandled
        }
      }
      await tx.upsert(Tb.Meta, 'cursor').set({ seq: e.seq })
      return true
    })
  }

  // The read-path twin of toSummary's `use` field, for one id: memory_read surfaces the verdict
  // beside the full note, and the full-note shape (toNote) deliberately strips every counter.
  async useStats(id: string, scope: string = MemoryScope.project): Promise<UseStats | null> {
    const ex = (await this.db.select(Tb.Note, key(scope, id)))[0]
    return ex ? useOf(ex) : null
  }

  async neighbors(seed: string, opts: NeighborQuery = {}): Promise<NeighborResult[]> {
    const scope = opts.scope ?? MemoryScope.project
    const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
    const now = opts.now ?? new Date().toISOString()
    // All in-scope edges, ranked in TS — fine for a hand-authored graph; a frontier-scoped
    // fetch is a later optimisation. Both directions: "what supersedes
    // this note" must be reachable from the superseded seed, so each edge is added reversed too.
    const rows = await this.db.select(Tb.Link).where(l => l.scope.eq(scope))
    // tagged with direction so an asymmetric kind stays unambiguous: A→B is 'out' from A, 'in' from B
    const edges: Edge[] = rows.flatMap(r => {
      // edge heat folds into confidence: one multiplication, rank stays purely structural.
      // ponytail: promote to an explicit Edge field if rank ever needs raw confidence.
      const act = activation({ hits: r.hits ?? 0, lastAccessedAt: r.lastAccessedAt ?? null }, now, halfLife)
      const confidence = (r.confidence ?? 1) * activationBoost(act)
      return [
        { from: r.fromId, to: r.toId, kind: r.kind, confidence, direction: EDGE_DIRECTION.out },
        { from: r.toId, to: r.fromId, kind: r.kind, confidence, direction: EDGE_DIRECTION.in },
      ]
    })
    const ranked = rankNeighbors(edges, [seed], { depth: opts.depth, kinds: opts.kinds })
    // join title/summary AND the activation inputs from the raw row (hits/lastAccessedAt are
    // Tier-2 fields toNote strips) — then re-weight: structure × activationBoost. Boost-only,
    // so a graph with zero accesses ranks exactly as before.
    // ponytail: rankNeighbors' cap applies pre-boost — a hot node outside the structural top-20
    // cannot boost in; widen the cap into an opts pass-through if that ever bites.
    const out: NeighborResult[] = []
    // Resolve each neighbour by the ONE link rule (contracts linkLookupScopes), not by assuming the
    // traversed scope: an edge authored in a plan scope may name a note that lives in the durable
    // project lane, and looking it up only in the plan scope is what silently dropped it. Cross-scope
    // neighbours are TERMINAL here — the edge set is still the traversed scope's own, so reaching a
    // project note does not drag the whole project graph into a plan traversal.
    const lookupScopes = linkLookupScopes(scope)
    const findNote = async (id: string) => {
      for (const s of lookupScopes) {
        const found = (await this.db.select(Tb.Note, key(s, id)))[0]
        if (found) return { row: found, scope: s }
      }
      return null
    }
    for (const n of ranked) {
      const hit = await findNote(n.id)
      if (!hit) continue
      const { row, scope: foundScope } = hit
      const act = activation({ hits: row.hits ?? 0, lastAccessedAt: row.lastAccessedAt ?? null }, now, halfLife)
      out.push({
        id: n.id, title: row.title, summary: row.summary, via: n.via, depth: n.depth,
        score: n.score * activationBoost(act), direction: n.direction, activation: act, from: n.from,
        workspaceId: row.workspaceId,
        ...(foundScope !== undefined && { scope: foundScope }),
      })
    }
    // same total order rule as rankNeighbors, now over the boosted score
    return out.sort((a, b) => b.score - a.score || a.depth - b.depth || a.id.localeCompare(b.id))
  }

  async get(id: string, scope: string = MemoryScope.project): Promise<MemoryNote | null> {
    const rows = await this.db.select(Tb.Note, key(scope, id))
    const r = rows[0]
    if (!r) return null
    return MemoryNote.parse(toNote(r))
  }

  async list(filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    const rows = await this.db.select(Tb.Note)
      .where(n => this.matchFilter(n, filter))
      .orderBy('updatedAt', 'DESC')
    return rows.filter(r => matchesRow(r, filter)).map(toSummary)
  }

  // Which notes DECLARE one of these paths — any tier, any scope, whatever their drift flags say.
  //
  // WHY it exists: post-commit drift read 4/7 twice in one day. The heal candidates were taken from
  // drift FLAGS, which are measured against committed revisions and so lag the uncommitted work an
  // auditor has just looked at, while the commit restamp only covers the notes the task itself
  // wrote. A note somebody else authored that cites a changed path was in neither set. This read is
  // that middle: citation, not staleness.
  //
  // A raw select, not a builder predicate: `paths` is an option-wrapped array column, and surqlize
  // resolves `.contains` on one as a FIELD access rather than the array method — the crash list()'s
  // `categories` filter hit.
  //
  // NOT CONTAINSANY: that operator is array-element EQUALITY, so a note declaring the DIRECTORY
  // 'packages/graph-ui' was never returned for a changed FILE under it, e.g.
  // 'packages/graph-ui/page/ui/theme.css' — observed live (commit e275fc6/task af86a1e6),
  // citingNotes came back empty for exactly that commit even though drift.ts's noteHasDrifted
  // correctly flags the same note drifted, because CONTAINSANY does not implement noteHasDrifted's
  // directory-prefix rule. Expressing that prefix rule IN SurrealQL is possible but not simple
  // (STARTS WITH per declared path, one comparison per row per path, with no index to drive it);
  // since the corpus is small (~100 notes), this instead pulls every note that declares AT LEAST
  // ONE path and filters client-side through `pathCovers` — the exact predicate noteHasDrifted
  // already uses, so a citation and a drift verdict can never disagree about what "covers" means.
  async notesCitingPaths(paths: readonly string[]): Promise<CitingNote[]> {
    // No paths means no citations to find. Short-circuited HERE as well as in notesCiting, because
    // an empty `$paths` would otherwise pull the whole path-bearing corpus for nothing.
    if (paths.length === 0) return []
    const res = await this.surreal.query(
      `SELECT ${CITING_COLUMNS} FROM ${Tb.Note} WHERE paths != NONE AND array::len(paths) > 0`,
    )
    const rows = CitingRow.array().parse(Array.isArray(res) ? res[0] : res)
    // dedupe by scope:id — the same note matching several of the input paths is one candidate
    const byKey = new Map<string, CitingNote>()
    for (const r of rows) {
      const declared = r.paths ?? []
      if (!declared.some(d => paths.some(f => pathCovers(d, f)))) continue
      byKey.set(key(r.scope, r.noteId), {
        id: r.noteId, scope: r.scope, title: r.title, sourceRevision: r.sourceRevision ?? null,
      })
    }
    return [...byKey.values()]
  }

  async search(query: string, filter: MemoryFilter = {}, opts: MemorySearchOpts = {}): Promise<NoteSummary[]> {
    // No embedder configured → keyword is the only mode that can run, whatever was requested.
    const mode = this.embedder ? (opts.mode ?? SEARCH_MODE.hybrid) : SEARCH_MODE.keyword
    if (mode === SEARCH_MODE.keyword) return knowledge(await this.keywordSearch(query, filter))
    const semantic = knowledge(await this.semanticSearch(query, filter, opts.halfLifeDays))
    if (mode === SEARCH_MODE.semantic) return semantic
    // hybrid: fuse the two orderings by reciprocal rank, keyed by (scope,id) since ids repeat
    // across scopes. A note found by only one arm still ranks; agreement between arms wins.
    //
    // THE COST OF THAT IS STRUCTURAL AND MEASURED ON TWO CORPORA: a union cannot preserve SILENCE.
    // If either arm answers, the fused surface answers, so an arm refusing a query — which is
    // information, and the only thing meetsQuorum and SEMANTIC_FLOOR buy — is discarded whenever the
    // other arm speaks. Every fusion loss on the benchmark is that shape: 3 of 4 losses on this
    // corpus and 5 of 5 on the second are negative probes where the keyword arm was correctly
    // silent and the semantic arm was not. Fusion is not therefore bad — fused top-1 ties or beats
    // both arms and fused zero-result is the lowest of the three — but no threshold in either arm
    // can fix the negative column, because the fix belongs HERE (a negative-consensus rule: stay
    // silent when the arm that CAN refuse did).
    const keyword = knowledge(await this.keywordSearch(query, filter))
    const byKey = new Map<string, NoteSummary>()
    for (const n of [...semantic, ...keyword]) byKey.set(noteKey(n.scope, n.id), n)
    const fused = rrfFuse([keyword.map(n => noteKey(n.scope, n.id)), semantic.map(n => noteKey(n.scope, n.id))])
    return fused.map(f => byKey.get(f.id)).filter((n): n is NoteSummary => n !== undefined)
  }

  // Claim-level retrieval: the same two arms and the same reciprocal-rank fusion as search() above,
  // over `claim` instead of `note`. Deduped by owning note LAST, so the cap counts notes rather than
  // statements — fusing first and deduping after is what makes the surviving claim per note its
  // best-ranked one.
  async searchClaims(query: string, filter: MemoryFilter = {}, opts: ClaimSearchOpts = {}): Promise<ClaimHit[]> {
    const limit = opts.limit ?? CLAIM_SEARCH_LIMIT
    const mode = this.embedder ? (opts.mode ?? SEARCH_MODE.hybrid) : SEARCH_MODE.keyword
    // Resolved ONCE and shared by both arms: list() is a full in-scope note scan, and a hybrid
    // claim search used to run it twice — on the hottest path there is, since searchClaims backs
    // every memory_search and every step preload.
    const owners = await this.claimOwners(filter)
    const keyword = mode === SEARCH_MODE.semantic ? [] : await this.keywordClaims(query, owners)
    const semantic = mode === SEARCH_MODE.keyword ? [] : await this.semanticClaims(query, filter, owners)
    // 'all' skips the per-note collapse: the caller is enumerating a set, not ranking for a slot
    // budget, and `limit` then caps CLAIMS rather than notes (see ClaimSearchOpts.perNote).
    const cap = (hits: readonly ClaimHit[]): ClaimHit[] =>
      opts.perNote === 'all' ? hits.slice(0, limit) : dedupeByNote(hits, limit)
    if (mode !== SEARCH_MODE.hybrid) return cap(mode === SEARCH_MODE.keyword ? keyword : semantic)
    const byKey = new Map<string, ClaimHit>()
    for (const h of [...semantic, ...keyword]) byKey.set(claimHitKey(h), h)
    const fused = rrfFuse([keyword.map(claimHitKey), semantic.map(claimHitKey)])
    const ranked = fused.map(f => byKey.get(f.id)).filter((h): h is ClaimHit => h !== undefined)
    return cap(ranked)
  }

  // Full-text match over claim text, OR across terms under the same quorum rule keywordSearch
  // applies — ONE spelling of both, in keyword.ts, because two arms disagreeing about what counts as
  // a hit is exactly the drift that rule exists to prevent. A claim row has one searchable field, so
  // its coverage is just how many query terms the statement carries; newest-established still breaks
  // a tie, as it did when this arm had no relevance score at all.
  //
  // THE RULE IS CALIBRATED ON THE NOTE ARM AND INHERITED HERE UNMEASURED — bench/probes.json grades
  // notes, so nothing in that sweep saw a claim. What IS measured here is recall: this arm's
  // zero-result rate over the same 20 probes went 16/20 to 8/20. Its top-k quality is unverified.
  // See keyword.ts's meetsQuorum, which owns that disclosure and the numbers.
  //
  // ponytail: no LIMIT, same unbounded fetch and same upgrade path as keywordSearch above — and
  // worse here, since claims outnumber notes.
  private async keywordClaims(query: string, owners: OwnerMap): Promise<ClaimHit[]> {
    const terms = keywordTerms(query)
    if (terms.length === 0) return []
    const fts = ftsQuery(terms, namesOf(CLAIM_SEARCH_FIELDS))
    const res = await this.surreal.query(
      `SELECT ${CLAIM_COLUMNS}, [${fts.scores}] AS kwScores, [${fts.matches}] AS kwMatches`
      + ` FROM ${Tb.Claim} WHERE (${fts.where})`,
      fts.vars,
    )
    const rows = KeywordClaimRow.array().parse(Array.isArray(res) ? res[0] : res)
    const weights = weightsOf(CLAIM_SEARCH_FIELDS)
    return joinClaimOwners(
      rows
        .map(r => ({ r, k: foldRow(r.kwMatches, r.kwScores, weights) }))
        .filter(({ k }) => meetsQuorum(k.matched, terms.length))
        .sort((a, b) => keywordCompare(a.k, b.k) || ascending(b.r.validFrom, a.r.validFrom))
        .map(({ r }) => r),
      owners,
    )
  }

  // Cosine over per-claim embeddings — same brute-force scan, same degrade-to-keyword contract as
  // semanticSearch: a dimension mismatch or a malformed row must never fail the whole search.
  private async semanticClaims(query: string, filter: MemoryFilter, owners: OwnerMap): Promise<ClaimHit[]> {
    if (!this.embedder) return []
    try {
      const [qv] = await this.embedder.embed([query])
      if (!qv) return []
      const scopes = filter.scope === undefined ? [] : [filter.scope].flat()
      const res = await this.surreal.query(
        `SELECT ${CLAIM_COLUMNS},`
        + ` vector::similarity::cosine(embedding, $q) AS score`
        + ` FROM ${Tb.Claim} WHERE embedding != NONE`
        + (scopes.length > 0 ? ` AND scope IN $scopes` : '')
        + ` ORDER BY score DESC LIMIT 50`,
        { q: qv, ...(scopes.length > 0 && { scopes }) },
      )
      const rows = ClaimRow.array().parse(Array.isArray(res) ? res[0] : res)
      // Same margin rule as the note arm, spelled once in keyword.ts and applied here for the same
      // reason SEMANTIC_FLOOR is — one arm's confidence rule cannot mean two different things
      // depending on whether the match unit is a note or a statement. MEASURED as scoreboard-
      // neutral on the claim probes of both corpora (3 and 3): it silences only the "stripe cli"
      // claim negative, which the keyword arm answers on corpus A anyway and which already passed
      // on corpus B. Claim cosines run higher and were never graded at depth — see meetsQuorum's
      // note on inheriting a note-calibrated rule; this is the same risk, taken knowingly.
      const candidates = rows.filter(r => !isUiMetaNote(r.scope, r.noteId))
      if (!meetsMargin(candidates.map(r => r.score))) return []
      return joinClaimOwners(candidates.filter(r => r.score >= SEMANTIC_FLOOR), owners)
    } catch (err) {
      console.warn(`[memory] claim semantic search failed, falling back to keyword: ${errorMessage(err)}`)
      return []
    }
  }

  // A claim's title comes from its owning note, and so does every filter it cannot answer itself: a
  // claim row deliberately does not duplicate tier/categories/tags. ONE note query, not one per hit
  // — list() already applies the whole filter, so the notes that survive it ARE the allowed owners
  // and a hit whose note is missing from the map is one the filter excluded, deleted, or never had.
  // knowledge() on top, the same exclusion search() applies: a claim asserted on a ui-metadata note
  // must not reach the retrieval surface through the arm that skipped the check.
  private async claimOwners(filter: MemoryFilter): Promise<OwnerMap> {
    return new Map(knowledge(await this.list(filter)).map(n => [noteKey(n.scope, n.id), n]))
  }

  // Vector cosine over stored embeddings — a linear scan, brute-force but exact; fine for a
  // hand-authored corpus. Filters apply in TS, mirroring keywordSearch. ponytail: swap the scan for
  // a DEFINE INDEX ... HNSW + `<|K|>` KNN select when the corpus outgrows a full scan.
  private async semanticSearch(query: string, filter: MemoryFilter, halfLifeDays?: number): Promise<NoteSummary[]> {
    if (!this.embedder) return []
    // Everything after the embedder check is best-effort and guarded as ONE unit: a query-embed
    // reject, a cosine DIMENSION error (a note embedded under a different model width after a model
    // swap without a rebuild), or a malformed row must DEGRADE to keyword — never fail the whole
    // search. Returning [] makes hybrid fuse keyword-only (keyword notes survive) and semantic-only
    // return the honest empty; it honours the contract's degraded-tolerant intent.
    try {
      const [qv] = await this.embedder.embed([query])
      if (!qv) return []
      // raw query: surqlize has no vector::* select builder — the same escape hatch open() uses for
      // DEFINE TABLE. $q binds the query vector; rows without an embedding are excluded.
      // the scope predicate belongs in the WHERE, ahead of ORDER BY/LIMIT — see MemoryFilter
      const scopes = filter.scope === undefined ? [] : [filter.scope].flat()
      const res = await this.surreal.query(
        // SUMMARY_COLUMNS, not an inline list: it is derived from SummaryRow, so the projection and
        // the parse of this row cannot drift (zod strips unknown keys, so a hand-kept list widened
        // alone was silent). sourceRevision and paths are why that matters — they are the ONLY two
        // inputs the drift check has, and a hit that omits them is silently uncheckable, drops out
        // of corpusDrift's denominator, and makes the preload print "unchanged since they were
        // written — trust them" over exactly the notes it could not check.
        `SELECT ${SUMMARY_COLUMNS},`
        + ` vector::similarity::cosine(embedding, $q) AS score`
        + ` FROM ${Tb.Note} WHERE embedding != NONE`
        + (scopes.length > 0 ? ` AND scope IN $scopes` : '')
        + ` ORDER BY score DESC LIMIT 50`,
        { q: qv, ...(scopes.length > 0 && { scopes }) },
      )
      const rows = SemanticRow.array().parse(Array.isArray(res) ? res[0] : res)
      // THE WITHIN-QUERY MARGIN RULE (keyword.ts's meetsMargin owns it and the sweep behind its
      // constant). Whole-arm, not per-row: the question is whether THIS QUERY found anything that
      // stands out, so the answer is all rows or none. It runs on the RAW cosines, ahead of both
      // the floor and the re-rank — cos × heat would let a much-read bystander widen the very gap
      // being measured.
      //
      // knowledge() FIRST, for the same reason SEMANTIC_FLOOR's table is measured post-knowledge:
      // a ui-metadata note is never returnable, so letting one sit in the window measures a
      // distribution the rule does not act on. search() applies knowledge() again on the way out;
      // this is the same predicate, moved early, and changes nothing else about what is returned.
      const candidates = rows.filter(r => !isUiMetaNote(r.scope, r.noteId))
      if (!meetsMargin(candidates.map(r => r.score))) return []
      // use makes memory more findable: re-rank cosine by activation heat, mirroring neighbors() so a
      // note agents keep reading rises in search (and thus preload) as it does in the graph.
      //
      // Heat MODULATES the cosine — it must never overrule it. This used to score
      // `(score + 1) * heat`, shifting cosine into [0,2] first so the heat factor (≥1) stayed
      // monotonic across the whole cosine range: multiplying a NEGATIVE cosine by ≥1 sinks a hotter
      // note below a colder one, which is a real inversion. That reasoning was correct when written
      // and is obsolete now for one reason: the SEMANTIC_FLOOR filter runs first, so every row
      // reaching this line has cosine ≥ 0 and the case the shift defended against cannot arise.
      //
      // THE COUPLING, stated once (SEMANTIC_FLOOR's comment points here). heat = 1 + 0.25*log1p(a)
      // ≥ 1, so `c * h` is increasing in h for c > 0, FLAT at c = 0, and decreasing only for c < 0.
      // The invariant is therefore: SEMANTIC_FLOOR ≥ 0, and this .map stays BELOW the filter. A
      // floor of exactly 0 is safe — `>=` still drops every negative cosine and ties the rest at 0
      // — it just stops being a useful floor, which the floor's own test catches, not this one.
      //
      // The shift had to go because it destroyed the signal's dynamic range. MEASURED on the live
      // corpus (~27 embedded notes, ollama/mxbai-embed-large):
      //   term                  observed span        ratio
      //   cosine, shifted       1.417 .. 1.769       1.25x   <- the signal, after +1
      //   cosine, unshifted     0.417 .. 0.769       1.84x
      //   heat                  1.00  .. 1.57        1.57x   <- the modulator (hottest note: 9 hits)
      // A 1.25x signal cannot survive a 1.57x modulator: 9 hits outweighed the ENTIRE cosine range.
      // It cost positive queries, not just negatives — "mermaid vault markdown render" put area-vault
      // (cosine 0.769, the best match in the corpus) at rank 3 behind area-contracts at 0.502 × 1.57,
      // and still passed top-3, which is why it went unseen until the benchmark grew a top-1 column.
      //
      // All 15 non-negative probes in bench/probes.json, semantic arm alone (search() is hybrid, and
      // RRF fuses by RANK — it discards these magnitudes, so the end-to-end benchmark cannot see this
      // change), both formulas measured with the floor active:
      //   (cos+1) × heat (old)    7/15 top-1   10/15 top-3
      //   cos × heat     (this)   9/15 top-1   12/15 top-3   <- chosen
      // Three probes moved, all forward, none lost: "durable execution workflow" miss→@1, "mermaid
      // vault markdown render" top3→@1, "write zone" miss→top3.
      // Note ACTIVATION_GAIN is untouched: 0.25 only looked too large because the shift left the
      // cosine term nothing to compete with. ponytail: a hot note outside the cosine top-50 can't
      // boost in — widen LIMIT if it bites.
      const now = new Date().toISOString()
      const halfLife = halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
      const heat = (r: { hits?: number; lastAccessedAt?: string | null }): number =>
        activationBoost(activation({ hits: r.hits ?? 0, lastAccessedAt: r.lastAccessedAt ?? null }, now, halfLife))
      return candidates
        .filter(r => r.score >= SEMANTIC_FLOOR)
        .filter(r => matchesRow(r, filter))
        .map(r => ({ r, s: r.score * heat(r) }))
        .sort((a, b) => b.s - a.s)
        .map(({ r }) => toSummary(r))
    } catch (err) {
      console.warn(`[memory] semantic search failed, falling back to keyword: ${errorMessage(err)}`)
      return []
    }
  }

  // Compute a note's vector from its retrieval-bearing text. Best-effort: a backend failure logs
  // once and yields undefined (the note still stores, keyword still finds it). Takes the payload
  // decodeMemoryEvent already parsed — no second decode of the same event.
  private async embedWritten(p: MemoryWrittenPayload, seq: number): Promise<number[] | undefined> {
    if (!this.embedder) return undefined
    const { note } = p
    const text = [note.title, note.summary, note.body].filter(Boolean).join('\n').slice(0, MEMORY_LIMITS.embedInputChars)
    try { const [vec] = await this.embedder.embed([text]); return vec }
    catch (err) { console.warn(`[memory] embed failed at seq ${seq}: ${errorMessage(err)}`); return undefined }
  }

  // A vector per claim, so semantic search can match a statement instead of a document. ONE batched
  // round trip like embedWritten's, and outside the transaction for the same reason. Best-effort on
  // the same terms too: a backend failure logs once and leaves the claims keyword-findable.
  // ponytail: re-embeds every live claim on each write to the note; carry vectors forward from the
  // rows read above if a hot note with many claims makes the embedder cost bite.
  private async embedClaims(p: MemoryWrittenPayload, seq: number): Promise<Map<string, number[]>> {
    const out = new Map<string, number[]>()
    if (!this.embedder) return out
    const n: NoteFields = p.note
    const claims = n.claims ?? []
    if (claims.length === 0) return out
    try {
      const vecs = await this.embedder.embed(claims.map(c => c.text.slice(0, MEMORY_LIMITS.embedInputChars)))
      claims.forEach((c, i) => {
        const vec = vecs[i]
        if (vec) out.set(c.id, vec)
      })
    } catch (err) {
      console.warn(`[memory] claim embed failed at seq ${seq}: ${errorMessage(err)}`)
    }
    return out
  }

  // A note's live claims as the read model holds them — each stamped with the event that first
  // carried it, which is why this reads the derived table rather than the note row.
  async claimsFor(noteId: string, scope: string = MemoryScope.project): Promise<Claim[]> {
    const rows = await this.db.select(Tb.Claim).where(c => c.noteId.eq(noteId).and(c.scope.eq(scope)))
    return rows.map(r => Claim.parse({
      id: r.claimId, text: r.text, class: r.class, anchors: r.anchors,
      validFrom: r.validFrom, sourceRevision: r.sourceRevision,
    }))
  }

  // Stage 3 for EDGES, the peer of refreshTopics below. The link table is supposed to be a function
  // of the live note set — each note asserts its own out-edges and the read model materializes them
  // — and materializing per event does not deliver that:
  //   * SurrealDB removes a RELATE edge when EITHER endpoint record is deleted (measured), so
  //     deleting a note destroys edges its neighbours authored and never retracted. No WHERE clause
  //     on our side can prevent it.
  //   * Replay does not repair it: the edge is created when its OWNING note's event is applied, a
  //     later delete of the target cascades it away, and the owner is never rewritten. Both notes
  //     end live, the owner still asserting the edge, and no row exists — a fact the log holds,
  //     permanently absent from the read model.
  // Recomputing from the live notes restores the invariant by construction. Runs OUTSIDE the event
  // transaction, gated by the projector on "did this drain touch the set", exactly as topics are.
  //
  // Delete-then-RELATE inside ONE transaction is safe HERE and would not be for claims: the pitfall
  // at applyEvent is about a FIXED record id, which stays deleted at commit. Edge ids are generated,
  // and this was measured before the code was written — 1 row in, delete + relate, 1 row out.
  //
  // Stats survive by (scope, from, to, kind) — the survivor rule itself lives in relateLinks,
  // shared with the per-note rewrite in applyEvent, so the two writers cannot drift.
  async refreshLinks(): Promise<void> {
    const notes = await this.db.select(Tb.Note)
    await this.db.transaction(async tx => {
      this.seams.onTransaction?.(tx)
      const stats = linkStatsOf(await tx.select(Tb.Link))
      await tx.delete(Tb.Link)
      for (const n of notes) await relateLinks(tx, n.scope, n.noteId, n.links, stats)
    })
  }

  // Stage 3 for TOPICS. Recomputes the partition from the current claim set and replaces the topic
  // table — no cursor, nothing to resume: it either completes or the next drain redoes it. Runs
  // OUTSIDE the event transaction, because grouping is a whole-corpus derivation rather than a
  // per-event projection.
  async refreshTopics(threshold: number = MEMORY_CLUSTER_THRESHOLD): Promise<void> {
    // project scope only: claims are semantic-tier, durable knowledge is project-scoped, and a topic
    // view over one task's transient trail is noise. knowledge() for the same reason search() and
    // the claim arm apply it — a topic is a retrieval surface, and ui-metadata is excluded from
    // those entirely; without it a claim on 'ui-project-name' could become a topic member and come
    // back from memory_topics while the note itself stays hidden.
    const rows = (await this.db.select(Tb.Claim).where(c => c.scope.eq(MemoryScope.project)))
      .filter(r => !isUiMetaNote(r.scope, r.noteId))
    const claims: ClusterInput[] = rows.flatMap(r =>
      r.embedding === undefined ? [] : [{ id: r.claimId, vector: r.embedding }])
    const groups = partition(claims, threshold)
    await this.db.transaction(async tx => {
      this.seams.onTransaction?.(tx)
      // Drop exactly the rows THIS refresh drops, in one statement that never reads a row — not a
      // blanket delete-then-recreate (a topic key is a deterministic claim id, and deleting a fixed
      // record id and upserting the SAME id inside one Surreal transaction leaves it deleted at
      // commit, the same pitfall the claim re-materialization above works around), and not a
      // read-then-filter either: selecting every row would parse each one against topicTable's
      // shape, so one row left over from before a later required column existed throws and aborts
      // the WHOLE refresh — caught by the projector's best-effort wrapper, which leaves the table
      // stale until someone notices and runs a manual rebuild. An empty `liveKeys` correctly clears
      // the table (every row is then "not inside" the empty set).
      // `.notInside(...)`, NOT `.inside(...).not()`: surqlize's `not()` prefixes with bare `!`
      // ahead of the whole comparison — `!$this["topicKey"] IN $_v1`, no parens — which SurrealQL
      // parses as `(!topicKey) IN v`, not `!(topicKey IN v)`. Verified live: `.inside(v).not()`
      // deletes nothing, ever, empty `v` or not. `.notInside` compiles straight to `NOT IN`, one
      // operator, no precedence trap, confirmed against a real SurrealDB.
      const liveKeys = groups.map(g => g.key)
      await tx.delete(Tb.Topic).where(r => r.topicKey.notInside(liveKeys))
      for (const g of groups)
        // Identity only — which claims grouped, and which one represents them. How that renders is
        // topics()' business, so changing the label rule (or its width) needs no rebuild.
        await tx.upsert(Tb.Topic, g.key).set({
          topicKey: g.key,
          medoidClaimId: g.medoidClaimId,
          members: g.members,
        })
    })
  }

  // The label is derived HERE, from the medoid claim's live text — the one place it is decided, and
  // the reason no stored row can carry a label that violates the bound contracts declares.
  // Costs one claim scan, the same one topicClaims() already does per call.
  async topics(): Promise<Topic[]> {
    const rows = await this.db.select(Tb.Topic)
    if (rows.length === 0) return []
    const text = new Map((await this.db.select(Tb.Claim).where(c => c.scope.eq(MemoryScope.project)))
      .map(r => [r.claimId, r.text]))
    return rows
      .map(r => Topic.parse({
        topicKey: r.topicKey,
        // topicKey is the group's lowest member id, so it is the standing fallback for the window
        // between a medoid being retired and the next refresh re-partitioning without it. If BOTH are
        // gone the label falls through to topicKey: a row labelled '' is worse than no row, and the
        // name is appended to the immutable log via memory_topic_accessed, where it cannot be repaired.
        label: topicLabel(text.get(r.medoidClaimId) ?? text.get(r.topicKey) ?? r.topicKey, MEMORY_LIMITS.topicLabelChars),
        size: r.members.length,
      }))
      // `ascending`, not localeCompare: the same rule cluster.ts breaks its own ties by, so the
      // listing order cannot disagree with the partition's over an ambient ICU locale
      .sort((a, b) => b.size - a.size || ascending(a.topicKey, b.topicKey))
  }

  // The claims of one topic. An unknown key yields [] — the CALLER distinguishes "no such topic" from
  // "an empty one" by consulting topics(), because only it knows how to phrase that to its audience.
  //
  // Deduped by claimId, so the list agrees with `Topic.size`. A claim ROW is keyed (scope, noteId,
  // claimId), so the same statement asserted on two notes is two rows — but a topic groups
  // STATEMENTS, and `partition` already counts the id once. Returning both rows listed one statement
  // twice under a size that said one, and since `Claim` carries no noteId the reader could not even
  // tell they were the same fact: it read as two independent corroborations, the exact double
  // counting this design exists to avoid. The EARLIEST validFrom wins — that is the honest first
  // sighting of the statement, whichever note happened to state it first.
  async topicClaims(topicKey: string): Promise<Claim[]> {
    const topic = (await this.db.select(Tb.Topic, topicKey))[0]
    if (!topic) return []
    const rows = await this.db.select(Tb.Claim).where(c => c.scope.eq(MemoryScope.project))
    const members = new Set(topic.members)
    const byClaim = new Map<string, Claim>()
    for (const r of rows) {
      if (!members.has(r.claimId)) continue
      const claim = Claim.parse({
        id: r.claimId, text: r.text, class: r.class, anchors: r.anchors,
        validFrom: r.validFrom, sourceRevision: r.sourceRevision,
      })
      const prev = byClaim.get(claim.id)
      if (!prev || claim.validFrom < prev.validFrom) byClaim.set(claim.id, claim)
    }
    return [...byClaim.values()]
  }

  // OR across terms over the FULLTEXT indexes, kept honest by keyword.ts's quorum rule. This
  // replaced an AND over case-insensitive SUBSTRING matches, which had two defects that only look
  // like one: AND made the arm silent on every query of 5+ terms (13 of 20 bench probes returned
  // nothing), and `contains` has no token boundary, so it could not simply be switched to OR — the
  // term 'a' would have matched every note in the corpus.
  //
  // RAW query, like semanticSearch's cosine select: surqlize has no builder for the `@N@` match
  // operator or for search::score. That costs the builder's filter push-down, so — again exactly as
  // semanticSearch does — scope goes into the WHERE and the remaining filter fields are applied in
  // TS by matchesRow.
  //
  // ponytail: NO LIMIT, unlike semanticSearch's `LIMIT 50`. This fetches EVERY matching note —
  // summary text plus a 32-element score array and a 32-element match array each — and ranks in TS.
  // OR-across-terms makes that set much larger than the AND arm's was: a query containing 'the'
  // matches essentially every note, because the analyzer indexes stop-words and nothing filters
  // them (see keywordTerms' note on why dropping them was measured and rejected). At 27 notes the
  // whole fetch is inside one round trip and invisible; it is linear in corpus size, so the
  // ceiling is real and unmeasured beyond this corpus.
  //
  // Capping it is NOT free, which is why it is named rather than done: the primary rank key is
  // `coverage`, a field-weighted count of matched clauses, and SurrealQL cannot ORDER BY it — the
  // match predicates are booleans, not addable. The upgrade is `ORDER BY <the search::score sum>
  // DESC LIMIT n` and accepting that the candidate window is then chosen by BM25 while the ranking
  // inside it stays coverage-first, i.e. an approximation of the key that was measured (BM25 alone
  // scored 12/15 top-3 against coverage's 13/15 — see keyword.ts). Adding it blind would have
  // silently traded measured quality for an unmeasured constant.
  private async keywordSearch(query: string, filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    const terms = keywordTerms(query)
    if (terms.length === 0) return []
    const fts = ftsQuery(terms, namesOf(NOTE_SEARCH_FIELDS))
    const scopes = filter.scope === undefined ? [] : [filter.scope].flat()
    const res = await this.surreal.query(
      `SELECT ${SUMMARY_COLUMNS}, updatedAt, [${fts.scores}] AS kwScores, [${fts.matches}] AS kwMatches`
      + ` FROM ${Tb.Note} WHERE (${fts.where})`
      + (scopes.length > 0 ? ` AND scope IN $scopes` : ''),
      { ...fts.vars, ...(scopes.length > 0 && { scopes }) },
    )
    const rows = KeywordRow.array().parse(Array.isArray(res) ? res[0] : res)
    const weights = weightsOf(NOTE_SEARCH_FIELDS)
    return rows
      .filter(r => matchesRow(r, filter))
      .map(r => {
        const k = foldRow(r.kwMatches, r.kwScores, weights)
        // +1 for durable project scope, folded into the SAME key it has always been part of, so a
        // transient plan-scope note cannot bury the knowledge base at equal coverage.
        return { r, k: { ...k, coverage: k.coverage + (r.scope === MemoryScope.project ? 1 : 0) } }
      })
      .filter(({ k }) => meetsQuorum(k.matched, terms.length))
      .sort((a, b) => keywordCompare(a.k, b.k) || ascending(b.r.updatedAt, a.r.updatedAt))
      .map(({ r }) => toSummary(r))
  }

  // surqlize's fluent `.where()` builder expresses scope/category/tag filtering directly
  // (array-contains via `.contains()`) — no raw-SurrealQL fallback needed for this.
  // `n` is the per-row Actionable proxy handed in by `.where()`; typed `any` here because it
  // crosses a helper-method boundary (the builder's context type is per-call-site generic).
  private matchFilter(n: any, filter: MemoryFilter): any {
    // always-true seed (SurrealQL needs a base predicate to `.and()` onto; `deleted` used to
    // serve this role, but there are no soft-deleted rows anymore — see applyDeleted).
    let cond = n.scope.eq(n.scope)
    const [firstScope, ...moreScopes] = filter.scope === undefined ? [] : [filter.scope].flat()
    if (firstScope !== undefined)
      cond = cond.and(moreScopes.reduce((acc, sc) => acc.or(n.scope.eq(sc)), n.scope.eq(firstScope)))
    // scope ONLY — tier/category/tag are answered by matchesRow in TS. `.contains` on an
    // option-wrapped array column (categories) resolves on the builder proxy as a nested FIELD
    // access, not the array method, so the category predicate crashed every `ls --category`;
    // one row-level spelling also keeps list() and the raw search arms agreeing on filter meaning.
    return cond
  }

  async getCursor(): Promise<number> {
    const rows = await this.db.select(Tb.Meta, 'cursor')
    return rows[0]?.seq ?? 0
  }

  // Its own row, NOT the cursor row: writing the stage onto 'cursor' would put a presentation
  // field inside the one record whose integrity the whole projection depends on.
  async setStage(stage: { name: string; startedAt: number; pid: number; progress?: { applied: number; total: number } } | null): Promise<void> {
    // Clearing DELETES the row rather than setting the columns undefined: "no row" is unambiguous,
    // where an undefined column depends on whether the driver omits the key or erases it — and
    // getting that wrong leaves a stale stage on screen forever, which is exactly what happened.
    if (stage === null) { await this.db.delete(Tb.Meta, 'stage'); return }
    // The progress pair is written UNCONDITIONALLY, undefined included, and that is the point: an
    // upsert MERGES, so a conditional spread would leave the replay's last 240/376 sitting on the
    // clustering stage that followed it. Here the documented "undefined erases the column" behaviour
    // is exactly what a stage carrying no count wants.
    await this.db.upsert(Tb.Meta, 'stage').set({
      stage: stage.name, stageAt: stage.startedAt, stagePid: stage.pid,
      stageApplied: stage.progress?.applied, stageTotal: stage.progress?.total,
    })
  }

  async getStage(): Promise<{ name: string; startedAt: number; pid: number; progress?: { applied: number; total: number } } | null> {
    const row = (await this.db.select(Tb.Meta, 'stage'))[0]
    if (row?.stage === undefined || row.stageAt === undefined || row.stagePid === undefined) return null
    // both halves or neither — a half-written pair is dropped rather than rendered as "240/"
    const progress = row.stageApplied !== undefined && row.stageTotal !== undefined
      ? { applied: row.stageApplied, total: row.stageTotal }
      : undefined
    return { name: row.stage, startedAt: row.stageAt, pid: row.stagePid, ...(progress && { progress }) }
  }

  // every note across scopes, in deterministic (scope, id) order — the vault rebuild input
  async allNotes(): Promise<MemoryNote[]> {
    const rows = await this.db.select(Tb.Note)
    return rows
      .map(r => MemoryNote.parse(toNote(r)))
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id))
  }
  // Removes the DATABASE, not its rows. `clear()` empties a database that is still in use — what
  // purge needs, since the chat survives and the schema with it. Deletion has no runtime left to
  // hold one, so the object itself must go: clearing left one empty database per deleted project
  // that nothing ever collected, which is the same litter dropSystemDatabase already avoids on the
  // Postgres side. Callable exactly once; the instance is unusable afterwards.
  async drop(): Promise<void> {
    if (!this.at) throw new Error('this store was opened without a database name — cannot drop it')
    // `use` the NAMESPACE alone: a database cannot be removed while selected, and
    // `type::database($db)` is not a valid function path (measured against SurrealDB v3.2.0 — it
    // parses as a ValidationError). The name is derived from the project id, never external input.
    await this.surreal.use({ namespace: this.at.ns })
    await this.surreal.query(`REMOVE DATABASE IF EXISTS \`${this.at.db}\`;`)
  }

  // ESCAPE HATCH: delete-all is expressible via the builder (`db.delete('note')` with no id deletes
  // the whole table), so no raw `surreal.query` is needed here.
  //
  // ONE transaction, not one statement per table. applyEvent gates replay on `e.seq <= cursor`, so
  // a clear that drops content while leaving the cursor ahead of it is unrecoverable through the
  // normal paths: start()/catchUp() both drain zero and probeMemory honestly reports healthy,
  // because "no events after the cursor" is true. Atomicity makes that state unreachable instead of
  // merely unlikely.
  async clear(): Promise<void> {
    await this.db.transaction(async tx => {
      this.seams.onTransaction?.(tx)
      await tx.delete(Tb.Note)
      await tx.delete(Tb.Meta)
      await tx.delete(Tb.Link)
      await tx.delete(Tb.Claim)
      await tx.delete(Tb.Topic)
    })
  }
  async close(): Promise<void> { await this.surreal.close() }
}

// map the stored row back to the MemoryNote shape (noteId → id; drop RecordId + Tier-2 fields).
function toNote(r: Record<string, any>) {
  return {
    // an absent tier (a row projected before the split) is classified by MemoryNote's own decoder
    // from the columns below, so a read model that has not been rebuilt still parses
    tier: r.tier, id: r.noteId, scope: r.scope, title: r.title, kind: r.kind, status: r.status,
    sourceRevision: r.sourceRevision ?? null,
    categories: r.categories, tags: r.tags,
    links: r.links, paths: r.paths, claims: r.claims, summary: r.summary, body: r.body,
    // ?? fallbacks so a row written before these fields existed still parses on rebuild
    retention: r.retention ?? 'durable',
    sources: r.sources,
    rationale: r.rationale, uncertainty: r.uncertainty, zone: r.zone,
    dependsOn: r.dependsOn, skillRefs: r.skillRefs, toolRefs: r.toolRefs, modelRef: r.modelRef,
    createdAt: r.createdAt, createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
    workspaceId: r.workspaceId,
    revision: r.revision,
    // absent on every note nobody has verified, which is most of them — MemoryNote leaves the key
    // off rather than defaulting it, because a defaulted stamp would be a claim nobody made
    verified: VerifiedStamp.safeParse(r.verified).data,
  }
}

// A tier field with no stored column or no toNote() mapping does not FAIL — MemoryNote.parse fills
// the tier's default over it, so the authored value reads back as []/'' while the log still holds
// it. That is exactly how the plan tier's dependsOn/skillRefs/toolRefs/modelRef were lost (the same
// four budget.ts's FitterCoversNote names leaking on the read cap). These aliases turn the next
// forgotten field into a compile error: every NoteView key must have a note-table column AND a
// toNote() key. `id` is the one exclusion — surqlize reserves it, so it is stored as `noteId`.
// `archived` joins `id` as an exclusion, for the opposite reason: an archived note has NO ROW at
// all (applyEvent deletes it), so the flag can never be read back off one. A row that exists is by
// definition not archived, which is why nothing here stores or maps it.
type ProjectionCoversTiers = Exclude<keyof NoteView, NoteColumn | 'id' | 'archived'> extends never ? true : never
const projectionCoversTiers: ProjectionCoversTiers = true
void projectionCoversTiers
type ToNoteCoversTiers = Exclude<keyof NoteView, keyof ReturnType<typeof toNote> | 'archived'> extends never ? true : never
const toNoteCoversTiers: ToNoteCoversTiers = true
void toNoteCoversTiers

function toSummary(r: Record<string, any>): NoteSummary {
  const u = useOf(r)
  const verified = VerifiedStamp.safeParse(r.verified).data
  return {
    id: r.noteId, scope: r.scope, title: r.title,
    // both drift inputs together — a reader holding only the revision invents the wrong comparison
    sourceRevision: r.sourceRevision ?? null, paths: r.paths ?? [],
    // the provisional input. No `?? ''` fallback, unlike the optional columns around it: an empty
    // workspace matches nothing in the table and provisionalOf would read it as "cannot tell", which
    // is indistinguishable from trunk knowledge — the column is required precisely so it is never
    // absent, and a row that somehow lacks it must fail the parse rather than answer wrongly.
    workspaceId: r.workspaceId,
    tier: z.enum(NoteTier).catch(inferTier(r)).parse(r.tier),
    categories: r.categories ?? [], tags: r.tags, summary: r.summary,
    hits: r.hits ?? 0, lastAccessedAt: r.lastAccessedAt ?? null,
    // conditional spread, not `?? undefined`: an explicit undefined key would parse fine here but
    // reads as a hollow field on every unverified note in every rendered summary
    ...(verified && { verified }),
    // present only when evidence exists — the common no-evidence case must not widen every envelope
    ...(u && { use: u }),
  }
}

// The ONE construction of UseStats from a note row's counter columns: toSummary's `use` field and
// useStats() must agree on when evidence exists (any nonzero counter) and how absence reads (null).
function useOf(r: { usefulHits?: number | null; lastUsefulAt?: string | null; deadEndHits?: number | null; lastDeadEndAt?: string | null }): UseStats | null {
  if (!r.usefulHits && !r.deadEndHits) return null
  return {
    useful: { hits: r.usefulHits ?? 0, lastAccessedAt: r.lastUsefulAt ?? null },
    deadEnd: { hits: r.deadEndHits ?? 0, lastAccessedAt: r.lastDeadEndAt ?? null },
  }
}
