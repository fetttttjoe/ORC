import { describe, expect, test } from 'bun:test'
import { ChatKind, ChatOpenedPayload, ChatRef, Door, EVENT_KIND, TASK_STATUS, TaskType, chatOpenedKey, type TaskNode } from '@orc/contracts'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { runChatOpened, runOrigin } from './run-chat'

const task: TaskNode = {
  id: 'task-1', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: TaskType.generic,
  title: 'ship it', spec: '', status: TASK_STATUS.approved, zone: [], budgetUSD: null, depth: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
}

describe('run chat', () => {
  test('a run\'s origin is its own workflow id, entered through the supervisor door', () => {
    expect(runOrigin('run:task-1:v1')).toEqual({ chatId: 'run:task-1:v1', door: Door.supervisor })
  })

  test('the opened draft parses under ChatOpenedPayload and is keyed by the chat id', () => {
    const draft = runChatOpened({ chatId: 'run:task-1:v1', task, parent: null })
    expect(draft.kind).toBe(EVENT_KIND.chat_opened)
    expect(draft.idempotencyKey).toBe(chatOpenedKey('run:task-1:v1'))
    const payload = ChatOpenedPayload.parse(draft.payload)
    expect(payload).toEqual({
      chatId: 'run:task-1:v1', kind: ChatKind.run, workspaceId: TEST_WORKSPACE_ID,
      taskId: 'task-1', title: 'ship it', parent: null, externalRef: null,
    })
  })

  test('the causation pointer rides through untouched', () => {
    const parent = ChatRef.parse({ chatId: 'run:task-0:v1', seq: 12 })
    expect(ChatOpenedPayload.parse(runChatOpened({ chatId: 'run:task-1:v1', task, parent }).payload).parent).toEqual(parent)
  })
})
