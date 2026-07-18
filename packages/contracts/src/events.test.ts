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
  it('validates skill_loaded payloads', () => {
    const good = { stepId: 's1', runToken: 'step:t:s1:a1', name: 'my-skill', hash: 'abc123' }
    expect(() => PAYLOAD_SCHEMAS.skill_loaded.parse(good)).not.toThrow()
    expect(() => PAYLOAD_SCHEMAS.skill_loaded.parse({ ...good, hash: '' })).toThrow()
  })
  it('memory_deleted rejects a path-unsafe id or scope (no poison event)', () => {
    const good = { id: 'auth', scope: 'project', author: { source: 'cli' } }
    expect(() => PAYLOAD_SCHEMAS.memory_deleted.parse(good)).not.toThrow()
    expect(() => PAYLOAD_SCHEMAS.memory_deleted.parse({ ...good, scope: '../x' })).toThrow()
    expect(() => PAYLOAD_SCHEMAS.memory_deleted.parse({ ...good, id: '../x' })).toThrow()
  })
  it('split_proposed and split_resolved payloads validate; split_resolved pins RunOutcome + scoped notes', () => {
    expect(PAYLOAD_SCHEMAS.split_proposed.safeParse({
      splitId: 'split:step:t1:s1:a1:call_1', taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', childTaskId: 't1.s1.call_1',
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.split_resolved.safeParse({
      splitId: 'x', childTaskId: 'c', outcome: 'done', summary: 's',
      notes: [{ id: 'finding-a', scope: 'project' }],
    }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.split_resolved.safeParse({
      splitId: 'x', childTaskId: 'c', outcome: 'success', summary: 's', notes: [],
    }).success).toBe(false) // SignalOutcome is NOT a RunOutcome
    expect(PAYLOAD_SCHEMAS.split_resolved.safeParse({
      splitId: 'x', childTaskId: 'c', outcome: 'done', summary: 's', notes: ['finding-a'],
    }).success).toBe(false) // bare note ids rejected — notes are (id, scope) pairs
  })

  it('plan_approved requires approval provenance', () => {
    const base = { taskId: 't1', version: 1, approvedAt: '2026-07-19T00:00:00Z' }
    expect(PAYLOAD_SCHEMAS.plan_approved.safeParse(base).success).toBe(false)
    expect(PAYLOAD_SCHEMAS.plan_approved.safeParse({ ...base, approvedBy: 'human' }).success).toBe(true)
    expect(PAYLOAD_SCHEMAS.plan_approved.safeParse({ ...base, approvedBy: 'policy', ruleIndex: 0 }).success).toBe(true)
  })
})
