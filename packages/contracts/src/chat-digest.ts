import { z } from 'zod'
import { ChatKind, ChatRef } from './chat'
import { Usage } from './execution'
import { Door } from './origin'
import { TaskStatus } from './task'

// a leaf the browser's wire holds: ./events would pull node:crypto in through ./knowledge

export const ChatDigest = z.object({
  chatId: z.string().min(1),
  kind: z.enum(ChatKind),
  title: z.string(),
  workspaceId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable(),
  // the door of the chat_opened envelope, not of the events inside it
  door: z.enum(Door),
  parent: ChatRef.nullable(),
  externalRef: z.string().min(1).nullable(),
  openedSeq: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  // null for every kind but run: a copilot chat is never closed, it just stops
  endedSeq: z.number().int().nonnegative().nullable(),
  outcome: z.enum(TaskStatus).nullable(),
  asked: z.string().nullable(),
  caused: z.object({
    tasks: z.array(z.string().min(1)),
    plans: z.array(z.string().min(1)),
    runs: z.array(z.string().min(1)),
  }),
  claims: z.object({
    written: z.array(z.string().min(1)),
    checked: z.array(z.string().min(1)),
    retired: z.array(z.string().min(1)),
  }),
  commits: z.array(z.string().min(1)),
  artifacts: z.array(z.string().min(1)),
  // by feedback key, so a re-ask after an answer is one question and two topics are two
  questions: z.object({
    asked: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  }),
  // this chat's events only: a parent that swallowed its children's cost would double-count
  usage: Usage,
  summary: z.string().nullable(),
})
export type ChatDigest = z.infer<typeof ChatDigest>
