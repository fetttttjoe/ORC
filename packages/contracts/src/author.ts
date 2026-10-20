import { z } from 'zod'
import { Door, Origin } from './origin'

// 'human' means a person typed it; 'cli' means a terminal, which a script can drive
export enum AuthorSource {
  agent = 'agent',
  cli = 'cli',
  mcp = 'mcp',
  human = 'human',
}

// every caller already matches on this accessor, never a raw literal — kept as a plain alias
export const AUTHOR_SOURCE = AuthorSource

// satisfies Record<Door, AuthorSource>: a new door is a compile error
const DOOR_AUTHOR_SOURCE = {
  [Door.web]: AUTHOR_SOURCE.cli,
  [Door.cli]: AUTHOR_SOURCE.cli,
  [Door.mcp]: AUTHOR_SOURCE.mcp,
  [Door.supervisor]: AUTHOR_SOURCE.agent,
  [Door.hook]: AUTHOR_SOURCE.cli,
} satisfies Record<Door, AuthorSource>

export const authorSourceOf = (door: Door): AuthorSource => DOOR_AUTHOR_SOURCE[door]

// Who wrote a claim, a plan annotation, or a feedback reply.
export const Author = z.object({
  source: z.enum(AuthorSource),
  // captured at write time: recovered later it would be guessed from the envelope's task
  workspaceId: z.string().min(1),
  // unrecoverable afterwards: a write that names no origin reads as coming from nowhere
  origin: Origin,
  taskId: z.string().nullable().optional(),
  stepId: z.string().nullable().optional(),
  runToken: z.string().nullable().optional(),
  executor: z.string().optional(),
  model: z.string().optional(),
  role: z.string().optional(),
})
export type Author = z.infer<typeof Author>

// Composed provenance string.
export function composeAuthor(a: Author): string {
  // 'cli' and 'human' render as themselves: neither has an executor, model or role
  if (a.source === AUTHOR_SOURCE.cli || a.source === AUTHOR_SOURCE.human) return a.source
  // falls back to its own source, never a hardcoded 'agent'
  return [a.executor, a.model, a.role].filter(Boolean).join('·') || a.source
}

export type StepAuthorFields = Pick<Author, 'origin' | 'workspaceId'> &
  Required<Pick<Author, 'executor' | 'model' | 'role'>> & { taskId: string; stepId: string; runToken: string }

export const stepAuthor = (p: StepAuthorFields): Author => ({
  source: AuthorSource.agent,
  origin: p.origin,
  workspaceId: p.workspaceId,
  taskId: p.taskId,
  stepId: p.stepId,
  runToken: p.runToken,
  executor: p.executor,
  model: p.model,
  role: p.role,
})
