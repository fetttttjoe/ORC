import { z } from 'zod'
import { Door, Origin } from './origin'

// The doors a write can come through — MATCHED VALUES, never scattered literals, the same
// discipline EVENT_KIND already applies. These were inline in the schema below and spelled as bare
// `'cli'` at two dozen production call sites, which is precisely the shape that drifts: nothing
// connects the spelling at a call site to the enum that defines it, so a renamed door fails at
// runtime in whichever path is exercised last.
//
// 'mcp' is a DOOR, not a person. It exists because plan_approved.approvedBy already carries
// enum(['human','policy','mcp']) "so replay shows exactly who approved (P7 attribution)", while
// this enum could not express the same thing — so a grounded task's conversational approve, which
// IS its human gate, was recorded as 'cli' whoever sent it. The log could not distinguish a human
// at a terminal from an agent driving the MCP surface.
//
// 'human' means a PERSON typed this, and only doors a person drives write it: `orc adr new` /
// `orc adr supersede` (a decision is a judgment a person makes). 'cli' still means "came through a
// terminal", because a script can drive it. The MCP door writes 'mcp'.
export enum AuthorSource {
  agent = 'agent',
  cli = 'cli',
  mcp = 'mcp',
  human = 'human',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const AUTHOR_SOURCE = AuthorSource

// What each door stamps as the author today. `satisfies Record<Door, AuthorSource>` makes a new
// door a compile error instead of an undefined that sticks forever in createdBy.
const DOOR_AUTHOR_SOURCE = {
  [Door.web]: AUTHOR_SOURCE.cli,
  [Door.cli]: AUTHOR_SOURCE.cli,
  [Door.mcp]: AUTHOR_SOURCE.mcp,
  [Door.supervisor]: AUTHOR_SOURCE.agent,
  [Door.hook]: AUTHOR_SOURCE.cli,
} satisfies Record<Door, AuthorSource>

export const authorSourceOf = (door: Door): AuthorSource => DOOR_AUTHOR_SOURCE[door]

// Who wrote a claim, a plan annotation, or a feedback reply.
export const MemoryAuthor = z.object({
  source: z.enum(AuthorSource),
  // The workspace the write came FROM, captured at the moment of the write — from the writing
  // task for an agent step, from the cwd's adopted workspace for a CLI/MCP/reactor door. Required:
  // recovered later it would have to be guessed from the envelope's task, absent on a CLI write.
  workspaceId: z.string().min(1),
  // Which interaction and door the write came FROM, on the same terms as the workspace above.
  // Unrecoverable afterwards: a write that did not name its origin reads as coming from nowhere.
  origin: Origin,
  taskId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  runToken: z.string().nullable().optional(),
  executor: z.string().optional(),
  model: z.string().optional(),
  role: z.string().optional(),
})
export type MemoryAuthor = z.infer<typeof MemoryAuthor>

// Composed provenance string.
export function composeAuthor(a: MemoryAuthor): string {
  // 'cli' and 'human' render as THEMSELVES: neither has an executor/model/role to compose from,
  // and a person is not a pipeline.
  if (a.source === AUTHOR_SOURCE.cli || a.source === AUTHOR_SOURCE.human) return a.source
  // Every other door composes from its pipeline, and falls back TO ITS OWN SOURCE — never to a
  // hardcoded 'agent', which would mis-stamp a bare `{ source: 'mcp', workspaceId }` as an agent.
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || a.source
}
