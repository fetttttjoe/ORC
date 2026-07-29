import { z } from 'zod'

// Identity and provenance primitives, in a LEAF module on purpose. `memory` and `events` import each other in a
// deliberate cycle (each only reads the other inside function bodies), and `analysis` reads an id
// regex at module top level — routing that read through the cycle means it resolves to undefined
// whenever `memory` happens to be the module still initializing. A leaf has no such ordering.

export const MEMORY_ID_RE = /^[a-z0-9][a-z0-9-]*$/

// The one spelling of a sha256-hex digest. It was spelled inline at three sites (artifact
// receipts, plan hashes, kernel trust fingerprints) — a widened or typo'd copy would admit
// digests the other two reject.
export const SHA256_HEX_RE = /^[a-f0-9]{64}$/

// Deterministic MEMORY_ID_RE-safe id from a human title. Quick capture keys notes by title,
// so re-noting the same title UPDATES the note (memory_write is an upsert) instead of forking
// near-duplicates — deliberate: capture is idempotent, disambiguation is renaming the title.
// Trim one repeated character off both ends by index. The regex this replaces (`/^-+|-+$/`) was
// linear ONLY because the collapse below guarantees no repeated dashes — an invariant neither a
// reader nor a scanner can see, and one an innocent edit could turn into quadratic backtracking on
// a hostile title. Indexing carries no such footgun.
function trimEdges(value: string, ch: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === ch) start++
  while (end > start && value[end - 1] === ch) end--
  return value.slice(start, end)
}

export function slugId(title: string): string {
  const collapsed = title.toLowerCase().replace(/[^a-z0-9]+/g, '-') // one pass, no backtracking
  const s = trimEdges(trimEdges(collapsed, '-').slice(0, 64), '-')
  if (!MEMORY_ID_RE.test(s))
    throw new Error(`cannot derive a note id from '${title}' — use latin letters/digits, or 'orc memory add --id <id>'`)
  return s
}

// Who wrote a note, a plan annotation, or a feedback reply. It lives here rather than with the
// memory schemas because `analysis` and `events` both read it at module top level: from inside
// the memory/events cycle that resolves to undefined depending on which module loaded first.
export const MemoryAuthor = z.object({
  // 'mcp' is a DOOR, not a person. It exists because plan_approved.approvedBy already carries
  // enum(['human','policy','mcp']) "so replay shows exactly who approved (P7 attribution)", while
  // this enum could not express the same thing — so a grounded task's conversational approve, which
  // IS its human gate, was recorded as 'cli' whoever sent it. The log could not distinguish a human
  // at a terminal from an agent driving the MCP surface.
  source: z.enum(['agent', 'cli', 'mcp']),
  taskId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  runToken: z.string().nullable().optional(),
  executor: z.string().optional(),
  model: z.string().optional(),
  role: z.string().optional(),
})
export type MemoryAuthor = z.infer<typeof MemoryAuthor>

// Composed provenance string for createdBy/updatedBy (frontmatter + read model).
export function composeAuthor(a: MemoryAuthor): string {
  if (a.source === 'cli') return 'cli'
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || 'agent'
}
