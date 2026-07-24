import { z } from 'zod'

// Identity and provenance primitives, in a LEAF module on purpose. `memory` and `events` import each other in a
// deliberate cycle (each only reads the other inside function bodies), and `analysis` reads an id
// regex at module top level — routing that read through the cycle means it resolves to undefined
// whenever `memory` happens to be the module still initializing. A leaf has no such ordering.

export const MEMORY_ID_RE = /^[a-z0-9][a-z0-9-]*$/

// Deterministic MEMORY_ID_RE-safe id from a human title. Quick capture keys notes by title,
// so re-noting the same title UPDATES the note (memory_write is an upsert) instead of forking
// near-duplicates — deliberate: capture is idempotent, disambiguation is renaming the title.
export function slugId(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
  if (!MEMORY_ID_RE.test(s))
    throw new Error(`cannot derive a note id from '${title}' — use latin letters/digits, or 'orc memory add --id <id>'`)
  return s
}

// Who wrote a note, a plan annotation, or a feedback reply. It lives here rather than with the
// memory schemas because `analysis` and `events` both read it at module top level: from inside
// the memory/events cycle that resolves to undefined depending on which module loaded first.
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

// Composed provenance string for createdBy/updatedBy (frontmatter + read model).
export function composeAuthor(a: MemoryAuthor): string {
  if (a.source === 'cli') return 'cli'
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || 'agent'
}
