import { z } from 'zod'
import { ScopeType } from './scope'
import type { EventRecord } from './event-kinds'
import { PAYLOAD_SCHEMAS } from './events'
import type { Scope, ScopeIndex } from './scope'

// The ONE membership test every read surface asks. It takes the task tree through a narrow index
// rather than the kernel's State, so the rule stays a pure function: a second spelling of "is this
// event in scope" would decide a transcript and a cost total differently and neither would look
// wrong.

// Authored events name their task, if any, and always their workspace.
const AuthoredPayload = z.union([
  PAYLOAD_SCHEMAS.memory_written, PAYLOAD_SCHEMAS.memory_deleted, PAYLOAD_SCHEMAS.memory_accessed,
  PAYLOAD_SCHEMAS.memory_verified, PAYLOAD_SCHEMAS.memory_outcome, PAYLOAD_SCHEMAS.memory_topic_accessed,
  PAYLOAD_SCHEMAS.knowledge_written, PAYLOAD_SCHEMAS.knowledge_delivered,
])

// The payloads that name a checkout the envelope's task cannot: a hook's commit and a copilot
// exchange have no task, and a chat states the workspace it was opened in.
const PlacedPayload = z.union([
  PAYLOAD_SCHEMAS.commit_recorded, PAYLOAD_SCHEMAS.copilot_exchange, PAYLOAD_SCHEMAS.chat_opened,
])

export function taskOf(event: EventRecord): string | null {
  if (event.taskId !== null) return event.taskId
  const authored = AuthoredPayload.safeParse(event.payload)
  return authored.success ? authored.data.author.taskId ?? null : null
}

export function workspaceOf(event: EventRecord, index: ScopeIndex): string | null {
  const taskId = taskOf(event)
  const viaTask = taskId === null ? null : index.workspaceOfTask(taskId)
  if (viaTask !== null) return viaTask
  const placed = PlacedPayload.safeParse(event.payload)
  if (placed.success) return placed.data.workspaceId
  const authored = AuthoredPayload.safeParse(event.payload)
  return authored.success ? authored.data.author.workspaceId : null
}

export function inScope(event: EventRecord, scope: Scope, index: ScopeIndex): boolean {
  switch (scope.type) {
    case ScopeType.project:
      return true
    case ScopeType.chat:
      return event.chatId === scope.id
    case ScopeType.workspace:
      return workspaceOf(event, index) === scope.id
    case ScopeType.task: {
      const taskId = taskOf(event)
      if (taskId === null) return false
      return scope.subtree ? index.inSubtree(taskId, scope.id) : taskId === scope.id
    }
  }
}
