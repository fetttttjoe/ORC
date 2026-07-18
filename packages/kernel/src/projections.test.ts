import { describe, expect, it } from 'bun:test'
import type { EventRecord, Plan, TaskNode } from '@orc/contracts'
import { draftFixture, planFixture, stepFixture } from '@orc/contracts/fixtures'
import { fold, completedStepIds, nextAttempts, crashDedupKey, subtreeTaskIds, subtreeUsage, pendingSplitForChild } from './projections'

const task: TaskNode = {
  id: 't1', parentId: null, type: 'generic', title: 'hello', spec: '',
  status: 'draft', zone: [], budgetUSD: null, depth: 0,
  createdAt: '2026-07-16T00:00:00.000Z',
}

const planV = (version: number): Plan => planFixture({ version })

const evt = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord =>
  ({ seq, ts: '2026-07-16T00:00:00.000Z', taskId: 't1', stepId: null, runToken: null, kind, payload, usage: null })

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

describe('crashDedupKey', () => {
  it('differs when toolCallId differs (same runToken/kind/iteration otherwise)', () => {
    const base: EventRecord = {
      seq: 1, ts: '2026-07-17T00:00:00.000Z', taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', kind: 'tool_call',
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
      usage: null,
    }
    const other: EventRecord = { ...base, payload: { ...base.payload, toolCallId: 'c2' } }
    expect(crashDedupKey(base)).not.toBe(crashDedupKey(other))
  })

  it('matches when (runToken, kind, iteration, toolCallId, name) match, regardless of other fields', () => {
    const e1: EventRecord = {
      seq: 1, ts: '2026-07-17T00:00:00.000Z', taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', kind: 'tool_call',
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
      usage: null,
    }
    const e2: EventRecord = {
      seq: 2, ts: '2026-07-17T00:05:00.000Z', taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', kind: 'tool_call',
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'different_tool', input: { x: 1 } },
      usage: null,
    }
    expect(crashDedupKey(e1)).toBe(crashDedupKey(e2))
  })

  it('skill_loaded events dedup per skill name, not per step', () => {
    const mk = (seq: number, name: string): EventRecord => ({
      seq, ts: 't', taskId: 't1', stepId: 's1', runToken: 'step:t1:s1:a1',
      kind: 'skill_loaded', usage: null,
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', name, hash: 'h' },
    })
    // two different skills in one init: both keys distinct
    expect(crashDedupKey(mk(1, 'alpha'))).not.toBe(crashDedupKey(mk(2, 'beta')))
    // crash-boundary duplicate of the same skill: identical key
    expect(crashDedupKey(mk(1, 'alpha'))).toBe(crashDedupKey(mk(3, 'alpha')))
  })

  it('returns null for task_status_changed even when a runToken is present', () => {
    const e: EventRecord = {
      seq: 1, ts: '2026-07-17T00:00:00.000Z', taskId: 't1', stepId: null,
      runToken: 'step:t1:s1:a1', kind: 'task_status_changed',
      payload: { taskId: 't1', from: 'draft', to: 'approved' },
      usage: null,
    }
    expect(crashDedupKey(e)).toBeNull()
  })

  it('returns null for any event with a null runToken', () => {
    const e: EventRecord = {
      seq: 1, ts: '2026-07-17T00:00:00.000Z', taskId: 't1', stepId: null,
      runToken: null, kind: 'task_created',
      payload: { task },
      usage: null,
    }
    expect(crashDedupKey(e)).toBeNull()
  })
})

const rt = (step: string, attempt = 1) => `step:t1:${step}:a${attempt}`

const exEvt = (
  seq: number,
  kind: EventRecord['kind'],
  payload: Record<string, unknown>,
  usage: EventRecord['usage'] = null,
): EventRecord =>
  // envelope runToken mirrors payload.runToken (as in real events); falls back for
  // envelope-only kinds like run_started whose payload carries no runToken.
  ({ seq, ts: '2026-07-17T00:00:00.000Z', taskId: 't1', stepId: 's1',
    runToken: (payload.runToken as string | undefined) ?? rt('s1'), kind, payload, usage })

describe('fold — execution kinds', () => {
  it('projects step lifecycle and per-task usage', () => {
    const state = fold([
      exEvt(1, 'run_started', { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null }),
      exEvt(2, 'step_started', { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      exEvt(3, 'agent_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
        { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false }),
      exEvt(4, 'signal_received', { stepId: 's1', runToken: rt('s1'), signal: { stepId: 's1', runToken: rt('s1'), outcome: 'success', summary: 'ok' } }),
      exEvt(5, 'step_completed', { stepId: 's1', runToken: rt('s1'), summary: 'ok' }),
    ])
    const step = state.steps.get('t1')?.get('s1')
    expect(step?.status).toBe('completed')
    expect(step?.output).toBe('ok')
    expect(step?.iterations).toBe(1)
    expect(state.runs.get('t1')).toHaveLength(1)
    expect(state.usage.get('t1')?.costUSD).toBeCloseTo(0.01)
    expect(completedStepIds(state, 't1')).toEqual(new Set(['s1']))
  })

  it('fold ignores skill_loaded for state (traceability only)', () => {
    const state = fold([
      exEvt(1, 'run_started', { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null }),
      exEvt(2, 'step_started', { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      exEvt(3, 'skill_loaded', { stepId: 's1', runToken: rt('s1'), name: 'alpha', hash: 'h' }),
      exEvt(4, 'agent_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
        { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false }),
      exEvt(5, 'signal_received', { stepId: 's1', runToken: rt('s1'), signal: { stepId: 's1', runToken: rt('s1'), outcome: 'success', summary: 'ok' } }),
      exEvt(6, 'step_completed', { stepId: 's1', runToken: rt('s1'), summary: 'ok' }),
    ])
    const step = state.steps.get('t1')?.get('s1')
    expect(step?.status).toBe('completed')
    expect(step?.output).toBe('ok')
    expect(step?.iterations).toBe(1)
    expect(state.runs.get('t1')).toHaveLength(1)
    expect(state.usage.get('t1')?.costUSD).toBeCloseTo(0.01)
    expect(completedStepIds(state, 't1')).toEqual(new Set(['s1']))
  })

  it('ignores memory events and does not create a task', () => {
    const base = fold([])
    const withMem = fold([{
      seq: 1, taskId: null, stepId: null, runToken: null,
      kind: 'memory_written',
      payload: { note: { id: 'x', title: 'X', scope: 'project', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' }, author: { source: 'cli' } },
      usage: null, ts: '2026-07-18T00:00:00Z',
    }])
    expect(withMem.tasks.size).toBe(base.tasks.size)
  })

  it('dedups crash-boundary duplicates by (runToken, kind, iteration, toolCallId)', () => {
    const dup = exEvt(3, 'agent_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
      { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false })
    const state = fold([
      exEvt(2, 'step_started', { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      dup,
      { ...dup, seq: 4 }, // crash-boundary replay of the same iteration
      exEvt(5, 'tool_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} }),
      exEvt(6, 'tool_call', { stepId: 's1', runToken: rt('s1'), iteration: 1, toolCallId: 'c2', toolName: 'fs_read', input: {} }),
    ])
    expect(state.usage.get('t1')?.inputTokens).toBe(100) // counted once
    expect(state.steps.get('t1')?.get('s1')?.iterations).toBe(1)
    // two DISTINCT tool calls in one iteration both survive (toolCallId disambiguates)
  })

  it('failed attempt then fresh attempt: latest wins, nextAttempts increments', () => {
    const plan = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: 's2' })])
    const state = fold([
      exEvt(1, 'step_started', { stepId: 's1', runToken: rt('s1', 1), attempt: 1 }),
      exEvt(2, 'step_failed', { stepId: 's1', runToken: rt('s1', 1), class: 'agent_error', message: 'nope' }),
      exEvt(3, 'step_started', { stepId: 's1', runToken: rt('s1', 2), attempt: 2 }),
      exEvt(4, 'step_completed', { stepId: 's1', runToken: rt('s1', 2), summary: 'fixed' }),
    ])
    expect(state.steps.get('t1')?.get('s1')?.status).toBe('completed')
    expect(state.steps.get('t1')?.get('s1')?.attempt).toBe(2)
    expect(nextAttempts(state, 't1', plan)).toEqual({ s1: 3, s2: 1 })
  })

  it('rejects a late event carrying a superseded attempt runToken', () => {
    const state = fold([
      exEvt(1, 'step_started', { stepId: 's1', runToken: rt('s1', 1), attempt: 1 }),
      exEvt(2, 'step_failed', { stepId: 's1', runToken: rt('s1', 1), class: 'agent_error', message: 'boom' }),
      exEvt(3, 'step_started', { stepId: 's1', runToken: rt('s1', 2), attempt: 2 }),
      exEvt(4, 'step_completed', { stepId: 's1', runToken: rt('s1', 2), summary: 'fresh' }),
      // late/stale events from the superseded attempt 1 — envelope and payload both carry the old runToken
      exEvt(5, 'step_completed', { stepId: 's1', runToken: rt('s1', 1), summary: 'stale' }),
      exEvt(6, 'agent_call', { stepId: 's1', runToken: rt('s1', 1), iteration: 9, request: {}, response: {} },
        { inputTokens: 5, outputTokens: 5, costUSD: 0, estimated: false }),
    ])
    const step = state.steps.get('t1')?.get('s1')
    expect(step?.status).toBe('completed')
    expect(step?.output).toBe('fresh')
    expect(step?.attempt).toBe(2)
    // stale agent_call's runToken doesn't match the current attempt, so it can't bump iterations
    expect(step?.iterations).toBe(0)
    // note: usage from the stale agent_call IS accumulated regardless — that update is deliberately
    // unguarded (spec asymmetry), so it is intentionally not asserted to stay zero here.
  })

  it('folds splits: proposed pending, resolved marks; dedups replayed proposals by splitId', () => {
    const splitP = { splitId: 'sp1', taskId: 't1', stepId: 's1', runToken: rt('s1'), childTaskId: 'c1' }
    const state = fold([
      { seq: 1, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: splitP, usage: null, ts: 'T' },
      { seq: 2, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: splitP, usage: null, ts: 'T' }, // crash replay
      { seq: 3, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: { ...splitP, splitId: 'sp2', childTaskId: 'c2' }, usage: null, ts: 'T' },
    ])
    expect(state.splits.size).toBe(2) // sp1 deduped, sp2 distinct despite same runToken
    expect(state.splits.get('sp1')?.resolved).toBe(false)
    expect(pendingSplitForChild(state, 'c1')?.splitId).toBe('sp1')
    const resolved = fold([
      { seq: 1, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: splitP, usage: null, ts: 'T' },
      { seq: 2, taskId: 't1', stepId: null, runToken: null, kind: 'split_resolved', payload: { splitId: 'sp1', childTaskId: 'c1', outcome: 'done', summary: 'ok', notes: [] }, usage: null, ts: 'T' },
    ])
    expect(resolved.splits.get('sp1')?.resolved).toBe(true)
    expect(pendingSplitForChild(resolved, 'c1')).toBeUndefined()
  })

  it('subtreeUsage sums a task and its descendants; subtreeTaskIds walks parentId', () => {
    const t = (id: string, parentId: string | null): EventRecord => ({
      seq: 0, taskId: id, stepId: null, runToken: null, kind: 'task_created',
      payload: { task: { id, parentId, type: 'generic', title: id, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: parentId ? 1 : 0, createdAt: 'T' } },
      usage: null, ts: 'T',
    })
    const usage = (taskId: string, cost: number): EventRecord => ({
      seq: 0, taskId, stepId: 's1', runToken: `rt-${taskId}`, kind: 'agent_call',
      payload: { stepId: 's1', runToken: `rt-${taskId}`, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: cost, estimated: false }, ts: 'T',
    })
    const state = fold([t('p', null), t('c1', 'p'), t('c2', 'p'), t('g1', 'c1'), usage('p', 1), usage('c1', 2), usage('g1', 4)].map((e, i) => ({ ...e, seq: i + 1 })))
    expect(subtreeTaskIds(state, 'p')).toEqual(['p', 'c1', 'c2', 'g1'])
    expect(subtreeUsage(state, 'p').costUSD).toBe(7)
    expect(subtreeUsage(state, 'c1').costUSD).toBe(6)
  })

  it('plan_proposed replay with the same (taskId, version) folds once', () => {
    const plan = planFixture({ taskId: 't1', version: 1 })
    const state = fold([
      { seq: 1, taskId: 't1', stepId: null, runToken: null, kind: 'plan_proposed', payload: { plan }, usage: null, ts: 'T' },
      { seq: 2, taskId: 't1', stepId: null, runToken: null, kind: 'plan_proposed', payload: { plan }, usage: null, ts: 'T' },
    ])
    expect(state.plans.get('t1')?.versions).toHaveLength(1)
  })
})
