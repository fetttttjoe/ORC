import { describe, expect, it } from 'bun:test'
import { ChatKind, ChatOpenedPayload, chatOpenedKey } from './chat'
import { Door } from './origin'

describe('ChatOpenedPayload', () => {
  const base = {
    chatId: 'run:t1:v1', kind: ChatKind.run, workspaceId: null, taskId: 't1',
    title: 'run t1', externalRef: null,
  }
  it('rejects a payload missing the parent key — causation is stated, never inferred', () => {
    expect(ChatOpenedPayload.safeParse(base).success).toBe(false)
  })
  it('accepts an explicit null parent', () => {
    expect(ChatOpenedPayload.safeParse({ ...base, parent: null }).success).toBe(true)
  })
  it('carries no door — the chat_opened event envelope states where the open came from', () => {
    const parsed = ChatOpenedPayload.parse({ ...base, door: Door.supervisor, parent: null })
    expect(Object.keys(parsed)).not.toContain('door')
  })
  it('accepts a parent pointing at one event in another chat', () => {
    expect(ChatOpenedPayload.safeParse({ ...base, parent: { chatId: 'copilot:1', seq: 12 } }).success).toBe(true)
    expect(ChatOpenedPayload.safeParse({ ...base, parent: { chatId: 'copilot:1', seq: -1 } }).success).toBe(false)
  })
})

describe('chat lifecycle idempotency keys', () => {
  it('derives one key per chat from the chat id', () => {
    expect(chatOpenedKey('run:t:v1')).toBe('run:t:v1:opened')
  })
})
