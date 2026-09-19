import { afterAll, describe, expect, it } from 'bun:test'
import { ChatKind, ChatOpenedPayload, Door, EVENT_KIND, type CopilotExchangePayload, type EventRecord } from '@orc/contracts'
import { must } from '@orc/contracts/fixtures'
import { openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { copilotChat } from './copilot-chat'
import { appendCopilotExchange, type CopilotExchangeRecord } from './copilot-journal'

// One database for the file; each case owns its own chat id, so a read filtered by chat is as
// isolated as a fresh log and costs no CREATE DATABASE.
const db = await createTestDb()
const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
afterAll(async () => {
  await storage.close().catch(() => {})
  await db.drop()
}, 30_000)

const payloadOf = (over: Partial<CopilotExchangePayload> = {}): CopilotExchangePayload => ({
  user: 'what is running?', assistant: 'the seed task', toolCalls: [], modelRef: 'mock/m',
  taskId: null, workspaceId: null, ...over,
})

// the record the door hands over, built by the SAME pure pairing the server uses
const recordOf = (chatId: string, opened: boolean, payload = payloadOf()): CopilotExchangeRecord => {
  const chat = copilotChat({ chatId: opened ? null : chatId, taskId: null, workspaceId: null, title: 'first ask' }, () => chatId)
  return { chatId: chat.chatId, opened: chat.opened, payload, usage: null }
}


const inChat = async (chatId: string): Promise<EventRecord[]> =>
  (await storage.events.all()).filter(e => e.chatId === chatId)

describe('appendCopilotExchange', () => {
  it('opens the chat and appends the exchange together for a first exchange', async () => {
    const chatId = 'chat-first'
    await appendCopilotExchange(storage.events, recordOf(chatId, true), Door.web)
    const events = await inChat(chatId)
    expect(events.map(e => e.kind)).toEqual([EVENT_KIND.chat_opened, EVENT_KIND.copilot_exchange])
    expect(events.every(e => e.door === Door.web)).toBe(true)
    expect(ChatOpenedPayload.parse(must(events[0], 'chat_opened').payload)).toEqual({
      chatId, kind: ChatKind.copilot, title: 'first ask', workspaceId: null, taskId: null, parent: null, externalRef: null,
    })
  })

  it('appends neither when the exchange is refused', async () => {
    const chatId = 'chat-refused'
    // modelRef '' fails the payload schema at the log boundary: the exchange append throws AFTER
    // the chat_opened one, which is exactly the half-write the transaction exists to prevent
    await expect(appendCopilotExchange(storage.events, recordOf(chatId, true, payloadOf({ modelRef: '' })), Door.web)).rejects.toThrow()
    expect(await inChat(chatId)).toEqual([])
  })

  it('opens no chat for an echoed id', async () => {
    const chatId = 'chat-echoed'
    await appendCopilotExchange(storage.events, recordOf(chatId, true), Door.web)
    await appendCopilotExchange(storage.events, recordOf(chatId, false), Door.web)
    const events = await inChat(chatId)
    expect(events.filter(e => e.kind === EVENT_KIND.chat_opened)).toHaveLength(1)
    expect(events.filter(e => e.kind === EVENT_KIND.copilot_exchange)).toHaveLength(2)
  })

  it('opens no second chat when the same open replays', async () => {
    const chatId = 'chat-replayed'
    const record = recordOf(chatId, true)
    await appendCopilotExchange(storage.events, record, Door.web)
    await appendCopilotExchange(storage.events, record, Door.web)
    expect((await inChat(chatId)).filter(e => e.kind === EVENT_KIND.chat_opened)).toHaveLength(1)
  })
})
