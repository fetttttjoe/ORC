import { z } from 'zod'

// a leaf module: a cycle would resolve these to undefined at schema top level

// where a call entered, not who authored (AuthorSource): both arrive through any door
export enum Door {
  web = 'web',
  cli = 'cli',
  mcp = 'mcp',
  supervisor = 'supervisor',
  hook = 'hook',
}

// identity, never authority: an Origin grants nothing and must not be checked as a capability
export const Origin = z.object({
  // nullable but never optional: NO_CHAT keeps an absent key distinct from a forgetful writer
  chatId: z.string().min(1).nullable(),
  door: z.enum(Door),
})
export type Origin = z.infer<typeof Origin>

// a call outside any interaction still names its door
export const NO_CHAT = (door: Door): Origin => ({ chatId: null, door })

// named once: the commit tool and the hook that reads it back are in different packages
export const ORC_CHAT_ID = 'ORC_CHAT_ID'
