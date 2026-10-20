import { z } from 'zod'

// the interaction vocabulary; chatId is the correlation id every event carries

export enum ChatKind {
  copilot = 'copilot',
  run = 'run',
  // a foreign agent's session driving this project from outside (its own id lands in externalRef)
  external = 'external',
  // a session reconstructed after the fact from a transcript the orchestrator did not witness
  imported = 'imported',
}

// shared by the server route and the web chat cache: one wire vocabulary
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

// no door key: the envelope states it and a second copy could disagree
export const ChatOpenedPayload = z.object({
  chatId: z.string().min(1),
  kind: z.enum(ChatKind),
  // captured at open: a task can move workspaces, so later resolution gives today's checkout
  workspaceId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  title: z.string(),
  // causation pointer: the event in another chat that started this one; known only at open
  parent: ChatRef.nullable(),
  // a foreign session's own id, to match its transcript back to the chat
  externalRef: z.string().min(1).nullable(),
})
export type ChatOpenedPayload = z.infer<typeof ChatOpenedPayload>

// derived from the chat id so a retried open collapses instead of opening twice
export const chatOpenedKey = (chatId: string): string => `${chatId}:opened`
