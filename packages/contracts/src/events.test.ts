import { describe, expect, it } from 'bun:test'
import { EventInput, EventKind, PAYLOAD_SCHEMAS } from './events'

describe('events', () => {
  it('has a payload schema for every kind', () => {
    for (const kind of EventKind.options) {
      expect(PAYLOAD_SCHEMAS[kind]).toBeDefined()
    }
  })
  it('parses a valid input envelope', () => {
    const input: EventInput = {
      taskId: 't1', stepId: null, runToken: null,
      kind: 'task_status_changed',
      payload: { taskId: 't1', from: 'draft', to: 'awaiting_approval' },
    }
    expect(EventInput.parse(input)).toEqual(input)
  })
  it('payload schemas reject wrong shapes', () => {
    expect(() => PAYLOAD_SCHEMAS.plan_approved.parse({})).toThrow()
    expect(() =>
      PAYLOAD_SCHEMAS.task_status_changed.parse({ taskId: 't1', from: 'draft', to: 'not_a_status' }),
    ).toThrow()
  })
})
