import { EVENT_KIND, type CopilotExchangePayload, type Door, type EventInput, type Usage } from '@orc/contracts'
import type { CopilotChatOpen } from './copilot-chat'

// Append ONE copilot exchange, and the open of its chat when this exchange is the first one in it,
// in a single transaction. Every door that runs a copilot journals through here.

// What one completed exchange is: the chat it belongs to, that chat's open (null when the client
// echoed a live id), what was said, and what it cost.
export interface CopilotExchangeRecord {
  chatId: string
  opened: CopilotChatOpen | null
  payload: CopilotExchangePayload
  usage: Usage | null
}

// The slice of the event log this needs, named structurally: journaling a conversation must not
// drag the kernel (or a whole plugin) into a door that only wants to append two rows.
export interface ExchangeLog {
  transaction<T>(fn: (tx: { append: (input: EventInput) => Promise<unknown> }) => Promise<T>): Promise<T>
}

export async function appendCopilotExchange(log: ExchangeLog, exchange: CopilotExchangeRecord, door: Door): Promise<void> {
  const envelope = { chatId: exchange.chatId, door, taskId: null, stepId: null, runToken: null }
  await log.transaction(async tx => {
    // Both or neither: a chat_opened committed without its exchange leaves an empty conversation
    // in every chats list, and an exchange whose chat never opened is dropped by chatDigests.
    const opened = exchange.opened
    if (opened) await tx.append({ ...envelope, idempotencyKey: opened.idempotencyKey, kind: EVENT_KIND.chat_opened, payload: opened.payload })
    await tx.append({ ...envelope, kind: EVENT_KIND.copilot_exchange, payload: exchange.payload, usage: exchange.usage })
  })
}
