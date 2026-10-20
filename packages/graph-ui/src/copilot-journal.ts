import { EVENT_KIND, type CopilotExchangePayload, type Door, type EventInput, type Usage } from '@orc/contracts'
import type { CopilotChatOpen } from './copilot-chat'


export interface CopilotExchangeRecord {
  chatId: string
  opened: CopilotChatOpen | null
  payload: CopilotExchangePayload
  usage: Usage | null
}

// named structurally so journaling drags no kernel into a door that only appends
export interface ExchangeLog {
  transaction<T>(fn: (tx: { append: (input: EventInput) => Promise<unknown> }) => Promise<T>): Promise<T>
}

export async function appendCopilotExchange(log: ExchangeLog, exchange: CopilotExchangeRecord, door: Door): Promise<void> {
  const envelope = { chatId: exchange.chatId, door, taskId: null, stepId: null, runToken: null }
  await log.transaction(async tx => {
    // Both or neither: a chat_opened without its exchange leaves an empty chat
    const opened = exchange.opened
    if (opened) await tx.append({ ...envelope, idempotencyKey: opened.idempotencyKey, kind: EVENT_KIND.chat_opened, payload: opened.payload })
    await tx.append({ ...envelope, kind: EVENT_KIND.copilot_exchange, payload: exchange.payload, usage: exchange.usage })
  })
}
