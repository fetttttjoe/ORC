import { describe, expect, it } from 'bun:test'
import type { EventRecord, Plan, TaskNode } from '@orc/contracts'
import { fold } from './projections'

const task: TaskNode = {
  id: 't1', parentId: null, type: 'generic', title: 'hello', spec: '',
  status: 'draft', zone: [], budgetUSD: null, depth: 0,
  createdAt: '2026-07-16T00:00:00.000Z',
}

const planV = (version: number): Plan => ({
  taskId: 't1', version, strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 'hello', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'm', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
  }],
})

const evt = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord =>
  ({ seq, ts: '2026-07-16T00:00:00.000Z', taskId: 't1', stepId: null, runToken: null, kind, payload })

describe('fold', () => {
  it('replays a full lifecycle into consistent state', () => {
    const state = fold([
      evt(1, 'task_created', { task }),
      evt(2, 'plan_proposed', { plan: planV(1) }),
      evt(3, 'task_status_changed', { taskId: 't1', from: 'draft', to: 'awaiting_approval' }),
      evt(4, 'plan_edited', { plan: planV(2) }),
      evt(5, 'plan_approved', { taskId: 't1', version: 2, approvedAt: '2026-07-16T01:00:00.000Z' }),
      evt(6, 'task_status_changed', { taskId: 't1', from: 'awaiting_approval', to: 'approved' }),
    ])
    expect(state.tasks.get('t1')?.status).toBe('approved')
    expect(state.plans.get('t1')?.versions.map(p => p.version)).toEqual([1, 2])
    expect(state.plans.get('t1')?.approvedVersion).toBe(2)
  })
  it('is pure: same input, same output', () => {
    const events = [evt(1, 'task_created', { task })]
    expect(fold(events)).toEqual(fold(events))
  })
  it('empty log folds to empty state', () => {
    const state = fold([])
    expect(state.tasks.size).toBe(0)
    expect(state.plans.size).toBe(0)
  })
})
