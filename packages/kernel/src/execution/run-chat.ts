import {
  ChatKind, ChatOpenedPayload, Door, EVENT_KIND, chatOpenedKey,
  type ChatRef, type EventDraft, type Origin, type TaskNode,
} from '@orc/contracts'

// The run's own workflow id, never a step's: a step chat would split one run's transcript into N.
export const runOrigin = (workflowId: string): Origin => ({ chatId: workflowId, door: Door.supervisor })

// Keyed by chat id so a DBOS-replayed init appends nothing.
export const runChatOpened = (input: { chatId: string; task: TaskNode; parent: ChatRef | null }): EventDraft => ({
  kind: EVENT_KIND.chat_opened,
  payload: ChatOpenedPayload.parse({
    chatId: input.chatId, kind: ChatKind.run,
    workspaceId: input.task.workspaceId, taskId: input.task.id, title: input.task.title,
    parent: input.parent, externalRef: null,
  }),
  idempotencyKey: chatOpenedKey(input.chatId),
})
