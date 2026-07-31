import { z } from 'zod'
import { Claim, ClaimHit, ClaimInput, ClaimWrite, type ClaimSearchOptions } from './claim'
import { Topic } from './cluster'
import { EVENT_KIND, type EventRecord } from './event-kinds'
import { composeAuthor, MEMORY_ID_RE, MemoryAuthor } from './ids'
import { MEMORY_LIMITS } from './limits'
import { planScope } from './plan'

// re-exported so every memory consumer keeps importing this vocabulary from one place
export { MEMORY_ID_RE, slugId, MemoryAuthor, composeAuthor } from './ids'
export * from './claim'

const Id = z.string().regex(MEMORY_ID_RE).max(128)


export const LINK_KINDS = [
  'refines', 'supersedes', 'contradicts', 'depends_on',
  'example_of', 'derived_from', 'relates_to', 'decomposes_into',
] as const
export const LinkKind = z.enum(LINK_KINDS)
export type LinkKind = z.infer<typeof LinkKind>
export const LINK_KIND = LinkKind.enum

export const MemoryLink = z.object({
  id: Id,
  kind: LinkKind.default('relates_to'), // fills a missing key on a typed link; NOT a string-coercion
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
      const kind = sep === -1 ? undefined : entry.slice(0, sep).trim()
      const id = (sep === -1 ? entry : entry.slice(sep + 1)).trim()
      if (kind !== undefined && !(LINK_KINDS as readonly string[]).includes(kind))
        throw new Error(`unknown link kind '${kind}' in '${entry}' — valid: ${LINK_KINDS.join(', ')}`)
      if (!MEMORY_ID_RE.test(id))
        throw new Error(`'${id}' is not a valid note id (lowercase letters/digits/dashes)`)
      // the includes-check above guarantees this parse cannot throw (boundary-parse, never cast)
      return kind === undefined ? { id } : { id, kind: LinkKind.parse(kind) }
    })
}

// Inverse, for pre-filling the edit dialog: 'supersedes:old-note, relates_to:other'.
export const formatLinkSpec = (links: ReadonlyArray<{ id: string; kind: string }>): string =>
  links.map(l => `${l.kind}:${l.id}`).join(', ')

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
export const RETENTION_CLASSES = ['durable', 'expirable'] as const
export const Retention = z.enum(RETENTION_CLASSES)
export type Retention = z.infer<typeof Retention>
export const RETENTION = Retention.enum

// knowledge lifecycle: current/target architecture stay distinguishable and queryable.
// `research` is a distilled web finding — it is the one kind that MUST carry a citation.
// A kind classifies a CLAIM, so it belongs to the semantic tier alone: 'plan' is not a kind of
// claim, it is a different memory system, and it lives in NOTE_TIERS below.
export const NOTE_KINDS = ['fact', 'decision', 'architecture_current', 'architecture_target', 'documentation', 'research'] as const
export const NoteKind = z.enum(NOTE_KINDS)
export type NoteKind = z.infer<typeof NoteKind>
export const NOTE_KIND = NoteKind.enum

// The retrieval-surface vocabulary for `categories` (SemanticNoteInput.categories, below): a
// FIXED three-value set, unlike `tags`, which is deliberately open and corpus-derived (see
// tools.ts's memory_search — it validates `tag` against what the corpus actually carries, never
// against an invented list here). noteLint's own advisory message and the codebase-analysis
// skill already state these three in prose; this is the one real exported enum for them, matched
// values rather than a hand-rolled literal array wherever a category is validated (memory_search's
// `category` filter, same discipline as NOTE_TIER/NOTE_TIERS above and packages/cli/src/main.ts's
// parseNoteTier).
export const NOTE_CATEGORIES = ['subsystem', 'cross-cutting', 'target'] as const
export const NoteCategory = z.enum(NOTE_CATEGORIES)
export type NoteCategory = z.infer<typeof NoteCategory>
export const NOTE_CATEGORY = NoteCategory.enum

// Every agent-memory system worth copying separates a cheap, lossless EPISODIC trail from a
// distilled, linked SEMANTIC tier. orc adds a third, PLAN, because a decomposition is neither: it
// is executable structure a human approves and the freezer turns into steps.
//   semantic — durable project knowledge: a claim plus its retrieval surface. The default.
//   episodic — the per-task trail a run leaves behind. Expirable by construction, swept by TTL.
//   plan     — one node of a task's decomposition: requirements, rationale, write-fence, deps.
// The tier decides which FIELDS a note may carry, so the lanes are separated structurally rather
// than by a soft rank penalty: a step note cannot grow claims[], and a claim cannot smuggle a zone.
export const NOTE_TIERS = ['semantic', 'episodic', 'plan'] as const
export const NoteTier = z.enum(NOTE_TIERS)
export type NoteTier = z.infer<typeof NoteTier>
export const NOTE_TIER = NoteTier.enum

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
  // Not part of the role-keyed surface memoryTools() builds: it is registration-gated to the
  // auditor's verify step at the composition root, exactly like the kernel's scoped_changes.
  verify: 'memory_verify',
} as const

// memory_write's result envelope (tools.ts constructs it; the loop parses it — no casts).
export const MemoryWriteResult = z.object({ id: z.string(), warnings: z.array(z.string()).optional() })
export type MemoryWriteResult = z.infer<typeof MemoryWriteResult>

// Models pass a bare string where a one-element array is meant often enough to cost real
// iterations (a scenario-2 verify step lost a turn to `paths: "src/x.ts"` → zod error → retry).
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
}

// SEMANTIC — durable project knowledge. It alone owns the retrieval surface (kind/categories/
// paths/claims) and citations, because it alone makes claims another agent will act on.
export const SemanticNoteInput = z.object({
  ...noteCore,
  tier: z.literal(NOTE_TIER.semantic),
  kind: NoteKind.default(NOTE_KIND.fact),
  categories: stringOrList(z.string().max(MEMORY_LIMITS.labelChars), MEMORY_LIMITS.labelItems).default([]),
  paths: stringOrList(z.string().max(MEMORY_LIMITS.detailChars), MEMORY_LIMITS.detailItems).default([]), // pointers down to code
  claims: z.array(ClaimInput).max(MEMORY_LIMITS.detailItems).default([]), // the addressable facts it asserts
  retention: Retention.default(RETENTION.durable),                                 // may this ever be swept?
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
  retention: Retention.default(RETENTION.expirable),
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
  // had to GUESS which was meant from whether the target happened to be a sibling — and guessed
  // wrong for a target that used to be one, silently un-ordering the plan.
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
  tier: NoteTier.optional(),
  scope: optionalNoDefault(noteCore.scope),
  sourceRevision: optionalNoDefault(noteCore.sourceRevision),
  tags: optionalNoDefault(noteCore.tags),
  links: optionalNoDefault(noteCore.links),
  summary: optionalNoDefault(noteCore.summary),
  body: optionalNoDefault(noteCore.body),
  kind: optionalNoDefault(SemanticNoteInput.shape.kind),
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
})
export type VerifiedStamp = z.infer<typeof VerifiedStamp>

const noteProvenance = {
  createdAt: z.string(),
  createdBy: z.string(),   // composed identity: "executor·model·role" or "cli"
  updatedAt: z.string(),
  updatedBy: z.string(),
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

export const NoteSummary = z.object({
  id: z.string(), scope: z.string(), title: z.string(),
  // which lane the hit came from: a reader has to be able to tell durable project knowledge from
  // one run's step trail, and `categories` is empty on both non-semantic tiers
  tier: NoteTier,
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
})
export type NoteSummary = z.infer<typeof NoteSummary>

// memory_search's result envelope (tools.ts constructs it; the loop's Task 7 preload parses it —
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
})
export type MemorySearchResult = z.infer<typeof MemorySearchResult>

// Traversal direction relative to the seed — a matched value, so it lives as a const map, never
// scattered 'out'/'in' literals. 'out' = seed →(via)→ neighbour; 'in' = neighbour →(via)→ seed.
// Disambiguates asymmetric kinds (e.g. supersedes) that reverse-traversal would otherwise flatten.
export const EDGE_DIRECTIONS = ['out', 'in'] as const
export const EdgeDirection = z.enum(EDGE_DIRECTIONS)
export type EdgeDirection = z.infer<typeof EdgeDirection>
export const EDGE_DIRECTION = EdgeDirection.enum

export const NeighborResult = z.object({
  id: z.string(), title: z.string(), summary: z.string(),
  via: LinkKind, depth: z.number().int().positive(), score: z.number(),
  direction: EdgeDirection,
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
})
export type NeighborResult = z.infer<typeof NeighborResult>

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
export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const
export const SearchMode = z.enum(SEARCH_MODES)
export type SearchMode = z.infer<typeof SearchMode>
export const SEARCH_MODE = SearchMode.enum

// `halfLifeDays` tunes the SAME activation decay NeighborQuery's does — search re-ranks cosine by
// activation heat, so a project that configured a half-life had it honoured in neighbors() and in
// the graph but not in search, the one surface a running step actually reads through.
export interface MemorySearchOpts { mode?: SearchMode; halfLifeDays?: number }

// `scope` takes a list when a caller may read across lanes (a step sees durable project knowledge
// plus its own plan scope — contracts linkLookupScopes). It must reach the QUERY, never a post-filter:
// the semantic arm ranks over the whole table and truncates, so filtering afterwards lets one busy
// project's plan notes occupy every slot and starve the knowledge the filter was asking for.
export interface MemoryFilter { scope?: string | string[]; category?: string; tag?: string; tier?: NoteTier }

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
export const MEMORY_ACCESS_MODES = ['read', 'neighbors', 'preload'] as const
export const MemoryAccessMode = z.enum(MEMORY_ACCESS_MODES)
export type MemoryAccessMode = z.infer<typeof MemoryAccessMode>
export const MEMORY_ACCESS = MemoryAccessMode.enum

// The edge an access travelled: recorded when a memory_read follows a memory_neighbors
// discovery, so the CONNECTION that proved load-bearing can strengthen — not just the node.
// Additive + optional: old events keep parsing; accesses without provenance count node-only.
// seed is the hop-SOURCE (NeighborResult.from) — at depth 1 that is the query seed; deeper
// rows name the node actually linked to the read note, so provenance never fabricates edges.
export const AccessVia = z.object({
  seed: z.string().regex(MEMORY_ID_RE),
  kind: LinkKind,
  direction: EdgeDirection,
})
export type AccessVia = z.infer<typeof AccessVia>

export const MemoryAccessedPayload = z.object({
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE),
  mode: MemoryAccessMode,
  author: MemoryAuthor,
  via: AccessVia.optional(),
})
export type MemoryAccessedPayload = z.infer<typeof MemoryAccessedPayload>

// Read-model health, as three distinct states rather than one boolean. A model that is BEHIND is a
// healthy system mid-write — the projector catches up — while an UNREACHABLE store is a real fault.
// Collapsing them lit the UI's degraded badge on every burst of note writes.
export const MEMORY_HEALTH = { ok: 'ok', catchingUp: 'catching_up', unreachable: 'unreachable' } as const
export type MemoryHealthState = (typeof MEMORY_HEALTH)[keyof typeof MEMORY_HEALTH]

export interface MemoryHealth {
  state: MemoryHealthState
  pending: number // knowledge events not yet applied to the read model
  reason?: string
  // How far the graph has fallen behind the working tree. `pending` measures the read model
  // catching up with the LOG — a lag orc creates and fixes by itself. This measures the corpus
  // catching up with the CODE, which orc cannot fix by itself: when the repo moves without going
  // through orc (another editor, a merge, a refactor landed elsewhere) nothing retires the claims
  // that describe what used to be there. Absent when it could not be measured (no repo, no
  // checkable notes) — never a fabricated zero, which would read as "healthy".
  drift?: { checkable: number; drifted: number; ratio: number }
}

export interface MemoryStore {
  // idempotencyKey: deterministic writers (tool-driven writes inside an operation) pass one so
  // a crash retry of the surrounding effect cannot append the note event twice
  // invalidates: claim ids this write supersedes. On the OPTS, not the draft, because it is stated
  // about the write rather than about the note — it lands on the event, and the note keeps live
  // claims only. See ClaimWrite for why absence cannot mean deletion.
  write(input: MemoryNoteDraft, author: MemoryAuthor, opts?: { idempotencyKey?: string; invalidates?: string[] }): Promise<MemoryNote>
  remove(id: string, scope?: string, author?: MemoryAuthor): Promise<void>
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
const CONTENT_FIELDS = [...new Set([
  ...Object.keys(SemanticNoteInput.shape),
  ...Object.keys(EpisodicNoteInput.shape),
  ...Object.keys(PlanNoteInput.shape),
])].filter(k => k !== 'id' && k !== 'scope' && k !== 'sourceRevision').sort()

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
): { sources?: MemorySource[]; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string; revision: number; verified?: VerifiedStamp } {
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

export interface MemoryFold {
  notes: Map<string, MemoryWrittenPayload>
  writes: Map<string, string>   // last write time per note
  access: Map<string, AccessStats>
  edges: Map<string, AccessStats>
}

export const emptyMemoryFold = (): MemoryFold =>
  ({ notes: new Map(), writes: new Map(), access: new Map(), edges: new Map() })

// `ts` is optional so trimmed {kind, payload} fixtures keep working — a tsless event contributes no
// timing (activation without a timestamp is undefined anyway).
type MemoryEvent = Pick<EventRecord, 'kind' | 'payload'> & { ts?: string }

// Mutates and returns `acc`, so a long-lived reader (the UI session cache) can advance one event at
// a time instead of re-walking history. Same shape as projections' foldInto.
export function foldMemoryInto(acc: MemoryFold, e: MemoryEvent): MemoryFold {
  if (e.kind === EVENT_KIND.memory_written) {
    const p = MemoryWrittenPayload.safeParse(e.payload)
    if (!p.success) return acc
    const k = noteKey(p.data.note.scope, p.data.note.id)
    acc.notes.set(k, p.data)
    if (e.ts) acc.writes.set(k, e.ts)
  } else if (e.kind === EVENT_KIND.memory_deleted) {
    const p = MemoryDeletedPayload.safeParse(e.payload)
    if (!p.success) return acc
    const k = noteKey(p.data.scope, p.data.id)
    acc.notes.delete(k)
    acc.writes.delete(k)
  } else if (e.kind === EVENT_KIND.memory_accessed && e.ts) {
    const p = MemoryAccessedPayload.safeParse(e.payload)
    if (!p.success) return acc
    const k = noteKey(p.data.scope, p.data.id)
    acc.access.set(k, bumpAccess(acc.access.get(k), e.ts))
    const ek = viaEdgeKey(p.data)
    if (ek) acc.edges.set(ek, bumpAccess(acc.edges.get(ek), e.ts))
  }
  return acc
}

// Every derivation over the memory stream, in ONE walk.
export const foldMemory = (events: MemoryEvent[]): MemoryFold =>
  events.reduce(foldMemoryInto, emptyMemoryFold())
