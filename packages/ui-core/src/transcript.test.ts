import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventKind } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { foldTranscript } from './transcript'

const T = 't1'
const base = { taskId: T, stepId: 's1', runToken: 'r1' }
const ev = (kind: EventKind, payload: Record<string, unknown>, seq: number, over: Record<string, unknown> = {}) =>
  eventFixture({ kind, payload, seq, ...base, ...over })

describe('foldTranscript', () => {
  it('orders messages, pairs tools by toolCallId, pairs Q&A by topic, ends with the signal', () => {
    const events = [
      ev(EVENT_KIND.agent_call, { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: { text: 'thinking', toolCalls: [] } }, 1),
      ev(EVENT_KIND.tool_call, { stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'fs_write', input: { path: 'a' } }, 2),
      ev(EVENT_KIND.tool_result, { stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c1', toolName: 'fs_write', output: { ok: true }, isError: false }, 3),
      ev(EVENT_KIND.feedback_requested, { question: 'proceed?', topic: 'top1' }, 4),
      ev(EVENT_KIND.feedback_provided, { topic: 'top1', text: 'yes', author: { source: 'cli' } }, 5),
      ev(EVENT_KIND.agent_call, { stepId: 's1', runToken: 'r1', iteration: 2, request: {}, response: { text: '', toolCalls: [] } }, 6), // empty text -> no item
      ev(EVENT_KIND.signal_received, { stepId: 's1', runToken: 'r1', signal: { stepId: 's1', runToken: 'r1', outcome: 'success', summary: 'done' } }, 7),
    ]
    const items = foldTranscript(events, T)
    expect(items.map(i => i.kind)).toEqual(['message', 'tool', 'question', 'signal'])
    expect(items[0]).toMatchObject({ text: 'thinking', iteration: 1 })
    expect(items[1]).toMatchObject({ toolName: 'fs_write', output: { ok: true }, isError: false })
    expect(items[2]).toMatchObject({ question: 'proceed?', answer: 'yes' })
    expect(items[3]).toMatchObject({ outcome: 'success', summary: 'done' })
  })

  it('a dangling tool_call keeps output null; foreign tasks and steps never leak in', () => {
    const events = [
      ev(EVENT_KIND.tool_call, { stepId: 's1', runToken: 'r1', iteration: 1, toolCallId: 'c9', toolName: 'fs_read', input: {} }, 1),
      ev(EVENT_KIND.agent_call, { stepId: 's2', runToken: 'r2', iteration: 1, request: {}, response: { text: 'other step' } }, 2, { stepId: 's2' }),
      ev(EVENT_KIND.agent_call, { stepId: 's9', runToken: 'r9', iteration: 1, request: {}, response: { text: 'other task' } }, 3, { taskId: 'other' }),
    ]
    expect(foldTranscript(events, T, 's1')).toEqual([
      { kind: 'tool', iteration: 1, stepId: 's1', toolName: 'fs_read', input: {}, output: null, isError: false },
    ])
    expect(foldTranscript(events, T).map(i => i.kind)).toEqual(['tool', 'message'])
  })
})
