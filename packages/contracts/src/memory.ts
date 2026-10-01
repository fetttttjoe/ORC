import { z } from 'zod'
import { Claim, ClaimHit, ClaimInput, ClaimWrite, VerifiedClaim, type ClaimSearchOptions } from './claim'
import { Topic } from './cluster'
// memory.ts → decision.ts → ids.ts/limits.ts, both leaves: no cycle. decision.ts must never import
// memory.ts back, or the vocabulary would resolve to undefined depending on load order — the same
// ordering trap that put MEMORY_ID_RE in ids.ts in the first place.
import { DecisionStatus } from './decision'
import { EVENT_KIND, type EventRecord } from './event-kinds'
import { composeAuthor, MemoryAuthor } from './author'
import { MEMORY_ID_RE } from './ids'
import { MEMORY_LIMITS } from './limits'
import { planScope } from './plan'
import { ProvisionalFlag } from './workspace-entity'

// re-exported so every memory consumer keeps importing this vocabulary from one place
export { MemoryAuthor, composeAuthor } from './author'
export { MEMORY_ID_RE, slugId } from './ids'
export * from './claim'

const Id = z.string().regex(MEMORY_ID_RE).max(128)


export enum LinkKind {
  refines = 'refines',
  supersedes = 'supersedes',
  contradicts = 'contradicts',
  depends_on = 'depends_on',
  example_of = 'example_of',
  derived_from = 'derived_from',
  relates_to = 'relates_to',
  decomposes_into = 'decomposes_into',
}

export const LINK_KIND = LinkKind

export const MemoryLink = z.object({
  id: Id,
  kind: z.enum(LinkKind).default(LinkKind.relates_to), // fills a missing key on a typed link; NOT a string-coercion
  confidence: z.number().min(0).max(1).optional(),
})
export type MemoryLink = z.infer<typeof MemoryLink>

// The human link shorthand, shared by the web note editor and `orc memory add --links`. It lives
// here rather than in the browser bundle because both authoring surfaces must accept exactly the
// same spelling — a note wired from the CLI and one wired from the dialog are the same edge.
// Entries are comma-separated, comma-separated entries, each 'kind:target-id' or a bare
// 'target-id' (kind omitted — the schema boundary defaults it to relates_to). Throws a friendly
// error naming the bad entry — surfaced inside the dialog like every other field validation.
export function parseLinkSpec(input: string): Array<{ id: string; kind?: LinkKind }> {
  return input
    .split(',')
    .map(e => e.trim())
    .filter(e => e.length > 0)
    .map(entry => {
      const sep = entry.indexOf(':')
      const rawKind = sep === -1 ? undefined : entry.slice(0, sep).trim()
      const id = (sep === -1 ? entry : entry.slice(sep + 1)).trim()
      const kind = rawKind === undefined ? undefined : z.enum(LinkKind).safeParse(rawKind)
      if (kind && !kind.success)
        throw new Error(`unknown link kind '${rawKind}' in '${entry}' — valid: ${Object.values(LinkKind).join(', ')}`)
      if (!MEMORY_ID_RE.test(id))
        throw new Error(`'${id}' is not a valid note id (lowercase letters/digits/dashes)`)
      return kind ? { id, kind: kind.data } : { id }
    })
}

// Citations. A URL is checked structurally, not by regex: only http(s), and never with embedded
// credentials — a `https://user:pw@host` citation would put a secret in the vault and in every
// projection of it. Bounded so one note cannot carry an unbounded blob of provenance.
export const MEMORY_SOURCE_LIMITS = { items: 20, urlChars: 2_048, titleChars: 300 } as const

const HttpUrl = z.string().max(MEMORY_SOURCE_LIMITS.urlChars).refine(value => {
  let url: URL
  try { url = new URL(value) } catch { return false }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
}, { message: 'must be a credential-free http(s) URL' })

// What a writer supplies. `retrievedAt` is absent by design — the projector stamps it from the
// canonical memory_written event timestamp, so an agent cannot claim when it fetched something.
// A supplied one is STRIPPED, not rejected: memory_write is an upsert, so an agent that reads a
// research note and writes it back would otherwise fail on the retrievedAt it was just handed.
// Forgery is defeated either way — the projector overwrites the field unconditionally.
export const MemorySourceInput = z.object({
  url: HttpUrl,
  title: z.string().max(MEMORY_SOURCE_LIMITS.titleChars).optional(),
})
export type MemorySourceInput = z.infer<typeof MemorySourceInput>

// What is stored and rendered: the authored citation plus the event-derived retrieval time.
export const MemorySource = MemorySourceInput.extend({ retrievedAt: z.string() })
export type MemorySource = z.infer<typeof MemorySource>

// Whether a note may ever be swept. Nothing reads this yet — the sweep is deferred
// (docs/IDEAS.md entry 1) — but it is captured now because it is the AUTHOR'S judgment at write
// time, and that is the only moment it exists. A field added later would silently default every
// note written in the interim to durable, which is precisely wrong for research findings.
// Defaults to `durable`: a note nobody classified must never become auto-deletable.
export enum Retention {
  durable = 'durable',
  expirable = 'expirable',
}

export const RETENTION = Retention

// knowledge lifecycle: current/target architecture stay distinguishable and queryable.
// `research` is a distilled web finding — it is the one kind that MUST carry a citation.
// A kind classifies a CLAIM, so it belongs to the semantic tier alone: 'plan' is not a kind of
// claim, it is a different memory system, and it lives in NoteTier below.
// `outcome` vs `decision` is the one distinction here learned the hard way. A consolidation
// (what one task DID) is an outcome, not a decision — they have different lifetimes and answer
// different questions. [Measured 2026-08-04: labeling outcome consolidations as decisions made
// "which decisions has this project made" unanswerable: the kind returned 42 task outcomes and
// zero architectural choices.] An outcome is true forever about a run that is
// over, while a decision stays live until something overturns it.
export enum NoteKind {
  fact = 'fact',
  decision = 'decision',
  outcome = 'outcome',
  architecture_current = 'architecture_current',
  architecture_target = 'architecture_target',
  documentation = 'documentation',
  research = 'research',
}

export const NOTE_KIND = NoteKind

// The retrieval-surface vocabulary for `categories` (SemanticNoteInput.categories, below): a
// FIXED three-value set, unlike `tags`, which is deliberately open and corpus-derived (see
// tools.ts's memory_search — it validates `tag` against what the corpus actually carries, never
// against an invented list here). noteLint's own advisory message and the codebase-analysis
// skill already state these three in prose; this is the one real exported enum for them, matched
// values rather than a hand-rolled literal array wherever a category is validated (memory_search's
// `category` filter, same discipline as NOTE_TIER above and packages/cli/src/main.ts's
// parseNoteTier).
export enum NoteCategory {
  subsystem = 'subsystem',
  'cross-cutting' = 'cross-cutting',
  target = 'target',
}

export const NOTE_CATEGORY = NoteCategory

// Every agent-memory system worth copying separates a cheap, lossless EPISODIC trail from a
// distilled, linked SEMANTIC tier. orc adds a third, PLAN, because a decomposition is neither: it
// is executable structure a human approves and the freezer turns into steps.
//   semantic — durable project knowledge: a claim plus its retrieval surface. The default.
//   episodic — the per-task trail a run leaves behind. Expirable by construction, swept by TTL.
//   plan     — one node of a task's decomposition: requirements, rationale, write-fence, deps.
// The tier decides which FIELDS a note may carry, so the lanes are separated structurally rather
// than by a soft rank penalty: a step note cannot grow claims[], and a claim cannot smuggle a zone.
export enum NoteTier {
  semantic = 'semantic',
  episodic = 'episodic',
  plan = 'plan',
}

export const NOTE_TIER = NoteTier

// The scope families of a memory note — matched values, never scattered literals (same rule
// as STRATEGY in plan.ts). `project` is the one durable knowledge scope; per-task transient
// plan scopes are derived by planScope(taskId) in plan.ts.
export enum MemoryScope { project = 'project' }

// Project-chat metadata stored as notes (display name, working directory) — infrastructure, not
// knowledge. Hidden from the graph view AND excluded from the retrieval surface: a real run was
// handed 'ui-project-name' as project context and then cited it as provenance. Still readable by
// id, which is how the chats list resolves a project's name. Fully present in the log/replay.
export const PROJECT_NAME_NOTE_ID = 'ui-project-name'
export const PROJECT_DIR_NOTE_ID = 'ui-project-dir'
const UI_META_NOTE_IDS: ReadonlySet<string> = new Set([PROJECT_NAME_NOTE_ID, PROJECT_DIR_NOTE_ID])
export const isUiMetaNote = (scope: string, id: string): boolean =>
  scope === MemoryScope.project && UI_META_NOTE_IDS.has(id)

// Where a link's target may live, in lookup order. THE one rule, because a MemoryLink names an id
// and carries no scope, so something has to decide which scope that id means — and two places
// decided independently, both landing on "the source's own scope": the projector pointed every edge
// at `key(note.scope, l.id)` (surreal.ts) and traversal looked the target up there too. A note in a
// transient plan scope referring to durable project knowledge therefore authored an edge that reads
// as a connection in the payload and resolves to nothing on traversal. Measured on a real grounded
// run: 7 of 23 edges dead that way, every one of them a plan note reaching for project knowledge —
// exactly the link the whole carried-memory idea depends on.
//
// Own scope first (a plan's internal decomposition, where ids are local and may shadow), then the
// project scope (the durable lane every transient scope is allowed to reference). Used by traversal,
// by write-time link validation, and by the graph audit, so those three cannot drift apart again.
export const linkLookupScopes = (fromScope: string): string[] =>
  fromScope === MemoryScope.project ? [MemoryScope.project] : [fromScope, MemoryScope.project]

// The lanes a RUNNING STEP may be handed knowledge from, nearest first: its own plan scope, then
// every ancestor's (a split child executes a decomposition its PARENT authored — `plan-<child>` and
// `plan-<parent>` are different scopes), then the durable project lane.
//
// Sibling of linkLookupScopes, not the same rule: that one answers "where does this link id
// resolve" from a scope; this answers "what may this step see" from a task. Both end at `project`.
export const taskLaneScopes = (taskId: string, ancestorTaskIds: readonly string[] = []): string[] =>
  [planScope(taskId), ...ancestorTaskIds.map(planScope), MemoryScope.project]

// The memory tool surface by name — matched values, never scattered literals. Owned in
// contracts so the executor loop (which cannot import the memory plugin) matches the same
// spelling the plugin registers. tools.ts derives its registrations from this map.
export const MEMORY_TOOL_NAME = {
  write: 'memory_write', search: 'memory_search', read: 'memory_read', neighbors: 'memory_neighbors',
  topics: 'memory_topics',
  // the corpus-level drift list `orc memory recheck` computes, as a tool — a live heal sweep
  // (2026-08-03) discovered candidates via four memory_search queries and still left 8 drifted
  // notes; only the CLI could reach the authoritative list until this existed
  recheck: 'memory_recheck',
  // Not part of the role-keyed surface memoryTools() builds: it is registration-gated to the
  // auditor's verify step at the composition root, exactly like the kernel's scoped_changes.
  verify: 'memory_verify',
} as const

// memory_write's result envelope (tools.ts constructs it; the loop parses it — no casts).
export const MemoryWriteResult = z.object({ id: z.string(), warnings: z.array(z.string()).optional() })
export type MemoryWriteResult = z.infer<typeof MemoryWriteResult>

// Models pass a bare string where a one-element array is meant often enough to cost real
// iterations (a verify step lost a turn to `paths: "src/x.ts"` → zod error → retry).
// Accept the scalar as [scalar] at this boundary — a typed union, not z.preprocess, so the
// draft's input types stay precise for TS callers. Object arrays (links/sources) stay strict:
// a bare string there is a genuine shape mistake, not a spelling of the same intent.
// An explicit empty string is the model's "clear this field" spelling (see the memory_write tool
// description) — collapse it to [] rather than persisting a junk [''] entry that renders in the
// vault and survives replay. zone keeps its own min(1) item, so '' still rejects there.
const stringOrList = <T extends z.ZodType<string>>(item: T, max: number) =>
  z.union([z.array(item).max(max), item.transform(v => (v === '' ? [] : [v]))])

// What EVERY note carries, whatever tier it lives in: its address, what it is called, what it
// says, and how it connects. One literal so a core field can never drift between the tiers.
const noteCore = {
  id: Id,
  scope: z.string().regex(MEMORY_ID_RE).default(MemoryScope.project),
  // stamped by the store gateway from the runtime's Git HEAD — agents cannot invent one
  sourceRevision: z.string().nullable().default(null),
  title: z.string().min(1).max(MEMORY_LIMITS.titleChars),
  // lowercased at the boundary: search matches tags against a lowercased query while the
  // list/ls filter compares case-exactly, so an un-normalized 'Postgres' is silently
  // unreachable from one path and reachable from the other. Normalizing here also applies on
  // replay (the projector re-parses each payload), so a rebuild converges existing notes.
  tags: stringOrList(z.string().max(MEMORY_LIMITS.labelChars).toLowerCase(), MEMORY_LIMITS.labelItems).default([]),
  links: z.array(MemoryLink).max(MEMORY_LIMITS.detailItems).default([]), // clean typed graph edges — no string-id form
  summary: z.string().max(MEMORY_LIMITS.summaryChars).default(''),
  body: z.string().max(MEMORY_LIMITS.bodyChars).default(''),
  // RETIRED, but not forgotten. An archived note leaves the read model entirely — search,
  // neighbours, ranking and the vault stop seeing it — while every revision of it stays in the
  // event log, which is what makes this reversible: writing the same id with archived:false
  // restores the row from the fold. It is a plain note field rather than a new event kind so the
  // merge-on-omit write path, the projector and replay all carry it with no special case.
  //
  // Never set from age. Candidacy is decided in plugins/memory/src/archive.ts from evidence of
  // obsolescence (superseded / subject deleted / drifted-and-unhealed / task settled); a note whose
  // declared paths have not moved is still true and is never archived, however old or cold.
  archived: z.boolean().default(false),
}

// SEMANTIC — durable project knowledge. It alone owns the retrieval surface (kind/categories/
// paths/claims) and citations, because it alone makes claims another agent will act on.
export const SemanticNoteInput = z.object({
  ...noteCore,
  tier: z.literal(NOTE_TIER.semantic),
  kind: z.enum(NoteKind).default(NOTE_KIND.fact),
  // The ADR lifecycle state. Only a `decision` may carry it — the refinement on MemoryNoteInput
  // refuses it on every other kind, the same posture as "sources required only for research". No
  // default: see decisionStatusOf for why a stored default would corrupt partial updates.
  status: z.enum(DecisionStatus).optional(),
  categories: stringOrList(z.string().max(MEMORY_LIMITS.labelChars), MEMORY_LIMITS.labelItems).default([]),
  paths: stringOrList(z.string().max(MEMORY_LIMITS.detailChars), MEMORY_LIMITS.detailItems).default([]), // pointers down to code
  claims: z.array(ClaimInput).max(MEMORY_LIMITS.detailItems).default([]), // the addressable facts it asserts
  retention: z.enum(Retention).default(RETENTION.durable),                         // may this ever be swept?
  sources: z.array(MemorySourceInput).max(MEMORY_SOURCE_LIMITS.items).default([]), // provenance for a web finding
})
export type SemanticNoteInput = z.infer<typeof SemanticNoteInput>

// EPISODIC — the trail a run leaves behind (ambient step capture). Nothing beyond the core: it is
// a record of what happened, not a claim about the project. `retention` is PINNED expirable rather
// than defaulted, so the lane's sweepability is structural — no writer can mint an immortal
// step note, and the TTL sweep needs no convention to recognize one.
export const EpisodicNoteInput = z.object({
  ...noteCore,
  tier: z.literal(NOTE_TIER.episodic),
  retention: z.literal(RETENTION.expirable).default(RETENTION.expirable),
})
export type EpisodicNoteInput = z.infer<typeof EpisodicNoteInput>

// PLAN — one node of a task's decomposition. Its extra fields are execution payload, not
// knowledge: the freezer reads `zone` into the child step's write-fence, and the human reviews
// `rationale`/`uncertainty` before approving.
export const PlanNoteInput = z.object({
  ...noteCore,
  tier: z.literal(NOTE_TIER.plan),
  // A decomposition belongs to ONE task, like the episodic trail — so the lane is sweepable by
  // default rather than kept forever. Not PINNED expirable the way episodic is: a planner may
  // deliberately mark a decomposition durable. The sweep additionally waits for the owning task to
  // reach a terminal status, so an approved plan cannot vanish while it can still be retried.
  retention: z.enum(Retention).default(RETENTION.expirable),
  rationale: z.string().max(MEMORY_LIMITS.rationaleChars).default(''),          // why this subplan exists
  uncertainty: stringOrList(z.string().max(MEMORY_LIMITS.detailChars), MEMORY_LIMITS.detailItems).default([]), // coverage gaps / assumptions (RG7)
  // workspace-relative write globs this subplan may touch at execution — the freezer carries them
  // into the child step's zone and the executor's write-fence enforces them. Parallel siblings
  // declare DISJOINT zones; empty = unfenced (paths is documentation, zone is policy).
  // Sibling ids this subplan must run AFTER. A FIELD, not a link, and deliberately so: ordering is
  // execution structure with no meaning once the plan is frozen — exactly what `zone` is — while a
  // LINK is a durable statement about how facts relate. Carrying ordering as a `depends_on` link
  // overloaded one kind with two meanings (plan-authoring said "order lives in depends_on", while
  // codebase-analysis said "each area links depends_on: <area>" to mean an import), so the freeze
  // guesses which is meant from whether the target is a sibling — a heuristic that can fail if
  // the target changed status, silently un-ordering the plan.
  // Nothing traverses it either: the graph draws step ordering from the frozen step's own
  // dependsOn, so this was only ever an input to the freeze.
  dependsOn: stringOrList(z.string().min(1).max(MEMORY_LIMITS.labelChars), MEMORY_LIMITS.detailItems).default([]),
  zone: stringOrList(z.string().min(1).max(MEMORY_LIMITS.detailChars), 16).default([]),
  // capabilities this subplan needs, frozen into its step like zone is. SELECTION, not grant: a
  // ref resolves only if the operator declared the MCP server in config AND trusted it, and
  // refValidator rejects an unknown ref at propose time — before a human ever approves the plan.
  skillRefs: stringOrList(z.string().min(1).max(MEMORY_LIMITS.labelChars), 16).default([]),
  toolRefs: stringOrList(z.string().min(1).max(MEMORY_LIMITS.labelChars), 16).default([]),
  // 'provider/model' for this subplan's step; '' inherits the parent's. Decomposition is the first
  // point where model choice is knowable — a web lookup and a refactor need not share one model.
  modelRef: z.string().max(MEMORY_LIMITS.labelChars).default(''),
})
export type PlanNoteInput = z.infer<typeof PlanNoteInput>

// Classify a note whose payload predates the tier field, or whose writer left it off. Explicit
// always wins — this only fills a gap, so it can never re-label a note against its author. The
// rules read the shapes the writers actually produce, and nothing else:
//   plan     — the plan-authoring skill's notes are the only ones carrying zone/rationale/
//              uncertainty (and, before the split, kind 'plan').
//   episodic — a non-project-scope note its author marked expirable: exactly ambient capture.
//   semantic — everything else, which includes every project-scope note ever written.
const TierProbe = z.object({
  scope: z.string().optional(), kind: z.string().optional(), retention: z.string().optional(),
  rationale: z.string().optional(), zone: z.unknown().optional(), uncertainty: z.unknown().optional(),
})
// classification runs on the RAW payload, before stringOrList coerces — so a scalar 'docs/**' is
// as much a filled zone as ['docs/**'] is, and '' is empty either way (the model's clear spelling)
const filled = (v: unknown): boolean => Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v !== ''
// what plan notes were spelled as before the tier existed — the skill wrote `kind: 'plan'`
const LEGACY_PLAN_KIND = 'plan'

export function inferTier(raw: unknown): NoteTier {
  const probe = TierProbe.safeParse(raw)
  if (!probe.success) return NOTE_TIER.semantic
  const n = probe.data
  if (n.kind === LEGACY_PLAN_KIND || filled(n.zone) || filled(n.uncertainty) || (n.rationale ?? '') !== '')
    return NOTE_TIER.plan
  if (n.scope !== undefined && n.scope !== MemoryScope.project && n.retention === RETENTION.expirable)
    return NOTE_TIER.episodic
  return NOTE_TIER.semantic
}

// The tier is what discriminates the union, so it has to be present before parsing. A payload
// without one is classified from its shape — this is what lets every event written before the
// split still fold, and lets a caller write a plain semantic note without naming its lane.
const withTier = (raw: unknown): unknown => {
  if (typeof raw !== 'object' || raw === null) return raw
  if ('tier' in raw && raw.tier !== undefined) return raw
  return { ...raw, tier: inferTier(raw) }
}

// An AUTHORED note seen by a reader that does not care which tier it got: every tier's fields,
// all optional, so one code path can render or project any of them and a field the tier does not
// own simply reads as undefined. NoteView below is the same idea for a STORED note.
export interface NoteFields extends Partial<Omit<SemanticNoteInput, 'tier'> & Omit<PlanNoteInput, 'tier'>> {
  tier: NoteTier
}

export const MemoryNoteInput = z.preprocess(
  withTier,
  z.discriminatedUnion('tier', [SemanticNoteInput, EpisodicNoteInput, PlanNoteInput]),
).refine(
  n => !(n.scope === MemoryScope.project && n.id === 'index'),
  { message: "note id 'index' is reserved in the project scope (collides with vault/memory/index.md)" },
).refine(
  // the point of the kind: a research note without provenance is an unsourced claim
  n => n.tier !== NOTE_TIER.semantic || n.kind !== NOTE_KIND.research || n.sources.length > 0,
  { message: "kind 'research' requires at least one source citation" },
).refine(
  // a lifecycle state on a fact is meaningless, and a filter on it would silently return notes
  // nobody ever governed — the mirror of the research/sources rule above
  n => n.tier !== NOTE_TIER.semantic || n.status === undefined || n.kind === NOTE_KIND.decision,
  { message: "status is only valid on kind 'decision'" },
)
export type MemoryNoteInput = z.infer<typeof MemoryNoteInput>

// Validates an upsert draft AT A TOOL BOUNDARY without applying defaults — an omitted field must
// reach the store gateway as an omission (merge-on-omit carries the stored value forward), never
// as a defaulted empty. `.partial()` is NOT enough: a defaulted field still fires its default for
// a missing key. Deliberately ONE permissive shape rather than three: a partial update need not
// restate its tier, and inferring one from a fragment would silently re-lane the note. Which
// fields a tier may actually keep is enforced one layer down, when the gateway parses the merged
// note with MemoryNoteInput — cross-lane fields are dropped there, by the tier's own schema.
const optionalNoDefault = <T extends z.ZodTypeAny>(s: z.ZodDefault<T>): z.ZodOptional<T> =>
  s.removeDefault().optional()
export const MemoryNoteDraftInput = z.object({
  id: noteCore.id,
  title: noteCore.title,
  tier: z.enum(NoteTier).optional(),
  scope: optionalNoDefault(noteCore.scope),
  sourceRevision: optionalNoDefault(noteCore.sourceRevision),
  tags: optionalNoDefault(noteCore.tags),
  links: optionalNoDefault(noteCore.links),
  summary: optionalNoDefault(noteCore.summary),
  body: optionalNoDefault(noteCore.body),
  // omitted by every ordinary writer, so merge-on-omit keeps an archived note archived across an
  // unrelated update; `orc memory recheck --apply` and `restore` are what set it either way
  archived: optionalNoDefault(noteCore.archived),
  kind: optionalNoDefault(SemanticNoteInput.shape.kind),
  // reused verbatim, not wrapped: it is already optional with no default, and optionalNoDefault
  // takes a ZodDefault — passing this one would not type-check
  status: SemanticNoteInput.shape.status,
  categories: optionalNoDefault(SemanticNoteInput.shape.categories),
  paths: optionalNoDefault(SemanticNoteInput.shape.paths),
  claims: optionalNoDefault(SemanticNoteInput.shape.claims),
  // An additive INSTRUCTION, not a note field — the note parse strips it, and the store turns it
  // into the resolved `claims` above. Here so `write` and the tool boundary share one shape.
  addClaims: optionalNoDefault(ClaimWrite.shape.addClaims),
  retention: optionalNoDefault(SemanticNoteInput.shape.retention),
  sources: optionalNoDefault(SemanticNoteInput.shape.sources),
  rationale: optionalNoDefault(PlanNoteInput.shape.rationale),
  uncertainty: optionalNoDefault(PlanNoteInput.shape.uncertainty),
  dependsOn: optionalNoDefault(PlanNoteInput.shape.dependsOn),
  zone: optionalNoDefault(PlanNoteInput.shape.zone),
  skillRefs: optionalNoDefault(PlanNoteInput.shape.skillRefs),
  toolRefs: optionalNoDefault(PlanNoteInput.shape.toolRefs),
  modelRef: optionalNoDefault(PlanNoteInput.shape.modelRef),
})
// a field added to a tier but forgotten here is a compile error, not silent drift
type TierFields =
  | keyof typeof SemanticNoteInput.shape
  | keyof typeof EpisodicNoteInput.shape
  | keyof typeof PlanNoteInput.shape
type DraftCoversTiers = TierFields extends keyof typeof MemoryNoteDraftInput.shape ? true : never
const draftCoversTiers: DraftCoversTiers = true
void draftCoversTiers

// What callers hand the gateway: the draft's raw input, defaults not yet applied.
// `title` is optional on the DRAFT because write() is an upsert with merge-on-omit: an update
// inherits the stored title. A new note still needs one — the store's non-existing branch parses
// through MemoryNoteInput, which requires it, and says so. The type now matches that behaviour
// instead of demanding a field the runtime would have supplied.
export type MemoryNoteDraft = Omit<z.input<typeof MemoryNoteDraftInput>, 'title'> & { title?: string }

// The HUMAN-authorable surface of a note draft — what the web UI and quick capture may write.
// A .pick of MemoryNoteDraftInput, so every field keeps its single-source constraint. Least
// authority: only fields a human editor actually authors are exposed — `links` is here because
// the note editor writes manual connections (the vision's hand-wired synapse); `kind`/`categories`
// and the execution-plumbing fields (scope, retention, sources, paths, claims, rationale,
// uncertainty, zone, sourceRevision) stay with the agent tools and CLI flags that own them, and
// widen later only WITH a consumer. Human authoring always targets the durable project scope —
// the callee fixes it; an attacker-supplied `scope` key is stripped by the schema parse.
//
// `kind` is the next one to widen, but it must arrive WITH `sources`, not before: MemoryNoteInput
// refuses a semantic `research` note carrying no citations, so a kind picker offered without a
// sources field ships a choice whose every submission fails validation. `orc memory add --kind`
// is the door that exists today. See docs/IDEAS.md on human note authoring.
export const NoteAuthoringDraft = MemoryNoteDraftInput.pick({
  id: true, title: true, summary: true, body: true, tags: true, links: true,
})
export type NoteAuthoringDraft = z.input<typeof NoteAuthoringDraft>

// Address of one note: an id within a scope. Omitted scope means the durable project scope —
// the same defaulting MemoryStore.remove/get apply.
export const NoteRef = z.object({
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE).optional(),
})
export type NoteRef = z.infer<typeof NoteRef>

// The stored/rendered note: the tier's input shape plus the provenance the projector derives from
// events. Semantic notes also swap `sources` for the stored shape — same citations, plus the
// retrieval time the projector stamps from the event.
//
// VERIFICATION is a DECLARED act, never an inferred one. `verified` says an auditor read this note
// against the tree at `revision` and found it true — which is a different fact from "someone wrote
// it at that revision", and the only one worth trusting. Nothing derives it from authorship: it is
// set by exactly one event (memory_verified, appended by memory_verify) and a write can only carry
// it forward or destroy it (see deriveNoteProvenance).
//
// `revision` is the same HEAD the store stamps `sourceRevision` from, so drift can compare the two
// against the same tree. CEILING: a stamp taken before the work is committed is PROVISIONAL — the
// checked content is the worktree, the stamped revision is HEAD, and the two only converge once the
// commit lands. The post-commit reverify is what completes it.
export const VerifiedStamp = z.object({
  revision: z.string().min(1),
  at: z.string(),
  by: z.string(),   // composed identity, same spelling as createdBy
  // optional, not defaulted: a default splits input from output and the nested note tiers cannot carry that
  claims: z.array(VerifiedClaim).max(MEMORY_LIMITS.detailItems).optional(),
})
export type VerifiedStamp = z.infer<typeof VerifiedStamp>

const noteProvenance = {
  createdAt: z.string(),
  createdBy: z.string(),   // composed identity: "executor·model·role" or "cli"
  updatedAt: z.string(),
  updatedBy: z.string(),
  // Which checkout the note's CURRENT content was written from, off the writing author. Provenance,
  // like createdBy — not something a writer authors, which is why it is here and not on any *Input
  // shape (CONTENT_FIELDS derives from those, so this correctly never clears a verification stamp).
  //
  // It advances with `updatedBy`, not with `createdBy`: a note re-written from another worktree is
  // pending in THAT one until it merges, whatever checkout first created it. Every read surface
  // derives `provisional` from this and nothing else — and a workspace can only be known at write
  // time, so a note that lands without one is unflaggable forever and reads as trunk knowledge.
  workspaceId: z.string().min(1),
  revision: z.number().int().positive(),
  // On the SHARED provenance object, not just the semantic tier: an episodic or plan note is
  // never verified in practice, but a stamp that only some tiers could hold would need a second
  // rule at every consumer, and "absent" already says the same thing on the tiers that never get one.
  verified: VerifiedStamp.optional(),
}
export const SemanticNote = SemanticNoteInput.extend({
  ...noteProvenance,
  sources: z.array(MemorySource).max(MEMORY_SOURCE_LIMITS.items).default([]),
})
export type SemanticNote = z.infer<typeof SemanticNote>
export const EpisodicNote = EpisodicNoteInput.extend(noteProvenance)
export type EpisodicNote = z.infer<typeof EpisodicNote>
export const PlanNote = PlanNoteInput.extend(noteProvenance)
export type PlanNote = z.infer<typeof PlanNote>

export const MemoryNote = z.preprocess(
  withTier,
  z.discriminatedUnion('tier', [SemanticNote, EpisodicNote, PlanNote]),
)
export type MemoryNote = z.infer<typeof MemoryNote>

// A note as a READER may receive it: every tier's fields, all optional. This is what a budget
// fitter produces — trimming may empty `title` or drop provenance to make a response fit, so the
// result is a view OF a note, never a valid one, and typing it as MemoryNote would be a claim the
// trimmer cannot honour. Episodic is absent from the intersection deliberately: it adds no field
// beyond the core, and its literal `retention` would narrow the view's to 'expirable'.
export interface NoteView extends Partial<Omit<SemanticNote, 'tier'> & Omit<PlanNote, 'tier'>> {
  tier: NoteTier
}

// The zod twin of the fold's UseStats (activation section below): structurally identical, so a
// summary's `use` field and a fold entry pass to useVerdict() interchangeably — one derivation,
// two sources, no re-spelling.
const UseSide = z.object({ hits: z.number().int().nonnegative(), lastAccessedAt: z.string().nullable() })
export const NoteUseStats = z.object({ useful: UseSide, deadEnd: UseSide })
export type NoteUseStats = z.infer<typeof NoteUseStats>

export const NoteSummary = z.object({
  id: z.string(), scope: z.string(), title: z.string(),
  // which lane the hit came from: a reader has to be able to tell durable project knowledge from
  // one run's step trail, and `categories` is empty on both non-semantic tiers
  tier: z.enum(NoteTier),
  categories: z.array(z.string()), tags: z.array(z.string()), summary: z.string(),
  // observed use, event-sourced (see MemoryAccessedPayload) — so it survives a rebuild and is
  // real data rather than a projection-local counter that any replay silently zeroes.
  hits: z.number().int().nonnegative(),
  lastAccessedAt: z.string().nullable(),
  // The two inputs `noteHasDrifted` needs, carried on the SUMMARY and not just the full note,
  // because the summary is what retrieval hands a reader — and a reader given knowledge with no way
  // to date it against the tree in front of it has to re-derive everything to be safe. That is the
  // single most expensive thing a scout does, and it was being decided blind.
  //
  // Both, together, deliberately: with `sourceRevision` alone a reader can only ask "was this
  // written at the commit I am on", which is a different and far worse question — measured on this
  // repo, two commits touching eight files put 0 of 42 notes "at HEAD" while only 11 of 18
  // checkable ones described code that had actually moved. Whoever holds only half the inputs
  // invents the cheap comparison; drift.ts is the one that answers it correctly.
  sourceRevision: z.string().nullable(),
  paths: z.array(z.string()).max(MEMORY_LIMITS.detailItems),
  // The THIRD drift input, and the one that can clear a flag the other two raise: a note whose code
  // moved after its write but before an auditor checked it is not stale. Carried on the summary for
  // the same reason the other two are — the summary is what retrieval hands a reader, and a reader
  // who cannot see the verification re-derives knowledge that was just confirmed.
  verified: VerifiedStamp.optional(),
  // Observed-use OUTCOMES (memory_outcome events), the same shape the fold accumulates (UseStats)
  // so useVerdict() reads a summary and a fold entry identically. Optional and absent when no
  // evidence exists — the common case must not widen every envelope. Two counter pairs, never one
  // net score: contested is displayed as BOTH counts.
  use: NoteUseStats.optional(),
  // The provisional derivation's INPUT, carried on the summary for the same reason the drift inputs
  // are: the summary is what retrieval hands a reader, and the read tool that computes the flag has
  // no note row of its own to look the workspace up in.
  workspaceId: z.string(),
  // …and its RESULT, attached by the read tool. Absent when the note is trunk knowledge — the common
  // case, which must cost no tokens — the same posture `verified` and the drift flags keep.
  provisional: ProvisionalFlag.optional(),
})
export type NoteSummary = z.infer<typeof NoteSummary>

// memory_search's result envelope (tools.ts constructs it; the loop's preload parses it —
// no casts, same discipline as MemoryWriteResult).
export const MemorySearchResult = z.object({
  // Claims are the retrieval surface: a matched STATEMENT is what a reader can act on. `notes` is
  // kept alongside, not replaced — a note that asserts no claims (every episodic note, and any
  // semantic note not yet restated as claims) is still findable, and dropping it would make most of
  // an existing corpus invisible to search. Spec D3: the granularities coexist.
  claims: z.array(ClaimHit).default([]),
  notes: z.array(NoteSummary),
  truncated: z.boolean(),
  omitted: z.number().int().nonnegative(),
  next: z.string().optional(),
  note: z.string().optional(),
  // note ids among the results whose declared paths have CHANGED since the note was written — the
  // same drift check memory_read runs, lifted to the result SET so a searcher acting on a matched
  // CLAIM is warned, not only a reader who pulls the full note. Empty/absent = nothing stale.
  drifted: z.array(z.string()).optional(),
  // note ids among the results whose `sourceRevision` was UNREACHABLE — the drift check could not
  // be made at all (rebased-away or shallow-clone revision), distinct both from clean (checked,
  // unmoved) and from drifted (checked, moved). Empty/absent = nothing unknown, same discipline as
  // `drifted`.
  unknown: z.array(z.string()).optional(),
})
export type MemorySearchResult = z.infer<typeof MemorySearchResult>

// Traversal direction relative to the seed — a matched value, so it lives as a const map, never
// scattered 'out'/'in' literals. 'out' = seed →(via)→ neighbour; 'in' = neighbour →(via)→ seed.
// Disambiguates asymmetric kinds (e.g. supersedes) that reverse-traversal would otherwise flatten.
export enum EdgeDirection {
  out = 'out',
  in = 'in',
}

export const EDGE_DIRECTION = EdgeDirection

export const NeighborResult = z.object({
  id: z.string(), title: z.string(), summary: z.string(),
  via: z.enum(LinkKind), depth: z.number().int().positive(), score: z.number(),
  direction: z.enum(EdgeDirection),
  // read-time activation of this neighbor (0 = never accessed) — the score already includes
  // its boost; exposed so callers/UI can tell structure from heat
  activation: z.number().nonnegative(),
  // the best-path predecessor node id (rank.ts RankedNeighbor.from) — at depth 1 this is the
  // query seed; deeper rows name the node actually linked to this one. Optional so a row from
  // before this field existed still parses.
  from: z.string().optional(),
  // which scope this neighbour was actually found in — a traversal from a transient scope may
  // resolve a link into the durable project lane (see linkLookupScopes), and a caller that then
  // reads the note needs to know where it lives. Optional: rows predating the field still parse.
  scope: z.string().optional(),
  // the provisional pair, same rule as NoteSummary's: the workspace is the derivation's input, the
  // flag its result, and a traversal row is acted on exactly like a search row
  workspaceId: z.string(),
  provisional: ProvisionalFlag.optional(),
})
export type NeighborResult = z.infer<typeof NeighborResult>

// Every row a memory READ hands out carries the provisional pair, or neither half of it. The input
// (`workspaceId`) without the output (`provisional`) is a row the flag can never reach, and it fails
// SILENTLY: the flag is optional by design — absence means "final" — so nothing at runtime would
// report a surface that simply never sets it, and the row would read as settled project knowledge
// forever.
//
// WHAT IT ACTUALLY CATCHES, precisely: for each of the three row types NAMED below, dropping either
// half of the pair fails the build. It is a hand-kept list, like budget.ts's BoundedField and
// note-md.ts's RenderedField — a FOURTH row type added to a read reply and not added here is NOT
// caught, so extend the intersection in the same edit that gives that row its `workspaceId`.
// Keyed on `keyof`, NOT on structural assignability: `{workspaceId}` DOES extend
// `{workspaceId; provisional?}` — an optional property in the target asks nothing of the source — so
// an `extends` guard here compiles green against exactly the row it is meant to catch. (Measured:
// the first spelling of this guard passed with `provisional` deleted from NeighborResult.)
type CarriesProvisionalPair<T> = 'workspaceId' extends keyof T ? ('provisional' extends keyof T ? true : never) : never
type ReadRowsCarryProvisional =
  CarriesProvisionalPair<NoteSummary> & CarriesProvisionalPair<ClaimHit> & CarriesProvisionalPair<NeighborResult>
const readRowsCarryProvisional: ReadRowsCarryProvisional = true
void readRowsCarryProvisional

// Options for a neighbors() traversal. halfLifeDays tunes the activation boost (the store
// feeds it from config.memoryHalfLifeDays); `now` exists for deterministic tests —
// production callers omit it and get the wall clock.
export interface NeighborQuery {
  kinds?: LinkKind[]
  depth?: number
  scope?: string
  halfLifeDays?: number
  now?: string
}

// Retrieval mode. keyword = substring AND-match; semantic = vector cosine over embeddings;
// hybrid = reciprocal-rank fusion of both. The store falls back to keyword whenever no embedder
// is configured, so 'hybrid'/'semantic' are safe defaults on any deployment.
export enum SearchMode {
  keyword = 'keyword',
  semantic = 'semantic',
  hybrid = 'hybrid',
}

export const SEARCH_MODE = SearchMode

// The drift verdict, tri-state. clean = checked against the tree and unmoved (also the uncheckable
// case: no sourceRevision, or no declared paths); drifted = checked and the declared code moved;
// unknown = the sourceRevision could not be reached (rebased away, shallow clone), so no check could
// be made. Follows the SEARCH_MODE convention (TS enum + plain alias), not the plain-object
// MEMORY_HEALTH one, deliberately.
export enum DriftState {
  clean = 'clean',
  drifted = 'drifted',
  unknown = 'unknown',
}

export const DRIFT_STATE = DriftState

// `halfLifeDays` tunes the SAME activation decay NeighborQuery's does — search re-ranks cosine by
// activation heat, so a project that configured a half-life had it honoured in neighbors() and in
// the graph but not in search, the one surface a running step actually reads through.
export interface MemorySearchOpts { mode?: SearchMode; halfLifeDays?: number }

// `scope` takes a list when a caller may read across lanes (a step sees durable project knowledge
// plus its own plan scope — contracts linkLookupScopes). It must reach the QUERY, never a post-filter:
// the semantic arm ranks over the whole table and truncates, so filtering afterwards lets one busy
// project's plan notes occupy every slot and starve the knowledge the filter was asking for.
// `kind` is the retrieval handle for a CLASS of knowledge. A closed enum (not a tag) is used
// because an empty result is a real answer — if kind retrieval returned empty on a corpus with no
// notes, that's a valid "this project holds zero of that kind", whereas a tag-based query fails
// when no note carries it yet (tools.ts's unknownTagError). Semantic-tier only, like the field itself.
export interface MemoryFilter { scope?: string | string[]; category?: string; tag?: string; tier?: NoteTier; kind?: NoteKind }

// The single-writer gateway (the wrapper). write/remove append events; reads hit SurrealDB.
// write takes the raw draft — the gateway parses (defaults + validation), callers never cast.
// typed event payloads — PAYLOAD_SCHEMAS entries and the memory projector parse through
// these, so payload access never needs a cast
export const MemoryWrittenPayload = z.object({
  note: MemoryNoteInput,
  author: MemoryAuthor,
  // Claim ids this write supersedes. Stated, never inferred: the store merges on omit, so a claim
  // the writer simply did not resend must carry forward — absence cannot mean deletion.
  // The SAME shape and cap ClaimWrite.invalidates enforces, not a second spelling of it: the log
  // side used to take an unbounded array of arbitrary strings, which claimHistory then folded.
  // Nothing already in the log can fail it — every append routes through ClaimWrite first.
  invalidates: ClaimWrite.shape.invalidates,
  // the act's reason and served decision live on the event, never on the note
  why: ClaimWrite.shape.why,
  decision: ClaimWrite.shape.decision,
})
export type MemoryWrittenPayload = z.infer<typeof MemoryWrittenPayload>
export const MemoryDeletedPayload = z.object({
  // id AND scope must be MEMORY_ID_RE-safe: they flow into noteRelPath → the vault path guard,
  // so an unconstrained scope (e.g. '../x') would throw in the projector and wedge the read model.
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE),
  author: MemoryAuthor,
})
export type MemoryDeletedPayload = z.infer<typeof MemoryDeletedPayload>

// The verification ACT, as its own event — the whole point of the design. A note is verified
// because someone declared it verified, so that declaration is a fact in the log, replayable and
// attributable, rather than something a reader infers from who wrote the note and when.
// Deliberately NOT a memory_written: the act changes nothing the note SAYS, and folding it as a
// write would bump the revision, move updatedBy to the auditor and re-stamp sourceRevision — three
// lies about a step that only read.
// id AND scope carry the same MEMORY_ID_RE guard as memory_deleted, for the same reason: both
// index the read model by key.
export const MemoryVerifiedPayload = z.object({
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE),
  stamp: VerifiedStamp,
  author: MemoryAuthor,
})
export type MemoryVerifiedPayload = z.infer<typeof MemoryVerifiedPayload>

// An access is a first-class fact, not projection bookkeeping: what an agent actually pulled is
// the only evidence of which knowledge is load-bearing, and a counter written outside the log is
// erased by every rebuild. Emitted per successful pull (a miss records nothing) — id and scope
// carry the same MEMORY_ID_RE guard as memory_deleted, since both index the read model by key.
// 'read'/'neighbors' are the agent pulling; 'preload' is the executor injecting summaries into the
// first prompt. Distinct so the log can tell a delivered summary from a delivered body.
export enum MemoryAccessMode {
  read = 'read',
  neighbors = 'neighbors',
  preload = 'preload',
}

export const MEMORY_ACCESS = MemoryAccessMode

// The edge an access travelled: recorded when a memory_read follows a memory_neighbors
// discovery, so the CONNECTION that proved load-bearing can strengthen — not just the node.
// Additive + optional: old events keep parsing; accesses without provenance count node-only.
// seed is the hop-SOURCE (NeighborResult.from) — at depth 1 that is the query seed; deeper
// rows name the node actually linked to the read note, so provenance never fabricates edges.
export const AccessVia = z.object({
  seed: z.string().regex(MEMORY_ID_RE),
  kind: z.enum(LinkKind),
  direction: z.enum(EdgeDirection),
})
export type AccessVia = z.infer<typeof AccessVia>

export const MemoryAccessedPayload = z.object({
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE),
  mode: z.enum(MemoryAccessMode),
  author: MemoryAuthor,
  via: AccessVia.optional(),
})
export type MemoryAccessedPayload = z.infer<typeof MemoryAccessedPayload>

// The OUTCOME of a use: did the pulled knowledge answer the question, or waste the step. Distinct
// from memory_accessed (which only says something was pulled) and STRICTLY WEAKER than
// memory_verified: an outcome record is the agent's unverified self-assessment — evidence, never a
// verification, so it must never mint or carry a VerifiedStamp. Two values only, deliberately:
// a correction is a HEAL (memory_write to the same id) or a supersedes/contradicts link, never a
// score — the reference implementation's third `corrected` value scored −1 yet recorded positive
// provenance, and a corrected-only node dropped out of its display entirely.
export enum MemoryUseOutcome {
  useful = 'useful',
  dead_end = 'dead_end',
}

export const MEMORY_USE = MemoryUseOutcome

// One event per (note, outcome) — id and scope carry the same MEMORY_ID_RE guard as
// memory_accessed, since both index the read model by key. Attribution (which task/step reported)
// rides `author`, same as every other memory payload.
export const MemoryOutcomePayload = z.object({
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE),
  outcome: z.enum(MemoryUseOutcome),
  author: MemoryAuthor,
})
export type MemoryOutcomePayload = z.infer<typeof MemoryOutcomePayload>

// Read-model health, as three distinct states rather than one boolean. A model that is BEHIND is a
// healthy system mid-write — the projector catches up — while an UNREACHABLE store is a real fault.
// Collapsing them lit the UI's degraded badge on every burst of note writes.
// health vocabulary lives in health.ts (zero-import: the browser needs it too)
export { MEMORY_HEALTH, type MemoryHealth, type MemoryHealthState } from './health'

// the two stamps a write takes from ONE checkout: its revision, and the blob of each anchored file
export interface TreeStamps {
  revision(): Promise<string | null>
  blob(path: string): Promise<string | null>
}

export interface MemoryStore {
  // `author` is REQUIRED on every door that appends, removal and archive flags included. It used to
  // be optional on the three below, defaulted to `{source:'cli'}` inside the store — which was a
  // LIE about who wrote (a reactor is not a person at a terminal) and is now impossible anyway:
  // MemoryAuthor.workspaceId has no defensible default, so a store that invented one would file
  // knowledge under whichever checkout happened to boot the process.
  // idempotencyKey: deterministic writers (tool-driven writes inside an operation) pass one so
  // a crash retry of the surrounding effect cannot append the note event twice
  // invalidates: claim ids this write supersedes. On the OPTS, not the draft, because it is stated
  // about the write rather than about the note — it lands on the event, and the note keeps live
  // claims only. See ClaimWrite for why absence cannot mean deletion.
  // mustCreate: refuse when the log's latest event for (scope, id) is a memory_written — ARCHIVED
  // notes count, because an archived note's row is DELETED from the read model, so a caller that
  // checked only the read model (store.get) before writing would see nothing there, "recreate" the
  // title, and silently resurrect the archived note under a merge base it never asked for (measured:
  // decisions.ts's recordDecision, checking store.get for "does this id exist" before an id-is-new
  // write, missed exactly this — an archived decision's slug re-recorded as a brand-new one). A
  // memory_deleted latest does NOT refuse: a removed note is gone and may be re-created. Checked
  // inside write()'s own transaction, on the SAME latestNoteEvent read the merge base already takes,
  // so this also closes the TOCTOU two doors racing one new id would otherwise hit.
  // why/decision are stated per write, never inherited; `decision` must name a live decision note in scope
  write(input: MemoryNoteDraft, author: MemoryAuthor, opts?: { idempotencyKey?: string; invalidates?: string[]; why?: string; decision?: string; mustCreate?: boolean }): Promise<MemoryNote>
  remove(id: string, scope: string | undefined, author: MemoryAuthor): Promise<void>
  /**
   * Retire a note from the read model, or bring it back. A LIFECYCLE transition, deliberately not
   * `write({archived})`: a write re-stamps `sourceRevision` from the runtime's HEAD, so archiving a
   * DRIFTED note would silently re-date it to now — and restoring it later would read as current
   * while its text is stale, the exact false confidence the verification stamp exists to prevent.
   * This re-appends the stored note with only the flag moved, so provenance survives the round trip.
   * Absent (or already-archived) notes are a no-op, never an error: retiring twice is not a fault.
   */
  setArchived(id: string, scope: string, archived: boolean, author: MemoryAuthor): Promise<void>
  /**
   * The same transition for MANY notes, with one pass over the log. `recheck --apply` retires every
   * candidate at once, and the per-note door folded the whole knowledge log each time.
   * Ids the log never carried are skipped, not faulted — the same tolerance setArchived has.
   */
  setArchivedAll(entries: ReadonlyArray<{ id: string; scope: string }>, archived: boolean, author: MemoryAuthor): Promise<void>
  /**
   * Declare a note VERIFIED at the runtime's current HEAD — appends memory_verified and nothing
   * else, so body/summary/authorship stay byte-stable. Throws on an id the LOG has no live note
   * for (checked against the log, not the eventually-consistent read model, so a note verified in
   * the same turn it was written is not refused), and on a runtime with no readable HEAD: a stamp
   * with no revision cannot be checked against anything later, which makes it worse than none.
   * Returns the stamp it wrote, so a caller can report what it declared without a read-back race.
   */
  verify(id: string, scope: string | undefined, author: MemoryAuthor, opts?: { idempotencyKey?: string }): Promise<VerifiedStamp>
  get(id: string, scope?: string): Promise<MemoryNote | null>
  /**
   * A note's observed-use outcome stats, or null when no evidence exists. Separate from get()
   * because MemoryNote is the AUTHORED shape — hits and outcomes belong to the summary/read-model
   * side (see toNote), and widening the note would let a write path round-trip counters it must
   * never own. Display epistemics only: feed useVerdict/useLine, never rank.
   */
  useStats(id: string, scope?: string): Promise<UseStats | null>
  list(filter?: MemoryFilter): Promise<NoteSummary[]>
  search(query: string, filter?: MemoryFilter, opts?: MemorySearchOpts): Promise<NoteSummary[]>
  // Statement-level retrieval over the derived claim table, deduped so one note cannot fill every
  // slot. `limit` counts NOTES for that reason.
  searchClaims(query: string, filter?: MemoryFilter, opts?: MemorySearchOpts & ClaimSearchOptions): Promise<ClaimHit[]>
  /** A note's LIVE claims, each stamped with the event that first carried it. */
  claimsFor(noteId: string, scope?: string): Promise<Claim[]>
  neighbors(seed: string, opts?: NeighborQuery): Promise<NeighborResult[]>
  // called by the pull call sites (tools, CLI) rather than inside get(), so a traversal that
  // reads N notes internally records one access against its seed, not N against its neighbours.
  // idempotencyKey: like write(), a tool-driven access runs inside an at-least-once operation — a
  // key keeps a crash-retry from double-counting the activation signal the lifecycle is tuned on
  // (the CLI path has no retry machinery and stays keyless).
  // via: the edge a memory_neighbors row led the caller across, when this read follows one —
  // recorded into the same event so the connection can strengthen alongside the node.
  recordAccess(id: string, scope: string | undefined, mode: MemoryAccessMode, author: MemoryAuthor, opts?: { idempotencyKey?: string; via?: AccessVia }): Promise<void>
  /**
   * Record an agent's self-reported use outcomes — one memory_outcome event per entry, project
   * scope (plan-lane notes are expirable run trail, not verdict targets). Evidence, never a
   * verification, and never a write: nothing here touches the note or its stamp. Unknown ids are
   * recorded as-is — the fold keys them independently and the read model's read-then-write skips
   * them, the same tolerance recordAccess relies on. idempotencyKeyBase: keyed per (base, outcome,
   * id) so an at-least-once retry of the capturing step cannot double-count the evidence.
   */
  recordOutcomes(entries: ReadonlyArray<{ id: string; outcome: MemoryUseOutcome }>, author: MemoryAuthor, opts?: { idempotencyKeyBase?: string }): Promise<void>
  /** The derived topic inventory. A read, not a use: listing records nothing. */
  topics(): Promise<Topic[]>
  /**
   * One topic's claims. Appends a memory_topic_accessed event — fetching a topic IS the tracked
   * signal, and the log is where it is measured from. Throws on a key no current topic has.
   */
  topicClaims(topicKey: string, author: MemoryAuthor, opts?: { idempotencyKey?: string }): Promise<Claim[]>
}


// What a verification COVERS: what the note SAYS. One string, so "did this write change the note"
// is one comparison and not a field-by-field walk that a new tier field would silently escape.
//
// The field list is derived from the tier schemas' OWN shapes rather than hand-kept, because the
// failure of forgetting one is invisible: a stale "verified" would survive the very edit that
// invalidated it, and nothing would look wrong. (`DraftCoversTiers` and `FitterCoversNote` guard
// their hand-kept lists at compile time; this one needs no list to guard.)
//
// EXCLUDED, deliberately:
//  • id/scope — the address. A row and the write updating it always share it.
//  • sourceRevision — re-stamped from HEAD on EVERY write, including the commit restamp that
//    supplies no fields at all. Treating it as content would make the carry rule dead code.
//  • a citation's retrievedAt and a claim's sourceRevision — per-item provenance the projector and
//    resolveClaims stamp. The url and the claim TEXT are content; when they were fetched is not.
//  • archived — a LIFECYCLE flag, not something the note says. Counting it as content cleared the
//    verification stamp on every rewrite (the fresh note carries `false`, the stored row carries no
//    such column, so the two keys never matched), and would also mean archiving-then-restoring a
//    note destroyed an audit that is still true of text nobody touched.
//  • status — the ADR lifecycle state, not what the decision says; a supersession must not destroy
//    an audit of text nobody touched. Same trap as `archived`: superseding a decision writes only
//    `{status:'superseded'}` (decisions.ts's recordDecision), and counting `status` as content would
//    have cleared a verified stamp on every decision the moment it was retired, for a write that
//    changed no word of the ADR.
const CONTENT_FIELDS = [...new Set([
  ...Object.keys(SemanticNoteInput.shape),
  ...Object.keys(EpisodicNoteInput.shape),
  ...Object.keys(PlanNoteInput.shape),
])].filter(k => k !== 'id' && k !== 'scope' && k !== 'sourceRevision' && k !== 'archived' && k !== 'status').sort()

// The three object-array fields, re-parsed so the two sides of the comparison canonicalize: a zod
// object emits its keys in SHAPE order (a projected Surreal row's come back in storage order) and
// strips the per-item provenance above. `.nullish().transform` collapses the two spellings of
// "absent" — a note omits the key, a row that stored NONE reads it back as null.
const ContentLinks = z.array(z.object({ id: z.string(), kind: z.string(), confidence: z.number().nullish().transform(v => v ?? null) }))
const ContentSources = z.array(z.object({ url: z.string(), title: z.string().nullish().transform(v => v ?? null) }))
const ContentClaims = z.array(z.object({ id: z.string(), text: z.string() }))
const CONTENT_NORMALIZERS: Record<string, z.ZodType> = { links: ContentLinks, sources: ContentSources, claims: ContentClaims }

// `unknown` in: the two callers hold different shapes of the same thing — a freshly parsed
// MemoryNoteInput and a projected note row — and zod is what makes them comparable without a cast.
export function noteContentKey(note: unknown): string {
  const n = z.record(z.string(), z.unknown()).safeParse(note).data ?? {}
  return JSON.stringify(CONTENT_FIELDS.map(k => {
    const v = n[k]
    if (v === undefined || v === null) return null
    const normalizer = CONTENT_NORMALIZERS[k]
    // an unparseable list reads as null on BOTH sides only if it is malformed on both — otherwise
    // the keys differ and the stamp clears, which is the safe direction
    return normalizer ? normalizer.safeParse(v).data ?? null : v
  }))
}

// The ONE derivation of a stored note's event-derived fields from a memory_written event: sources
// stamped with retrievedAt (from the event ts, never the writer), provenance preserved/advanced.
// Every fold of the memory stream — the Surreal projector, the kernel plan-note fold, any future
// activation/decay derivation — MUST route through this, or they drift: a kernel fold once omitted
// the retrievedAt stamp and threw `MemoryNote.parse` on every plan note carrying a citation, wedging
// human approval. `prev` carries only what survives a re-write (createdAt/By, revision).
export function deriveNoteProvenance(
  note: MemoryNoteInput,
  author: MemoryAuthor,
  ts: string,
  prev?: { createdAt?: string; createdBy?: string; revision?: number; sources?: readonly MemorySource[]; verified?: VerifiedStamp },
): { sources?: MemorySource[]; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string; workspaceId: string; revision: number; verified?: VerifiedStamp } {
  const by = composeAuthor(author)
  // A citation's retrievedAt is when THAT url was fetched, so it survives a rewrite keyed on the
  // url — the same survivor rule claims use for validFrom. Stamping `ts` unconditionally meant any
  // later write to a research note (a links-only correction, an addClaims, an ambient refresh)
  // restamped every citation to today, and updatedAt moved with it so nothing looked wrong: a
  // five-month-old web finding read as retrieved this morning. Only a url absent from `prev` is
  // genuinely new and takes the current ts.
  const seen = new Map((prev?.sources ?? []).map(s => [s.url, s.retrievedAt]))
  return {
    // only the semantic tier cites: spreading a sources key onto the others would be a field
    // their schema does not have, silently dropped rather than honestly absent
    ...(note.tier === NOTE_TIER.semantic && { sources: note.sources.map(s => ({ ...s, retrievedAt: seen.get(s.url) ?? ts })) }),
    createdAt: prev?.createdAt ?? ts,
    createdBy: prev?.createdBy ?? by,
    updatedAt: ts,
    updatedBy: by,
    // never carried from `prev`: the workspace of the write that is landing NOW is the one the
    // note's content is pending in, and a note healed on trunk must stop reading provisional
    workspaceId: author.workspaceId,
    revision: (prev?.revision ?? 0) + 1,
    // CARRY or CLEAR — never SET. A write is not a verification, so no write path may mint a stamp;
    // this only decides whether an existing one survives. Byte-identical content keeps it (the
    // commit restamp supplies no fields and moves only sourceRevision, and destroying the auditor's
    // verification for that would make the loop re-verify what nothing changed). Any change to what
    // the note SAYS drops it: the stamp asserts an auditor read THAT text, so a heal carrying it
    // forward would report a check that never happened — the exact false confidence this exists to
    // prevent. Omitted, not undefined: an optional field set to undefined ERASES the stored column.
    ...(prev?.verified !== undefined && noteContentKey(prev) === noteContentKey(note) && { verified: prev.verified }),
  }
}

// The one-word label for a note in a human view: the CLAIM's kind when the note makes one,
// otherwise its tier. A decision reads 'decision', a subplan reads 'plan', a step note reads
// 'episodic' — one derivation, so the graph node and the backlink row cannot label it differently.
export const noteLabel = (note: NoteFields): string => note.kind ?? note.tier

export const noteKey = (scope: string, id: string): string => `${scope}\u0000${id}`

// ---- activation: the first consumer of the observed-use measurement ----
// Read-time derivation, never stored: a pure function of the event-sourced hits/lastAccessedAt
// plus the caller's clock — rebuild-safe by construction, and replay reproduces it exactly.
// Boost-only by design (banked spec correction: activation RANKS, never filters): a
// never-accessed note keeps its structural score, nothing is pruned by coldness.

// The observed-use measurement for one note, as folded from memory_accessed events.
// NoteSummary carries these same two fields, so a summary passes to activation() directly.
export interface AccessStats { hits: number; lastAccessedAt: string | null }

export const DEFAULT_HALF_LIFE_DAYS = 14
export const ACTIVATION_GAIN = 0.25

export function activation(stats: AccessStats, now: string, halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS): number {
  if (stats.hits <= 0 || !stats.lastAccessedAt) return 0
  const ageDays = (Date.parse(now) - Date.parse(stats.lastAccessedAt)) / 86_400_000
  if (!Number.isFinite(ageDays)) return 0
  return stats.hits * 0.5 ** (Math.max(0, ageDays) / halfLifeDays)
}

export const activationBoost = (a: number): number => 1 + ACTIVATION_GAIN * Math.log1p(a)

export const edgeKey = (scope: string, from: string, to: string, kind: LinkKind): string =>
  [scope, from, to, kind].join(' ')

// The ONE increment rule. The Surreal projector materializes the same counters incrementally into
// its own columns, so it applies this too — otherwise the read model's ranking and a fold of the
// log can drift apart on a rule nobody notices is written twice. A bump always HAS a timestamp,
// so the result narrows to a non-null one (the projector's columns are `option`, not nullable).
export const bumpAccess = (prev: { hits?: number | null } | undefined, ts: string): { hits: number; lastAccessedAt: string } =>
  ({ hits: (prev?.hits ?? 0) + 1, lastAccessedAt: ts })

// The authored edge an access's `via` provenance names. CANONICAL: both traversal directions of one
// edge resolve to the same (from, to) pair — omitting direction from the key does NOT unify them.
// Used by the log fold and by the Surreal projector, so the two cannot key one edge differently.
export const viaEdge = (p: MemoryAccessedPayload): { scope: string; from: string; to: string; kind: LinkKind } | null => {
  if (!p.via) return null
  const out = p.via.direction === EDGE_DIRECTION.out
  return { scope: p.scope, from: out ? p.via.seed : p.id, to: out ? p.id : p.via.seed, kind: p.via.kind }
}

const viaEdgeKey = (p: MemoryAccessedPayload): string | null => {
  const e = viaEdge(p)
  return e && edgeKey(e.scope, e.from, e.to, e.kind)
}

// What the fold holds per note: the write's payload, plus the verification a later memory_verified
// attached to it. `verified` sits OUTSIDE MemoryNoteInput deliberately — no write path may mint a
// stamp (deriveNoteProvenance's CARRY-or-CLEAR rule), and MemoryNoteInput strips it from any draft
// that tries, so it can only ever arrive here from the verify event itself.
export interface FoldedWrite extends Omit<MemoryWrittenPayload, 'note'> {
  note: MemoryWrittenPayload['note'] & { verified?: VerifiedStamp }
}

// Per-note use OUTCOMES, folded from memory_outcome events. Two separate AccessStats, never one
// signed score: contested is displayed as BOTH counts, and a net average is exactly the shape the
// pinned design refuses (a −1 that erases a +1 hides the disagreement a reader needs to see).
export interface UseStats { useful: AccessStats; deadEnd: AccessStats }
export const emptyUseStats = (): UseStats =>
  ({ useful: { hits: 0, lastAccessedAt: null }, deadEnd: { hits: 0, lastAccessedAt: null } })

// ---- use verdicts: DISPLAY EPISTEMICS ONLY, never a rank.ts input ----
// The use→rank channel is already occupied by the bounded activation boost above; letting verdicts
// rank too builds the loop nobody has propensity-corrected — returned → used → marked useful →
// ranked higher → returned. Verdicts surface beside a note (envelope lines, the Currency slot),
// exactly like the drifted flag: the reader weighs them, the ranker never sees them.

// One record is an anecdote; ≥2 is corroboration. Counts are raw event counts, not decayed:
// staleness of the evidence enters through retirement (which reads the lastAt timestamps via
// activation), not by silently un-preferring a note — a verdict that fades with no event to
// explain it would be the drift-with-no-cause problem all over again.
export const MIN_CORROBORATION = 2

export enum UseVerdict {
  preferred = 'preferred',
  tentative = 'tentative',
  contested = 'contested',
}

export const USE_VERDICT = UseVerdict

// Contested FIRST and unconditional: corroboration never outvotes a dead-end report — hiding the
// disagreement behind a majority is the net-score shape in different clothes. Dead-end-only yields
// NO verdict (a status would read as settled; the counts still show via useLine and feed
// retirement's used-but-useless evidence).
export function useVerdict(u: UseStats): UseVerdict | null {
  if (u.useful.hits > 0 && u.deadEnd.hits > 0) return USE_VERDICT.contested
  if (u.useful.hits >= MIN_CORROBORATION) return USE_VERDICT.preferred
  if (u.useful.hits === 1) return USE_VERDICT.tentative
  return null
}

// The ONE spelling of the verdict for a human/agent-facing line — envelope, CLI and web derive
// from here so they cannot phrase the same evidence differently. Null = no line (no evidence).
export function useLine(u: UseStats): string | null {
  const v = useVerdict(u)
  if (v === USE_VERDICT.contested) return `contested (useful ${u.useful.hits} / dead-end ${u.deadEnd.hits})`
  if (v === USE_VERDICT.preferred) return `preferred (${u.useful.hits} useful)`
  if (v === USE_VERDICT.tentative) return `tentative (1 useful)`
  return u.deadEnd.hits > 0 ? `dead-end reported (${u.deadEnd.hits})` : null
}

export interface MemoryFold {
  notes: Map<string, FoldedWrite>
  writes: Map<string, string>   // last write time per note
  access: Map<string, AccessStats>
  edges: Map<string, AccessStats>
  outcomes: Map<string, UseStats>
}

export const emptyMemoryFold = (): MemoryFold =>
  ({ notes: new Map(), writes: new Map(), access: new Map(), edges: new Map(), outcomes: new Map() })

// `ts` is optional so trimmed {kind, payload} fixtures keep working — a tsless event contributes no
// timing (activation without a timestamp is undefined anyway).
export type MemoryEvent = Pick<EventRecord, 'kind' | 'payload'> & { ts?: string }

// ---- the mutation algebra: ONE decode, two applies ----
// The log has two interpreters — foldMemoryInto below and the Surreal projector's applyEvent —
// and each used to decode the four knowledge kinds independently, so every kind was implemented
// twice with nothing enforcing agreement. They diverged once: the fold dropped memory_verified
// entirely, discarding 14 verification events, and `orc memory recheck` reported 30 drifted where
// health reported 29 on the same corpus at the same instant. decodeMemoryEvent is now the single
// decode — parse the payload, name what changed — and only the APPLY differs per side (a Map vs a
// Surreal transaction). Both appliers switch exhaustively with a `never` default (the
// DraftCoversTiers shape applied to the event stream), so a mutation one side forgets to handle is
// a compile error, not a silent drop.
export enum MutationOp {
  upsert = 'upsert',
  archive = 'archive',
  delete = 'delete',
  verify = 'verify',
  access = 'access',
  outcome = 'outcome',
  skip = 'skip',
}

export type MemoryMutation =
  | { op: MutationOp.upsert; payload: MemoryWrittenPayload; at?: string }
  // a memory_written carrying archived: true. Split from upsert so the ONE decode owns the
  // distinction: the fold keeps the note with its flag readable (restore and every "is this
  // live" filter depend on it), while the read model deletes the rows outright.
  | { op: MutationOp.archive; payload: MemoryWrittenPayload; at?: string }
  | { op: MutationOp.delete; payload: MemoryDeletedPayload }
  | { op: MutationOp.verify; payload: MemoryVerifiedPayload }
  | { op: MutationOp.access; payload: MemoryAccessedPayload; at?: string }
  | { op: MutationOp.outcome; payload: MemoryOutcomePayload; at?: string }
  // a knowledge kind whose payload does not parse — costs that one event, never the stream.
  // Carries the zod message so the projector's warn line still says what was wrong.
  | { op: MutationOp.skip; reason: string }

// Pure, and returns null for a kind that is not a knowledge event at all (both appliers pass it
// through untouched — the projector still advances its cursor past one).
export function decodeMemoryEvent(e: MemoryEvent): MemoryMutation | null {
  const at = e.ts !== undefined ? { at: e.ts } : {}
  if (e.kind === EVENT_KIND.memory_written) {
    const p = MemoryWrittenPayload.safeParse(e.payload)
    if (!p.success) return { op: MutationOp.skip, reason: p.error.message }
    return { op: p.data.note.archived ? MutationOp.archive : MutationOp.upsert, payload: p.data, ...at }
  }
  if (e.kind === EVENT_KIND.memory_verified) {
    const p = MemoryVerifiedPayload.safeParse(e.payload)
    return p.success ? { op: MutationOp.verify, payload: p.data } : { op: MutationOp.skip, reason: p.error.message }
  }
  if (e.kind === EVENT_KIND.memory_deleted) {
    const p = MemoryDeletedPayload.safeParse(e.payload)
    return p.success ? { op: MutationOp.delete, payload: p.data } : { op: MutationOp.skip, reason: p.error.message }
  }
  if (e.kind === EVENT_KIND.memory_accessed) {
    const p = MemoryAccessedPayload.safeParse(e.payload)
    return p.success ? { op: MutationOp.access, payload: p.data, ...at } : { op: MutationOp.skip, reason: p.error.message }
  }
  if (e.kind === EVENT_KIND.memory_outcome) {
    const p = MemoryOutcomePayload.safeParse(e.payload)
    return p.success ? { op: MutationOp.outcome, payload: p.data, ...at } : { op: MutationOp.skip, reason: p.error.message }
  }
  return null
}

// Mutates and returns `acc`, so a long-lived reader (the UI session cache) can advance one event at
// a time instead of re-walking history. Same shape as projections' foldInto.
export function foldMemoryInto(acc: MemoryFold, e: MemoryEvent): MemoryFold {
  const m = decodeMemoryEvent(e)
  if (m === null) return acc
  switch (m.op) {
    // an archive applies here exactly as a write: the note STAYS in the map carrying
    // archived: true — the fold is what restore reads the flag back off
    case MutationOp.upsert:
    case MutationOp.archive: {
      const { note } = m.payload
      const k = noteKey(note.scope, note.id)
      // CARRY or CLEAR — the same rule deriveNoteProvenance applies on the read-model side, keyed on
      // the same content hash so the two cannot answer differently. A contentless rewrite (the commit
      // restamp supplies no fields and moves only sourceRevision) keeps the auditor's check; any edit
      // to what the note SAYS drops it, because the stamp asserts someone read THAT text.
      const prior = acc.notes.get(k)?.note
      const carried = prior?.verified !== undefined && noteContentKey(prior) === noteContentKey(note)
        ? { verified: prior.verified }
        : {}
      acc.notes.set(k, { ...m.payload, note: { ...note, ...carried } })
      if (m.at !== undefined) acc.writes.set(k, m.at)
      return acc
    }
    case MutationOp.verify: {
      const k = noteKey(m.payload.scope, m.payload.id)
      const held = acc.notes.get(k)
      // a verification of a note nothing ever wrote is not a note — never materialize one from it
      if (!held) return acc
      // `writes` is deliberately untouched: a verification is not a write. Stamping it would bump the
      // note's last-write time and hand every activation/staleness reader a lie about a step that
      // only read — the same three lies MemoryVerifiedPayload's comment refuses for revision/author.
      acc.notes.set(k, { ...held, note: { ...held.note, verified: m.payload.stamp } })
      return acc
    }
    case MutationOp.delete: {
      const k = noteKey(m.payload.scope, m.payload.id)
      acc.notes.delete(k)
      acc.writes.delete(k)
      return acc
    }
    case MutationOp.access: {
      if (m.at === undefined) return acc // a tsless fixture access contributes no timing
      const k = noteKey(m.payload.scope, m.payload.id)
      acc.access.set(k, bumpAccess(acc.access.get(k), m.at))
      const ek = viaEdgeKey(m.payload)
      if (ek) acc.edges.set(ek, bumpAccess(acc.edges.get(ek), m.at))
      return acc
    }
    case MutationOp.outcome: {
      // undated evidence gets ZERO weight, never full: the reference implementation weighted an
      // unparseable-date record 1.0 forever, letting one malformed row outrank every real signal
      if (m.at === undefined) return acc
      const k = noteKey(m.payload.scope, m.payload.id)
      const prev = acc.outcomes.get(k) ?? emptyUseStats()
      acc.outcomes.set(k, m.payload.outcome === MEMORY_USE.useful
        ? { ...prev, useful: bumpAccess(prev.useful, m.at) }
        : { ...prev, deadEnd: bumpAccess(prev.deadEnd, m.at) })
      return acc
    }
    case MutationOp.skip:
      return acc
    default: {
      const unhandled: never = m
      void unhandled
      return acc
    }
  }
}

// Every derivation over the memory stream, in ONE walk.
export const foldMemory = (events: MemoryEvent[]): MemoryFold =>
  events.reduce(foldMemoryInto, emptyMemoryFold())
