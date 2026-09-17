import { describe, expect, it } from 'bun:test'
import { invalidations } from './invalidation'
import { EVENT_KIND } from '@orc/contracts'

// parentage resolver stands in for the graph's child edge
const noParent = () => null
const parentIs = (p: string) => () => p

describe('invalidations (SSE summary → query-cache keys)', () => {
  it('working noise invalidates nothing — it arrives at agent-loop cadence', () => {
    for (const kind of ['tool_call', 'tool_result', 'operation_started', 'operation_completed', 'agent_call', 'skill_loaded'])
      expect(invalidations({ kind, taskId: 't1', noteRef: null }, noParent)).toEqual([])
  })

  it('a state change touches its task, and a child touches the parent too', () => {
    expect(invalidations({ kind: EVENT_KIND.step_completed, taskId: 't1', noteRef: null }, noParent)).toEqual([
      ['task', 't1'],
      ['node', 't1'],
    ])
    expect(invalidations({ kind: EVENT_KIND.step_completed, taskId: 'child', noteRef: null }, parentIs('t1'))).toEqual([
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
    const keys = invalidations({ kind: EVENT_KIND.step_started, taskId: 't1', noteRef: null }, noParent)
    expect(keys).toContainEqual(['task', 't1'])
    expect(keys).toContainEqual(['node', 't1'])
  })

  it('a note write touches the note node; model discovery touches the catalog', () => {
    expect(invalidations({ kind: EVENT_KIND.memory_written, taskId: null, noteRef: 'note:project x' }, noParent)).toContainEqual(['node', 'note:project x'])
    expect(invalidations({ kind: EVENT_KIND.models_discovered, taskId: null, noteRef: null }, noParent)).toEqual([['models']])
  })

  // A heal rewrites a note and CLEARS its drift, but the drift chip reads corpus health, not the
  // note — so emitting only qk.node left the ratio the write just improved stale until
  // ConsoleHeader's 15s poll came round. The SSE stream already carries these events; the reading
  // they change has to ride it.
  it('an event that changes the read model refreshes corpus health', () => {
    for (const kind of ['memory_written', 'memory_verified', 'memory_deleted'])
      expect(invalidations({ kind, taskId: null, noteRef: null }, noParent)).toContainEqual(['health'])
  })

  // A read moves `hits`, never currency — refetching health on every preload would put the whole
  // corpus probe on the agent-loop's cadence, which is the one thing STATE_CHANGE exists to avoid.
  it('a memory READ leaves corpus health alone', () => {
    expect(invalidations({ kind: EVENT_KIND.memory_accessed, taskId: null, noteRef: 'note:project x' }, noParent)).not.toContainEqual(['health'])
  })
})
