import { ChatKind, chatOpenedKey, type ChatOpenedPayload } from '@orc/contracts'

// Pure: no server, log or clock; the door supplies the id source and appends the result

export interface CopilotChatOpen {
  idempotencyKey: string
  payload: ChatOpenedPayload
}

export interface CopilotChat {
  chatId: string
  // null when the client echoed an id: a second chat_opened would fork one conversation
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
