import { z } from 'zod'

// The interaction vocabulary. A Chat is one interaction, and chatId is the CORRELATION id every
// event carries: task and step cannot assemble one interaction's digest, cost or transcript.

export enum ChatKind {
  copilot = 'copilot',
  run = 'run',
  // a foreign agent's session driving this project from outside (its own id lands in externalRef)
  external = 'external',
  // a session reconstructed after the fact from a transcript the orchestrator did not witness
  imported = 'imported',
}

// The copilot conversation's own message role — shared by the server route body and the web
// client's stored-chat cache, so the two never re-spell the same two-value wire vocabulary.
export enum MessageRole {
  user = 'user',
  assistant = 'assistant',
}

// A pointer at ONE event inside a chat: the chat plus that event's sequence number.
export const ChatRef = z.object({
  chatId: z.string().min(1),
  seq: z.number().int().nonnegative(),
})
export type ChatRef = z.infer<typeof ChatRef>

// No door key: this event's own envelope already states it, and a second copy could disagree with
// the first with nothing to say which is right.
export const ChatOpenedPayload = z.object({
  chatId: z.string().min(1),
  kind: z.enum(ChatKind),
  // captured AT OPEN, not resolved later through the task: a task can move between workspaces, so
  // a reader would get today's checkout as the answer for a months-old chat. Null for none.
  workspaceId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  title: z.string(),
  // the CAUSATION pointer: the event in ANOTHER chat that started this one. Known only at the
  // moment of opening — reconstructed afterwards from timing it would be guesswork.
  parent: ChatRef.nullable(),
  // a foreign session's OWN id, so an external agent's transcript can be matched back to the chat
  // this project opened for it. Null for chats this project originated.
  externalRef: z.string().min(1).nullable(),
})
export type ChatOpenedPayload = z.infer<typeof ChatOpenedPayload>

// Derived from the chat id rather than spelled at the call sites, so a retried open (a
// reconnecting client, a replayed reaction) collapses instead of opening the same chat twice.
export const chatOpenedKey = (chatId: string): string => `${chatId}:opened`
