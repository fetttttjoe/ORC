import { describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, ScopeType, type EventRecord } from '@orc/contracts'
import { authorFixture, eventFixture, taskFixture, TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { modelOf } from '../test-helpers'
import { timeline } from './timeline'

const ev = (seq: number, kind: EventRecord['kind'], taskId: string | null, payload: Record<string, unknown> = {}): EventRecord =>
  eventFixture({ seq, kind, taskId, payload })
const exchange = { user: 'q', assistant: 'a', toolCalls: [], modelRef: 'x/y' }
const project = { type: ScopeType.project } as const
const task = (id: string) => ({ type: ScopeType.task, id, subtree: false }) as const

describe('timeline view', () => {
  const events = [ev(1, EVENT_KIND.copilot_exchange, null, exchange), ...Array.from({ length: 500 }, (_, i) => ev(i + 2, EVENT_KIND.tool_call, 't1', { toolName: 'x', input: {} }))]

  it('finds an exchange buried under 500 later events, because the kind filter runs before the limit', () => {
    const rows = timeline.read(modelOf(events), { scope: project, kinds: [EVENT_KIND.copilot_exchange], limit: 20 })
    expect(rows?.map(r => r.seq)).toEqual([1])
  })

  it('pages backward exclusively', () => {
    expect(timeline.read(modelOf(events), { scope: project, beforeSeq: 3, limit: 10 })?.map(r => r.seq)).toEqual([1, 2])
  })

  // the tail is taken from the MATCHING events, so a limit spent on non-matching traffic returns
  // an empty pane
  it('fills the limit with the newest matching events, not the newest events', () => {
    const m = modelOf([
      ev(1, EVENT_KIND.copilot_exchange, null, exchange),
      ev(2, EVENT_KIND.copilot_exchange, null, exchange),
      ev(3, EVENT_KIND.copilot_exchange, null, exchange),
      ev(4, EVENT_KIND.tool_call, 't1', { toolName: 'x', input: {} }),
      ev(5, EVENT_KIND.tool_call, 't1', { toolName: 'x', input: {} }),
    ])
    expect(timeline.read(m, { scope: project, kinds: [EVENT_KIND.copilot_exchange], limit: 2 })?.map(r => r.seq)).toEqual([2, 3])
  })

  it('carries the chat and the door of every row', () => {
    const rows = timeline.read(modelOf([eventFixture({ seq: 1, kind: EVENT_KIND.tool_call, chatId: 'c1', door: Door.web, payload: { toolName: 'x', input: {} } })]), { scope: project })
    expect(rows?.at(0)).toMatchObject({ chatId: 'c1', door: Door.web })
  })
})

// The task scope answers exactly what the removed `taskId` param answered — including its one hard
// case: a project-scoped memory row (envelope taskId null) belongs to the task that WROTE it.
describe('a task scope', () => {
  const author = authorFixture({ taskId: 'C' })
  const m = modelOf([
    eventFixture({ seq: 1, kind: EVENT_KIND.task_created, taskId: 'C', payload: { task: taskFixture({ id: 'C', workspaceId: TEST_WORKSPACE_ID }) } }),
    eventFixture({ seq: 2, kind: EVENT_KIND.task_created, taskId: 'D', payload: { task: taskFixture({ id: 'D', parentId: 'C', depth: 1, workspaceId: TEST_WORKSPACE_ID }) } }),
    ev(3, EVENT_KIND.tool_call, 'C', { toolName: 'x', input: {} }),
    ev(4, EVENT_KIND.tool_call, 'D', { toolName: 'x', input: {} }),
    ev(5, EVENT_KIND.memory_written, null, { note: { id: 'n', title: 'n', scope: 'project' }, author }),
    ev(6, EVENT_KIND.memory_written, null, { note: { id: 'm', title: 'm', scope: 'project' }, author: authorFixture() }),
  ])

  it('admits the task rows and the memory row its author wrote, and nothing else', () => {
    expect(timeline.read(m, { scope: task('C') })?.map(r => r.seq)).toEqual([1, 3, 5])
  })

  it('leaves the subtree out unless the caller asked for it', () => {
    expect(timeline.read(m, { scope: { type: ScopeType.task, id: 'C', subtree: true } })?.map(r => r.seq)).toEqual([1, 2, 3, 4, 5])
  })

  // a poller asking "everything after seq N of these kinds" must get the newest MATCHING rows,
  // not the newest `limit` in-scope events of which none match
  it('applies sinceSeq and kinds before the tail', () => {
    const polled = modelOf([
      eventFixture({ seq: 1, kind: EVENT_KIND.task_created, taskId: 'C', payload: { task: taskFixture({ id: 'C', workspaceId: TEST_WORKSPACE_ID }) } }),
      ev(2, EVENT_KIND.tool_call, 'C', { toolName: 'x', input: {} }),
      ev(3, EVENT_KIND.tool_call, 'C', { toolName: 'x', input: {} }),
      ev(4, EVENT_KIND.tool_call, 'C', { toolName: 'x', input: {} }),
      ev(5, EVENT_KIND.tool_result, 'C', { toolName: 'x', output: 'ok', isError: false }),
      ev(6, EVENT_KIND.tool_result, 'C', { toolName: 'x', output: 'ok', isError: false }),
    ])
    expect(timeline.read(polled, { scope: task('C'), sinceSeq: 2, kinds: [EVENT_KIND.tool_call], limit: 2 })?.map(r => r.seq)).toEqual([3, 4])
  })

  it('answers a workspace scope from the task tree', () => {
    expect(timeline.read(m, { scope: { type: ScopeType.workspace, id: TEST_WORKSPACE_ID } })?.map(r => r.seq)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('a chat scope', () => {
  const rows = [
    eventFixture({ seq: 1, kind: EVENT_KIND.copilot_exchange, chatId: 'c1', door: Door.web, taskId: null, payload: exchange }),
    eventFixture({ seq: 2, kind: EVENT_KIND.copilot_exchange, chatId: 'c2', door: Door.web, taskId: null, payload: exchange }),
  ]
  // the noise that used to push a conversation out of a fixed tail: the chat filter runs first
  const noise = Array.from({ length: 400 }, (_, i) => ev(i + 3, EVENT_KIND.tool_call, 't1', { toolName: 'x', input: {} }))
  const m = modelOf([...rows, ...noise])

  it('returns only that chat rows, however much followed them', () => {
    expect(timeline.read(m, { scope: { type: ScopeType.chat, id: 'c1' } })?.map(r => r.seq)).toEqual([1])
  })
})

describe('what one event stales', () => {
  const m = modelOf([
    eventFixture({ seq: 1, kind: EVENT_KIND.task_created, taskId: 'C', payload: { task: taskFixture({ id: 'C', workspaceId: TEST_WORKSPACE_ID }) } }),
  ])

  it('names the project, the workspace, the task and the chat the event belongs to', () => {
    const e = eventFixture({ seq: 2, kind: EVENT_KIND.tool_call, taskId: 'C', chatId: 'c1', door: Door.web, payload: { toolName: 'x', input: {} } })
    expect(timeline.touches(e, m)).toEqual([
      { scope: project },
      { scope: { type: ScopeType.workspace, id: TEST_WORKSPACE_ID } },
      { scope: task('C') },
      { scope: { type: ScopeType.chat, id: 'c1' } },
    ])
  })

  it('names no chat when the event belongs to none, and no task when it names none', () => {
    expect(timeline.touches(ev(3, EVENT_KIND.models_discovered, null, { providerId: 'a', models: ['m'] }), m)).toEqual([{ scope: project }])
  })

  // A chat pane holding its own transcript must not refetch on every other chat's traffic.
  it('never matches another chat held query', () => {
    const e = eventFixture({ seq: 4, kind: EVENT_KIND.copilot_exchange, chatId: 'c1', door: Door.web, taskId: null, payload: exchange })
    expect(timeline.touches(e, m)).not.toContainEqual({ scope: { type: ScopeType.chat, id: 'c2' } })
  })
})
