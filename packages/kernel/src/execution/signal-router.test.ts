import { describe, expect, it } from 'bun:test'
import type { EventRecord } from '@orc/contracts'
import { composeSplitResult } from './signal-router'

const split = { splitId: 'sp1', taskId: 'p', stepId: 's1', runToken: 'rt', childTaskId: 'c1', resolved: false }
const evt = (over: Partial<EventRecord>): EventRecord =>
  ({ seq: 1, taskId: 'c1', stepId: null, runToken: null, kind: 'task_created', payload: {}, usage: null, ts: 'T', ...over })
const childTask = (id: string, parentId: string) => evt({
  taskId: id,
  payload: { task: { id, parentId, type: 'split', title: id, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 1, createdAt: 'T' } },
})

describe('composeSplitResult', () => {
  it('done: joins terminal-step summaries; collects subtree note (id, scope) pairs', () => {
    const events: EventRecord[] = [
      childTask('c1', 'p'),
      evt({ seq: 2, kind: 'plan_proposed', payload: { plan: { taskId: 'c1', version: 1, strategyRef: 'split', costEstimateUSD: null, steps: [
        { id: 'w1', role: 'worker', title: 'w1', instructions: 'x', executorRef: 'e', modelRef: 'f/m', skillRefs: [], toolRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn: [] },
        { id: 'w2', role: 'worker', title: 'w2', instructions: 'x', executorRef: 'e', modelRef: 'f/m', skillRefs: [], toolRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn: ['w1'] },
      ] } } }),
      evt({ seq: 3, kind: 'step_started', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', attempt: 1 } }),
      evt({ seq: 4, kind: 'step_completed', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', summary: 'first' } }),
      evt({ seq: 5, kind: 'step_started', stepId: 'w2', runToken: 'rt-w2', payload: { stepId: 'w2', runToken: 'rt-w2', attempt: 1 } }),
      evt({ seq: 6, kind: 'step_completed', stepId: 'w2', runToken: 'rt-w2', payload: { stepId: 'w2', runToken: 'rt-w2', summary: 'second' } }),
      evt({ seq: 7, kind: 'task_status_changed', payload: { taskId: 'c1', from: 'running', to: 'done' } }),
      evt({ seq: 8, taskId: null, kind: 'memory_written', payload: { note: { id: 'finding', scope: 'project', title: 'F', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' }, author: { source: 'agent', taskId: 'c1' } } }),
      evt({ seq: 9, taskId: null, kind: 'memory_written', payload: { note: { id: 'other', scope: 'project', title: 'O', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' }, author: { source: 'agent', taskId: 'unrelated' } } }),
    ]
    const r = composeSplitResult(events, split)
    expect(r).toEqual({
      splitId: 'sp1', childTaskId: 'c1', outcome: 'done',
      summary: 'second',                       // w2 is the only terminal step (nothing depends on it)
      notes: [{ id: 'finding', scope: 'project' }],
    })
  })
  it('blocked: failing step message; cancelled: fixed summary', () => {
    const blocked = composeSplitResult([
      childTask('c1', 'p'),
      evt({ seq: 2, kind: 'step_started', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', attempt: 1 } }),
      evt({ seq: 3, kind: 'step_failed', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', class: 'agent_error', message: 'nope' } }),
      evt({ seq: 4, kind: 'task_status_changed', payload: { taskId: 'c1', from: 'running', to: 'blocked' } }),
    ], split)
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.summary).toBe('nope')
    const cancelled = composeSplitResult([
      childTask('c1', 'p'),
      evt({ seq: 2, kind: 'task_status_changed', payload: { taskId: 'c1', from: 'running', to: 'cancelled' } }),
    ], split)
    expect(cancelled).toMatchObject({ outcome: 'cancelled', summary: 'cancelled' })
  })
})
