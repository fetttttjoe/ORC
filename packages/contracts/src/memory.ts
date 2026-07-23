import { z } from 'zod'
// safe cycle with ./events (which imports our payload schemas): EVENT_KIND is only read
// inside function bodies, long after both modules initialized
import { EVENT_KIND, type EventRecord } from './events'

export const MEMORY_ID_RE = /^[a-z0-9][a-z0-9-]*$/
export const MEMORY_LIMITS = {
  labelItems: 50,
  labelChars: 64,
  detailItems: 100,
  detailChars: 1_000,
  bodyChars: 100_000,
  rationaleChars: 20_000,
} as const

const Id = z.string().regex(MEMORY_ID_RE).max(128)

export const MemoryAuthor = z.object({
  source: z.enum(['agent', 'cli']),
  taskId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  runToken: z.string().nullable().optional(),
  executor: z.string().optional(),
  model: z.string().optional(),
  role: z.string().optional(),
})
export type MemoryAuthor = z.infer<typeof MemoryAuthor>

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
export const NOTE_KINDS = ['fact', 'decision', 'architecture_current', 'architecture_target', 'documentation', 'plan', 'research'] as const
export const NoteKind = z.enum(NOTE_KINDS)
export type NoteKind = z.infer<typeof NoteKind>
export const NOTE_KIND = NoteKind.enum

// The scope families of a memory note — matched values, never scattered literals (same rule
// as STRATEGY in plan.ts). `project` is the one durable knowledge scope; per-task transient
// plan scopes are derived by planScope(taskId) in plan.ts.
export enum MemoryScope { project = 'project' }

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

// What a writer (agent/CLI) supplies. Arrays/strings default so a minimal note is one id+title.
const MemoryNoteBase = z.object({
  id: Id,
  scope: z.string().regex(MEMORY_ID_RE).default(MemoryScope.project),
  kind: NoteKind.default('fact'),
  // stamped by the store gateway from the runtime's Git HEAD — agents cannot invent one
  sourceRevision: z.string().nullable().default(null),
  title: z.string().min(1).max(200),
  categories: stringOrList(z.string().max(MEMORY_LIMITS.labelChars), MEMORY_LIMITS.labelItems).default([]),
  // lowercased at the boundary: search matches tags against a lowercased query while the
  // list/ls filter compares case-exactly, so an un-normalized 'Postgres' is silently
  // unreachable from one path and reachable from the other. Normalizing here also applies on
  // replay (the projector re-parses each payload), so a rebuild converges existing notes.
  tags: stringOrList(z.string().max(MEMORY_LIMITS.labelChars).toLowerCase(), MEMORY_LIMITS.labelItems).default([]),
  links: z.array(MemoryLink).max(MEMORY_LIMITS.detailItems).default([]), // clean typed graph edges — no string-id form
  paths: stringOrList(z.string().max(MEMORY_LIMITS.detailChars), MEMORY_LIMITS.detailItems).default([]), // pointers down to code
  rules: stringOrList(z.string().max(MEMORY_LIMITS.detailChars), MEMORY_LIMITS.detailItems).default([]), // normative statements agents honor
  summary: z.string().max(500).default(''),
  body: z.string().max(MEMORY_LIMITS.bodyChars).default(''),
  retention: Retention.default(RETENTION.durable),                                 // may this ever be swept?
  sources: z.array(MemorySourceInput).max(MEMORY_SOURCE_LIMITS.items).default([]), // provenance for a web finding
  rationale: z.string().max(MEMORY_LIMITS.rationaleChars).default(''),          // plan-note: why this subplan exists
  uncertainty: stringOrList(z.string().max(MEMORY_LIMITS.detailChars), MEMORY_LIMITS.detailItems).default([]), // plan-note: coverage gaps / assumptions (RG7)
  // plan-note: workspace-relative write globs this subplan may touch at execution — the freezer
  // carries them into the child step's zone and the executor's write-fence enforces them.
  // Parallel siblings declare DISJOINT zones; empty = unfenced (paths is documentation, zone is policy).
  zone: stringOrList(z.string().min(1).max(MEMORY_LIMITS.detailChars), 16).default([]),
})
export const MemoryNoteInput = MemoryNoteBase.refine(
  n => !(n.scope === MemoryScope.project && n.id === 'index'),
  { message: "note id 'index' is reserved in the project scope (collides with vault/memory/index.md)" },
).refine(
  // the point of the kind: a research note without provenance is an unsourced claim
  n => n.kind !== NOTE_KIND.research || n.sources.length > 0,
  { message: "kind 'research' requires at least one source citation" },
)
export type MemoryNoteInput = z.infer<typeof MemoryNoteInput>
// What callers hand the gateway: the schema's raw input, defaults not yet applied.
export type MemoryNoteDraft = z.input<typeof MemoryNoteInput>

// Validates an upsert draft AT A TOOL BOUNDARY without applying defaults — an omitted field must
// reach the store gateway as an omission (merge-on-omit carries the stored value forward), never
// as a defaulted empty. `.partial()` is NOT enough: a defaulted field still fires its default for
// a missing key. Each optional field references the base shape so constraints stay single-source;
// the gateway parses the merged note with MemoryNoteInput afterwards (refinements included).
const optionalNoDefault = <T extends z.ZodTypeAny>(s: z.ZodDefault<T>): z.ZodOptional<T> =>
  s.removeDefault().optional()
export const MemoryNoteDraftInput = z.object({
  id: MemoryNoteBase.shape.id,
  title: MemoryNoteBase.shape.title,
  scope: optionalNoDefault(MemoryNoteBase.shape.scope),
  kind: optionalNoDefault(MemoryNoteBase.shape.kind),
  sourceRevision: optionalNoDefault(MemoryNoteBase.shape.sourceRevision),
  categories: optionalNoDefault(MemoryNoteBase.shape.categories),
  tags: optionalNoDefault(MemoryNoteBase.shape.tags),
  links: optionalNoDefault(MemoryNoteBase.shape.links),
  paths: optionalNoDefault(MemoryNoteBase.shape.paths),
  rules: optionalNoDefault(MemoryNoteBase.shape.rules),
  summary: optionalNoDefault(MemoryNoteBase.shape.summary),
  body: optionalNoDefault(MemoryNoteBase.shape.body),
  retention: optionalNoDefault(MemoryNoteBase.shape.retention),
  sources: optionalNoDefault(MemoryNoteBase.shape.sources),
  rationale: optionalNoDefault(MemoryNoteBase.shape.rationale),
  uncertainty: optionalNoDefault(MemoryNoteBase.shape.uncertainty),
  zone: optionalNoDefault(MemoryNoteBase.shape.zone),
})
// a field added to MemoryNoteBase but forgotten here is a compile error, not silent drift
type DraftCoversBase = keyof typeof MemoryNoteBase.shape extends keyof typeof MemoryNoteDraftInput.shape ? true : never
const draftCoversBase: DraftCoversBase = true
void draftCoversBase

// The stored/rendered note: input + provenance/lifecycle the projector derives from events.
// `sources` is overridden with the stored shape — same citations, plus the retrieval time the
// projector stamps from the event.
export const MemoryNote = MemoryNoteBase.extend({
  sources: z.array(MemorySource).max(MEMORY_SOURCE_LIMITS.items).default([]),
  createdAt: z.string(),
  createdBy: z.string(),   // composed identity: "executor·model·role" or "cli"
  updatedAt: z.string(),
  updatedBy: z.string(),
  revision: z.number().int().positive(),
})
export type MemoryNote = z.infer<typeof MemoryNote>

export const NoteSummary = z.object({
  id: z.string(), scope: z.string(), title: z.string(),
  categories: z.array(z.string()), tags: z.array(z.string()), summary: z.string(),
  // observed use, event-sourced (see MemoryAccessedPayload) — so it survives a rebuild and is
  // real data rather than a projection-local counter that any replay silently zeroes.
  hits: z.number().int().nonnegative(),
  lastAccessedAt: z.string().nullable(),
})
export type NoteSummary = z.infer<typeof NoteSummary>

export const NeighborResult = z.object({
  id: z.string(), title: z.string(), summary: z.string(),
  via: LinkKind, depth: z.number().int().positive(), score: z.number(),
})
export type NeighborResult = z.infer<typeof NeighborResult>

export interface MemoryFilter { scope?: string; category?: string; tag?: string }

// The single-writer gateway (the wrapper). write/remove append events; reads hit SurrealDB.
// write takes the raw draft — the gateway parses (defaults + validation), callers never cast.
// typed event payloads — PAYLOAD_SCHEMAS entries and the memory projector parse through
// these, so payload access never needs a cast
export const MemoryWrittenPayload = z.object({ note: MemoryNoteInput, author: MemoryAuthor })
export type MemoryWrittenPayload = z.infer<typeof MemoryWrittenPayload>
export const MemoryDeletedPayload = z.object({
  // id AND scope must be MEMORY_ID_RE-safe: they flow into noteRelPath → the vault path guard,
  // so an unconstrained scope (e.g. '../x') would throw in the projector and wedge the read model.
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE),
  author: MemoryAuthor,
})
export type MemoryDeletedPayload = z.infer<typeof MemoryDeletedPayload>

// An access is a first-class fact, not projection bookkeeping: what an agent actually pulled is
// the only evidence of which knowledge is load-bearing, and a counter written outside the log is
// erased by every rebuild. Emitted per successful pull (a miss records nothing) — id and scope
// carry the same MEMORY_ID_RE guard as memory_deleted, since both index the read model by key.
export const MEMORY_ACCESS_MODES = ['read', 'neighbors'] as const
export const MemoryAccessMode = z.enum(MEMORY_ACCESS_MODES)
export type MemoryAccessMode = z.infer<typeof MemoryAccessMode>
export const MEMORY_ACCESS = MemoryAccessMode.enum
export const MemoryAccessedPayload = z.object({
  id: z.string().regex(MEMORY_ID_RE),
  scope: z.string().regex(MEMORY_ID_RE),
  mode: MemoryAccessMode,
  author: MemoryAuthor,
})
export type MemoryAccessedPayload = z.infer<typeof MemoryAccessedPayload>

export interface MemoryStore {
  // idempotencyKey: deterministic writers (tool-driven writes inside an operation) pass one so
  // a crash retry of the surrounding effect cannot append the note event twice
  write(input: MemoryNoteDraft, author: MemoryAuthor, opts?: { idempotencyKey?: string }): Promise<MemoryNote>
  remove(id: string, scope?: string, author?: MemoryAuthor): Promise<void>
  get(id: string, scope?: string): Promise<MemoryNote | null>
  list(filter?: MemoryFilter): Promise<NoteSummary[]>
  search(query: string, filter?: MemoryFilter): Promise<NoteSummary[]>
  neighbors(seed: string, opts?: { kinds?: LinkKind[]; depth?: number; scope?: string }): Promise<NeighborResult[]>
  // called by the pull call sites (tools, CLI) rather than inside get(), so a traversal that
  // reads N notes internally records one access against its seed, not N against its neighbours
  recordAccess(id: string, scope: string | undefined, mode: MemoryAccessMode, author: MemoryAuthor): Promise<void>
}

// Composed provenance string for createdBy/updatedBy (frontmatter + read model).
export function composeAuthor(a: MemoryAuthor): string {
  if (a.source === 'cli') return 'cli'
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || 'agent'
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
  prev?: { createdAt?: string; createdBy?: string; revision?: number },
): { sources: MemorySource[]; createdAt: string; createdBy: string; updatedAt: string; updatedBy: string; revision: number } {
  const by = composeAuthor(author)
  return {
    sources: note.sources.map(s => ({ ...s, retrievedAt: ts })),
    createdAt: prev?.createdAt ?? ts,
    createdBy: prev?.createdBy ?? by,
    updatedAt: ts,
    updatedBy: by,
    revision: (prev?.revision ?? 0) + 1,
  }
}

export const noteKey = (scope: string, id: string): string => `${scope}\u0000${id}`

// Last-write-wins fold of the memory event stream into the live note set. Lenient like fold():
// an unparseable payload is skipped, never applied. Input needs only kind+payload so both
// EventRecord[] and trimmed test fixtures work.
export function foldLiveNotes(
  events: Array<Pick<EventRecord, 'kind' | 'payload'>>,
): Map<string, MemoryWrittenPayload> {
  const live = new Map<string, MemoryWrittenPayload>()
  for (const e of events) {
    if (e.kind === EVENT_KIND.memory_written) {
      const p = MemoryWrittenPayload.safeParse(e.payload)
      if (p.success) live.set(noteKey(p.data.note.scope, p.data.note.id), p.data)
    } else if (e.kind === EVENT_KIND.memory_deleted) {
      const p = MemoryDeletedPayload.safeParse(e.payload)
      if (p.success) live.delete(noteKey(p.data.scope, p.data.id))
    }
  }
  return live
}
