import { z } from 'zod'

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

// knowledge lifecycle: current/target architecture stay distinguishable and queryable
export const NOTE_KINDS = ['fact', 'decision', 'architecture_current', 'architecture_target', 'documentation', 'plan'] as const
export const NoteKind = z.enum(NOTE_KINDS)
export type NoteKind = z.infer<typeof NoteKind>
export const NOTE_KIND = NoteKind.enum

// What a writer (agent/CLI) supplies. Arrays/strings default so a minimal note is one id+title.
const MemoryNoteBase = z.object({
  id: Id,
  scope: z.string().regex(MEMORY_ID_RE).default('project'),
  kind: NoteKind.default('fact'),
  // stamped by the store gateway from the runtime's Git HEAD — agents cannot invent one
  sourceRevision: z.string().nullable().default(null),
  title: z.string().min(1).max(200),
  categories: z.array(z.string().max(MEMORY_LIMITS.labelChars)).max(MEMORY_LIMITS.labelItems).default([]),
  // lowercased at the boundary: search matches tags against a lowercased query while the
  // list/ls filter compares case-exactly, so an un-normalized 'Postgres' is silently
  // unreachable from one path and reachable from the other. Normalizing here also applies on
  // replay (the projector re-parses each payload), so a rebuild converges existing notes.
  tags: z.array(z.string().max(MEMORY_LIMITS.labelChars).toLowerCase()).max(MEMORY_LIMITS.labelItems).default([]),
  links: z.array(MemoryLink).max(MEMORY_LIMITS.detailItems).default([]), // clean typed graph edges — no string-id form
  paths: z.array(z.string().max(MEMORY_LIMITS.detailChars)).max(MEMORY_LIMITS.detailItems).default([]), // pointers down to code
  rules: z.array(z.string().max(MEMORY_LIMITS.detailChars)).max(MEMORY_LIMITS.detailItems).default([]), // normative statements agents honor
  summary: z.string().max(500).default(''),
  body: z.string().max(MEMORY_LIMITS.bodyChars).default(''),
  rationale: z.string().max(MEMORY_LIMITS.rationaleChars).default(''),          // plan-note: why this subplan exists
  uncertainty: z.array(z.string().max(MEMORY_LIMITS.detailChars)).max(MEMORY_LIMITS.detailItems).default([]), // plan-note: coverage gaps / assumptions (RG7)
})
export const MemoryNoteInput = MemoryNoteBase.refine(
  n => !(n.scope === 'project' && n.id === 'index'),
  { message: "note id 'index' is reserved in the project scope (collides with vault/memory/index.md)" },
)
export type MemoryNoteInput = z.infer<typeof MemoryNoteInput>
// What callers hand the gateway: the schema's raw input, defaults not yet applied.
export type MemoryNoteDraft = z.input<typeof MemoryNoteInput>

// The stored/rendered note: input + provenance/lifecycle the projector derives from events.
export const MemoryNote = MemoryNoteBase.extend({
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

export interface MemoryStore {
  // idempotencyKey: deterministic writers (tool-driven writes inside an operation) pass one so
  // a crash retry of the surrounding effect cannot append the note event twice
  write(input: MemoryNoteDraft, author: MemoryAuthor, opts?: { idempotencyKey?: string }): Promise<MemoryNote>
  remove(id: string, scope?: string): Promise<void>
  get(id: string, scope?: string): Promise<MemoryNote | null>
  list(filter?: MemoryFilter): Promise<NoteSummary[]>
  search(query: string, filter?: MemoryFilter): Promise<NoteSummary[]>
  neighbors(seed: string, opts?: { kinds?: LinkKind[]; depth?: number; scope?: string }): Promise<NeighborResult[]>
}

// Composed provenance string for createdBy/updatedBy (frontmatter + read model).
export function composeAuthor(a: MemoryAuthor): string {
  if (a.source === 'cli') return 'cli'
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || 'agent'
}
