import { z } from 'zod'

export const MEMORY_ID_RE = /^[a-z0-9][a-z0-9-]*$/

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
  'example_of', 'derived_from', 'relates_to',
] as const
export const LinkKind = z.enum(LINK_KINDS)
export type LinkKind = z.infer<typeof LinkKind>

export const MemoryLink = z.object({
  id: Id,
  kind: LinkKind.default('relates_to'), // fills a missing key on a typed link; NOT a string-coercion
  confidence: z.number().min(0).max(1).optional(),
})
export type MemoryLink = z.infer<typeof MemoryLink>

// What a writer (agent/CLI) supplies. Arrays/strings default so a minimal note is one id+title.
export const MemoryNoteInput = z.object({
  id: Id,
  scope: z.string().regex(MEMORY_ID_RE).default('project'),
  title: z.string().min(1).max(200),
  categories: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  links: z.array(MemoryLink).default([]), // clean typed graph edges — no string-id form
  paths: z.array(z.string()).default([]), // pointers down to code
  rules: z.array(z.string()).default([]), // normative statements agents honor
  summary: z.string().max(500).default(''),
  body: z.string().default(''),
})
export type MemoryNoteInput = z.infer<typeof MemoryNoteInput>
// What callers hand the gateway: the schema's raw input, defaults not yet applied.
export type MemoryNoteDraft = z.input<typeof MemoryNoteInput>

// The stored/rendered note: input + provenance/lifecycle the projector derives from events.
export const MemoryNote = MemoryNoteInput.extend({
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
