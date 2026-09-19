import { z } from 'zod'
import { ChatKind, ChatRef } from './chat'
import { Usage } from './execution'
import { Door } from './origin'
import { TaskStatus } from './task'

// The SHAPE of one interaction's summary — what a digest is, not how it is folded. A LEAF, because
// the browser's wire holds `ChatDigest`: reaching ./events from here drags ./memory -> ./claim ->
// node:crypto in, and a browser build cannot resolve that.

export const ChatDigest = z.object({
  chatId: z.string().min(1),
  kind: z.enum(ChatKind),
  title: z.string(),
  workspaceId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  // the door of the chat_opened ENVELOPE, not of the events inside: a run chat opened by the
  // supervisor can carry web and mcp events.
  door: z.enum(Door),
  parent: ChatRef.nullable(),
  externalRef: z.string().min(1).nullable(),
  openedSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  // Null for every kind but `run`: only a run has an end anyone can point at — a copilot chat is
  // never closed, it just stops receiving events.
  endedSeq: z.number().int().nonnegative().nullable(),
  outcome: TaskStatus.nullable(),
  asked: z.string().nullable(),
  caused: z.object({
    tasks: z.array(z.string().min(1)),
    plans: z.array(z.string().min(1)),
    runs: z.array(z.string().min(1)),
  }),
  notes: z.object({
    written: z.array(z.string().min(1)),
    verified: z.array(z.string().min(1)),
    deleted: z.array(z.string().min(1)),
  }),
  commits: z.array(z.string().min(1)),
  artifacts: z.array(z.string().min(1)),
  // by feedback key, so a re-ask after an answer is one question and two topics are two
  questions: z.object({
    asked: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  }),
  // this chat's events only — a parent that swallowed its children's cost would double-count the
  // same tokens at every level of the tree
  usage: Usage,
  summary: z.string().nullable(),
})
export type ChatDigest = z.infer<typeof ChatDigest>
