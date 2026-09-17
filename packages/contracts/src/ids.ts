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

// The doors a write can come through — MATCHED VALUES, never scattered literals, the same
// discipline NOTE_KIND/LINK_KIND/MEMORY_ACCESS/EVENT_KIND already apply. These were inline in the
// schema below and spelled as bare `'cli'` at two dozen production call sites, which is precisely
// the shape that drifts: nothing connects the spelling at a call site to the enum that defines it,
// so a renamed door fails at runtime in whichever path is exercised last.
//
// 'mcp' is a DOOR, not a person. It exists because plan_approved.approvedBy already carries
// enum(['human','policy','mcp']) "so replay shows exactly who approved (P7 attribution)", while
// this enum could not express the same thing — so a grounded task's conversational approve, which
// IS its human gate, was recorded as 'cli' whoever sent it. The log could not distinguish a human
// at a terminal from an agent driving the MCP surface.
//
// 'human' means a PERSON typed this, and only doors a person drives write it: `orc adr new` /
// `orc adr supersede` (a decision is a judgment a person makes). 'cli' still means "came through a
// terminal" — `orc note` and `orc memory add` keep it, because a script can drive them. The MCP door
// writes 'mcp'. Forward-only: createdBy is sticky across rewrites (deriveNoteProvenance), so notes
// written before this source existed cannot be re-attributed — see docs/IDEAS.md entry 12.
export const AUTHOR_SOURCES = ['agent', 'cli', 'mcp', 'human'] as const
export const AuthorSource = z.enum(AUTHOR_SOURCES)
export type AuthorSource = z.infer<typeof AuthorSource>
export const AUTHOR_SOURCE = AuthorSource.enum

// Who wrote a note, a plan annotation, or a feedback reply. It lives here rather than with the
// memory schemas because `analysis` and `events` both read it at module top level: from inside
// the memory/events cycle that resolves to undefined depending on which module loaded first.
export const MemoryAuthor = z.object({
  source: AuthorSource,
  // The workspace the write came FROM, captured at the moment of the write — from the writing
  // task for an agent step, from the cwd's adopted workspace for a CLI/MCP/reactor door. ONE shape
  // for every author: writes, verifications, accesses, removals and archive flags alike, so no
  // reader has to know which kind of author it is holding before it can ask.
  //
  // REQUIRED, and deliberately not `.optional()`/`.nullable()`/`.default()`: the read tools derive
  // a note's `provisional` standing from it, and a workspace can only be known at write time —
  // recovered later it would have to be GUESSED from the envelope's task, which is absent on a CLI
  // write and wrong for a task that moved. A required key turns a writer that forgot to name its
  // workspace into a build failure instead of a note that quietly reads as trunk knowledge.
  workspaceId: z.string().min(1),
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
  // 'cli' and 'human' render as THEMSELVES: neither has an executor/model/role to compose from,
  // and a person is not a pipeline.
  if (a.source === AUTHOR_SOURCE.cli || a.source === AUTHOR_SOURCE.human) return a.source
  // Every other door composes from its pipeline, and falls back TO ITS OWN SOURCE — never to a
  // hardcoded 'agent'. The fallback used to be the literal, which made a bare
  // `{ source: 'mcp', workspaceId }` — exactly what cwdAuthor builds for the MCP door, which has no
  // executor/model/role — render as 'agent'. deriveNoteProvenance stamps that into createdBy, and
  // createdBy is STICKY across rewrites: every decision recorded over MCP would have read as an
  // agent's work forever, with no migration able to correct it. Unchanged for a bare 'agent',
  // whose source IS the word the fallback used to spell.
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || a.source
}
