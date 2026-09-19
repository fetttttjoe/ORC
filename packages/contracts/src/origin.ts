import { z } from 'zod'

// Where a call entered and which interaction it belongs to, in a LEAF module on purpose: authors
// and event schemas read these at module top level, where a cycle resolves them to undefined.

// WHERE a call entered, kept separate from AuthorSource, which says WHO authored: a person
// and an agent both arrive through web, cli or mcp, so collapsing them loses one of the answers.
export enum Door {
  web = 'web',
  cli = 'cli',
  mcp = 'mcp',
  supervisor = 'supervisor',
  hook = 'hook',
}

// Identity, never authority: an Origin names the interaction and the door a call came from and
// grants nothing — a check that read it instead of policy would treat an id as a capability.
export const Origin = z.object({
  // nullable but NEVER optional: a call outside any interaction says so with NO_CHAT, so an absent
  // key stays distinguishable from a writer that forgot to thread its chat.
  chatId: z.string().min(1).nullable(),
  door: z.enum(Door),
})
export type Origin = z.infer<typeof Origin>

// A call that belongs to no interaction still names its door — omitting the key instead is
// indistinguishable from a writer that forgot it.
export const NO_CHAT = (door: Door): Origin => ({ chatId: null, door })

// The env var a spawned process reads its chat from — named once here because the writer (the
// commit tool) and the hook that reads it back are in different packages.
export const ORC_CHAT_ID = 'ORC_CHAT_ID'
