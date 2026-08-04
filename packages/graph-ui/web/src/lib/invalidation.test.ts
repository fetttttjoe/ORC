import { describe, expect, it } from 'bun:test'
import { invalidations } from './invalidation'

// parentage resolver stands in for the graph's child edge
const noParent = () => null
const parentIs = (p: string) => () => p

describe('invalidations (SSE summary → query-cache keys)', () => {
  it('working noise invalidates nothing — it arrives at agent-loop cadence', () => {
    for (const kind of ['tool_call', 'tool_result', 'operation_started', 'operation_completed', 'agent_call', 'skill_loaded'])
      expect(invalidations({ kind, taskId: 't1', noteRef: null }, noParent)).toEqual([])
  })

  it('a state change touches its task, and a child touches the parent too', () => {
    expect(invalidations({ kind: 'step_completed', taskId: 't1', noteRef: null }, noParent)).toEqual([
      ['task', 't1'],
      ['node', 't1'],
    ])
    expect(invalidations({ kind: 'step_completed', taskId: 'child', noteRef: null }, parentIs('t1'))).toEqual([
      ['task', 'child'],
      ['node', 'child'],
      ['task', 't1'],
      ['node', 't1'],
    ])
  })

  // RunMonitor, DetailTab and RequestTab all key a task by qk.node, not qk.task. Emitting only
  // the `task` family left a live run's step statuses, iteration count and spend frozen at the
  // value they had when the panel mounted — nothing threw, the numbers just stopped moving.
  it('a task change invalidates BOTH spellings of that task', () => {
    const keys = invalidations({ kind: 'step_started', taskId: 't1', noteRef: null }, noParent)
    expect(keys).toContainEqual(['task', 't1'])
    expect(keys).toContainEqual(['node', 't1'])
  })

  it('a note write touches the note node; model discovery touches the catalog', () => {
    expect(invalidations({ kind: 'memory_written', taskId: null, noteRef: 'note:project x' }, noParent)).toEqual([['node', 'note:project x']])
    expect(invalidations({ kind: 'models_discovered', taskId: null, noteRef: null }, noParent)).toEqual([['models']])
  })
})
