import { describe, expect, it } from 'bun:test'
import { ChatKind, Door, EVENT_KIND, ScopeType, TASK_STATUS, type EventRecord } from '@orc/contracts'
import { authorFixture, eventFixture, taskFixture, TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { modelOf } from '../test-helpers'
import { chats } from './chats'

const author = authorFixture()

const ev = (seq: number, kind: EventRecord['kind'], chatId: string | null, payload: Record<string, unknown> = {}, taskId: string | null = null): EventRecord =>
  eventFixture({ seq, kind, chatId, taskId, door: Door.web, payload })

const opened = (seq: number, chatId: string, over: Record<string, unknown> = {}): EventRecord =>
  eventFixture({
    seq, chatId, door: Door.supervisor, taskId: null, kind: EVENT_KIND.chat_opened,
    payload: { chatId, kind: ChatKind.copilot, workspaceId: TEST_WORKSPACE_ID, taskId: null, title: chatId, parent: null, externalRef: null, ...over },
  })

// the task tree the workspace/task scopes are resolved through
const tree = [
  eventFixture({ seq: 1, kind: EVENT_KIND.task_created, taskId: 'C', payload: { task: taskFixture({ id: 'C', workspaceId: TEST_WORKSPACE_ID }) } }),
  eventFixture({ seq: 2, kind: EVENT_KIND.task_created, taskId: 'other', payload: { task: taskFixture({ id: 'other', workspaceId: 'ws-elsewhere' }) } }),
]

describe('chats view read', () => {
  // a copilot chat's exchange precedes its own chat_opened in seq order
  const m = modelOf([
    ...tree,
    ev(3, EVENT_KIND.copilot_exchange, 'c1', { user: 'hi', assistant: 'there', toolCalls: [], modelRef: 'x/y', taskId: null, workspaceId: TEST_WORKSPACE_ID }),
    opened(4, 'c1'),
    opened(5, 'run-1', { kind: ChatKind.run, taskId: 'C' }),
    eventFixture({ seq: 6, kind: EVENT_KIND.task_status_changed, chatId: 'run-1', taskId: 'C', door: Door.supervisor, payload: { taskId: 'C', from: TASK_STATUS.running, to: TASK_STATUS.done } }),
    ev(7, EVENT_KIND.tool_call, null, { toolName: 'x', input: {} }, 'other'),
  ])

  it('lists every opened chat under a project scope, newest-opened first', () => {
    expect(chats.read(m, { scope: { type: ScopeType.project } })?.map(d => d.chatId)).toEqual(['run-1', 'c1'])
  })

  it('narrows to one chat, and keeps the WHOLE chat digest — the end a run derives, not a partial sum', () => {
    const digests = chats.read(m, { scope: { type: ScopeType.chat, id: 'run-1' } })
    expect(digests?.map(d => d.chatId)).toEqual(['run-1'])
    expect(digests?.at(0)).toMatchObject({ kind: ChatKind.run, endedSeq: 6, outcome: TASK_STATUS.done })
  })

  it('keeps a chat whose events are in a task scope even though its open names no task', () => {
    expect(chats.read(m, { scope: { type: ScopeType.task, id: 'C', subtree: false } })?.map(d => d.chatId)).toEqual(['run-1'])
    expect(chats.read(m, { scope: { type: ScopeType.task, id: 'other', subtree: false } })).toEqual([])
  })

  it('answers the workspace its chats were opened in', () => {
    expect(chats.read(m, { scope: { type: ScopeType.workspace, id: TEST_WORKSPACE_ID } })?.map(d => d.chatId)).toEqual(['run-1', 'c1'])
    expect(chats.read(m, { scope: { type: ScopeType.workspace, id: 'ws-elsewhere' } })).toEqual([])
  })

  it('a chatId seen on events with no chat_opened is no chat', () => {
    expect(chats.read(modelOf([...tree, ev(3, EVENT_KIND.tool_call, 'ghost', { toolName: 'x', input: {} })]), { scope: { type: ScopeType.project } })).toEqual([])
  })
})

// A kind chatDigests reads but touches ignores serves a stale digest forever: three such gaps were
// found in review. Every kind the fold reads gets a row here.
describe('chats view touches', () => {
  const m = modelOf(tree)
  const note = { note: { id: 'n', title: 'n', scope: 'project' }, author }
  const KINDS: Array<[EventRecord['kind'], Record<string, unknown>]> = [
    [EVENT_KIND.chat_opened, { chatId: 'c1', kind: ChatKind.copilot, workspaceId: null, taskId: null, title: 'c1', parent: null, externalRef: null }],
    [EVENT_KIND.task_created, { task: taskFixture({ id: 'C' }) }],
    [EVENT_KIND.plan_proposed, { plan: { taskId: 'C', version: 1, strategyRef: 's', costEstimateUSD: null, steps: [] } }],
    [EVENT_KIND.task_status_changed, { taskId: 'C', from: TASK_STATUS.running, to: TASK_STATUS.done }],
    [EVENT_KIND.step_completed, { stepId: 's1', summary: 'done' }],
    [EVENT_KIND.copilot_exchange, { user: 'u', assistant: 'a', toolCalls: [], modelRef: 'x/y', taskId: null, workspaceId: null }],
    [EVENT_KIND.memory_written, note],
    [EVENT_KIND.memory_verified, { id: 'n', scope: 'project', stamp: { revision: 'abc', at: '2026-09-18T00:00:00.000Z', by: 'cli' }, author }],
    [EVENT_KIND.memory_deleted, { id: 'n', scope: 'project', author }],
    [EVENT_KIND.commit_recorded, { sha: 'a'.repeat(40), workspaceId: TEST_WORKSPACE_ID, message: 'm', files: [] }],
    [EVENT_KIND.artifact_produced, { path: 'out.txt', sha256: 'a'.repeat(64), size: 3 }],
    [EVENT_KIND.feedback_requested, { topic: 't', question: 'q' }],
    [EVENT_KIND.feedback_provided, { topic: 't', text: 'a' }],
  ]

  it('stales the project list for every kind the digest fold reads', () => {
    for (const [kind, payload] of KINDS)
      expect(chats.touches(ev(8, kind, 'c1', payload), m)).toContainEqual({ scope: { type: ScopeType.project } })
  })

  it('names the chat, and never another chat holding a query', () => {
    expect(chats.touches(ev(8, EVENT_KIND.copilot_exchange, 'c1', { user: 'u', assistant: 'a', toolCalls: [], modelRef: 'x/y', taskId: null, workspaceId: null }), m))
      .toContainEqual({ scope: { type: ScopeType.chat, id: 'c1' } })
    expect(chats.touches(ev(8, EVENT_KIND.tool_call, 'c1', { toolName: 'x', input: {} }), m))
      .not.toContainEqual({ scope: { type: ScopeType.chat, id: 'c2' } })
  })

  // The one event that moves a digest it does not belong to: a child's open is what the PARENT's
  // caused.runs is read off, so a parent chat pane holding its own scope must refetch.
  it('names the parent chat too when a child chat opens under it', () => {
    const child = opened(9, 'c2', { parent: { chatId: 'c1', seq: 4 } })
    expect(chats.touches(child, m)).toContainEqual({ scope: { type: ScopeType.chat, id: 'c1' } })
    expect(chats.touches(child, m)).toContainEqual({ scope: { type: ScopeType.chat, id: 'c2' } })
  })

  // Events with chatId null belong to no digest, so no chats query can have gone stale.
  it('an event belonging to no chat stales nothing', () => {
    expect(chats.touches(ev(9, EVENT_KIND.tool_call, null, { toolName: 'x', input: {} }, 'C'), m)).toEqual([])
  })
})
