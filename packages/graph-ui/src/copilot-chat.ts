import { ChatKind, chatOpenedKey, type ChatOpenedPayload } from '@orc/contracts'

// Which chat one copilot exchange belongs to, and the chat_opened that opens it. Pure: no server,
// no log, no clock — the door supplies the id source and appends what this returns.

export interface CopilotChatOpen {
  idempotencyKey: string
  payload: ChatOpenedPayload
}

export interface CopilotChat {
  chatId: string
  // null when the client echoed an id: a second chat_opened for a live conversation would fork one
  // interaction into two chats and double every digest read over it
  opened: CopilotChatOpen | null
}

export interface CopilotChatInput {
  chatId: string | null
  taskId: string | null
  workspaceId: string | null
  title: string
}

export const copilotChat = (input: CopilotChatInput, mintId: () => string): CopilotChat => {
  if (input.chatId !== null) return { chatId: input.chatId, opened: null }
  const chatId = mintId()
  return {
    chatId,
    opened: {
      idempotencyKey: chatOpenedKey(chatId),
      payload: {
        chatId,
        kind: ChatKind.copilot,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        title: input.title,
        parent: null,
        externalRef: null,
      },
    },
  }
}

// The chat's label is the opening ask: a list of chats titled "copilot" tells a reader nothing.
export const CHAT_TITLE_MAX = 80
export const chatTitleOf = (user: string): string => user.slice(0, CHAT_TITLE_MAX)
