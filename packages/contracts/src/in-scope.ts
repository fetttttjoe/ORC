import { z } from 'zod'
import { ScopeType } from './scope'
import type { EventRecord } from './event-kinds'
import { PAYLOAD_SCHEMAS } from './events'
import type { Scope, ScopeIndex } from './scope'

// the one membership test: a second spelling would split transcript and cost totals

// Authored events name their task, if any, and always their workspace.
const AuthoredPayload = z.union([
  PAYLOAD_SCHEMAS.knowledge_written, PAYLOAD_SCHEMAS.knowledge_delivered, PAYLOAD_SCHEMAS.knowledge_checked,
])

// payloads naming a checkout the envelope's task cannot: hook commits, copilot exchanges, chats
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
