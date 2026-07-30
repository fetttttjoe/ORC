import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventRecord, type Plan, type TaskNode } from '@orc/contracts'
import { eventFixture, draftFixture, planFixture, stepFixture } from '@orc/contracts/fixtures'
import { emptyFold, fold, foldInto, subtreeOutcome, completedStepIds, nextAttempts, crashDedupKey, stepUsage, subtreeTaskIds, subtreeUsage, pendingSplitForChild, remainingBudget, inheritedCwd, runCwd, taskChangedPaths, taskNoteWrites, taskVerifiedNotes } from './projections'

const task: TaskNode = {
  id: 't1', parentId: null, type: 'generic', title: 'hello', spec: '',
  status: 'draft', zone: [], budgetUSD: null, depth: 0,
  createdAt: '2026-07-16T00:00:00.000Z',
}

const planV = (version: number): Plan => planFixture({ version })

const evt = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord =>
  eventFixture({ seq, ts: '2026-07-16T00:00:00.000Z', kind, payload })

// A step folded `running` is a LIVE attempt only while the run is live. Once the task settles, the
// fold says `running` only because the step died between its last checkpoint and step_failed — so
// reusing the attempt re-attached to a DEAD workflow, which replays its stored error and makes
// every `orc retry` fail identically, forever.
describe('nextAttempts and an orphaned running step', () => {
  const plan = { steps: [{ id: 'a' }, { id: 'b' }] } as Parameters<typeof nextAttempts>[2]
  const stateWith = (status: string, stepStatus: string) => {
    const st = emptyFold().state
    st.tasks.set('t1', { id: 't1', parentId: null, type: 'generic', title: 'T', spec: '', status, zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-27T00:00:00.000Z' } as never)
    st.steps.set('t1', new Map([['a', { status: stepStatus, attempt: 2 } as never]]))
    return st
  }

  it('reuses the attempt while the run is LIVE, so the workflow id re-attaches', () => {
    expect(nextAttempts(stateWith('running', 'running'), 't1', plan).a).toBe(2)
  })

  it('gives a fresh attempt once the task has settled — the running step is orphaned', () => {
    expect(nextAttempts(stateWith('blocked', 'running'), 't1', plan).a).toBe(3)
  })

  it('a step with no history starts at 1 either way', () => {
    expect(nextAttempts(stateWith('blocked', 'running'), 't1', plan).b).toBe(1)
  })
})

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
      seq: 1, ts: '2026-07-17T00:00:00.000Z', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', kind: 'tool_call',
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
      usage: null,
    }
    const other: EventRecord = { ...base, payload: { ...base.payload, toolCallId: 'c2' } }
    expect(crashDedupKey(base)).not.toBe(crashDedupKey(other))
  })

  it('matches when (runToken, kind, iteration, toolCallId, name) match, regardless of other fields', () => {
    const e1: EventRecord = {
      seq: 1, ts: '2026-07-17T00:00:00.000Z', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', kind: 'tool_call',
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
      usage: null,
    }
    const e2: EventRecord = {
      seq: 2, ts: '2026-07-17T00:05:00.000Z', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1',
      runToken: 'step:t1:s1:a1', kind: 'tool_call',
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'different_tool', input: { x: 1 } },
      usage: null,
    }
    expect(crashDedupKey(e1)).toBe(crashDedupKey(e2))
  })

  it('skill_loaded events dedup per skill name, not per step', () => {
    const mk = (seq: number, name: string): EventRecord => ({
      seq, ts: 't', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1', runToken: 'step:t1:s1:a1',
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
      seq: 1, ts: '2026-07-17T00:00:00.000Z', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null,
      runToken: 'step:t1:s1:a1', kind: 'task_status_changed',
      payload: { taskId: 't1', from: 'draft', to: 'approved' },
      usage: null,
    }
    expect(crashDedupKey(e)).toBeNull()
  })

  it('returns null for any event with a null runToken', () => {
    const e: EventRecord = {
      seq: 1, ts: '2026-07-17T00:00:00.000Z', projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null,
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
  eventFixture({ seq, ts: '2026-07-17T00:00:00.000Z', stepId: 's1',
    runToken: typeof payload.runToken === 'string' ? payload.runToken : rt('s1'), kind, payload, usage })

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
    expect(stepUsage(state, 't1', 's1').costUSD).toBeCloseTo(0.01) // same events, per-step key
    expect(stepUsage(state, 't1', 'ghost').costUSD).toBeNull() // unknown step → zero usage
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

  it('copilot_exchange is traceability-only: folds to no state', () => {
    const state = fold([eventFixture({ kind: EVENT_KIND.copilot_exchange, payload: { user: 'u', assistant: 'a', toolCalls: [], modelRef: 'm/x' } })])
    expect(state.tasks.size).toBe(0)
    expect(state.usage.size).toBe(0)
  })

  it('ignores memory events and does not create a task', () => {
    const base = fold([])
    const withMem = fold([{
      seq: 1, projectId: 'p1', idempotencyKey: null, taskId: null, stepId: null, runToken: null,
      kind: 'memory_written',
      payload: { note: { id: 'x', title: 'X', scope: 'project', categories: [], tags: [], links: [], paths: [], summary: '', body: '' }, author: { source: 'cli' } },
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
      { seq: 1, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: splitP, usage: null, ts: 'T' },
      { seq: 2, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: splitP, usage: null, ts: 'T' }, // crash replay
      { seq: 3, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: { ...splitP, splitId: 'sp2', childTaskId: 'c2' }, usage: null, ts: 'T' },
    ])
    expect(state.splits.size).toBe(2) // sp1 deduped, sp2 distinct despite same runToken
    expect(state.splits.get('sp1')?.resolved).toBe(false)
    expect(pendingSplitForChild(state, 'c1')?.splitId).toBe('sp1')
    const resolved = fold([
      { seq: 1, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind: 'split_proposed', payload: splitP, usage: null, ts: 'T' },
      { seq: 2, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null, runToken: null, kind: 'split_resolved', payload: { splitId: 'sp1', childTaskId: 'c1', outcome: 'done', summary: 'ok', notes: [] }, usage: null, ts: 'T' },
    ])
    expect(resolved.splits.get('sp1')?.resolved).toBe(true)
    expect(pendingSplitForChild(resolved, 'c1')).toBeUndefined()
  })

  it('subtreeUsage sums a task and its descendants; subtreeTaskIds walks parentId', () => {
    const t = (id: string, parentId: string | null): EventRecord => ({
      seq: 0, projectId: 'p1', idempotencyKey: null, taskId: id, stepId: null, runToken: null, kind: 'task_created',
      payload: { task: { id, parentId, type: 'generic', title: id, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: parentId ? 1 : 0, createdAt: 'T' } },
      usage: null, ts: 'T',
    })
    const usage = (taskId: string, cost: number): EventRecord => ({
      seq: 0, projectId: 'p1', idempotencyKey: null, taskId, stepId: 's1', runToken: `rt-${taskId}`, kind: 'agent_call',
      payload: { stepId: 's1', runToken: `rt-${taskId}`, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: cost, estimated: false }, ts: 'T',
    })
    const state = fold([t('p', null), t('c1', 'p'), t('c2', 'p'), t('g1', 'c1'), usage('p', 1), usage('c1', 2), usage('g1', 4)].map((e, i) => ({ ...e, seq: i + 1 })))
    expect(subtreeTaskIds(state, 'p')).toEqual(['p', 'c1', 'c2', 'g1'])
    expect(subtreeUsage(state, 'p').costUSD).toBe(7)
    expect(subtreeUsage(state, 'c1').costUSD).toBe(6)
  })

  it("remainingBudget is the min over the ancestor chain, not just the task's own budget", () => {
    const t = (id: string, parentId: string | null, budgetUSD: number | null): EventRecord => ({
      seq: 0, projectId: 'p1', idempotencyKey: null, taskId: id, stepId: null, runToken: null, kind: 'task_created',
      payload: { task: { id, parentId, type: 'generic', title: id, spec: '', status: 'draft', zone: [], budgetUSD, depth: parentId ? 1 : 0, createdAt: 'T' } },
      usage: null, ts: 'T',
    })
    const usage = (taskId: string, cost: number): EventRecord => ({
      seq: 0, projectId: 'p1', idempotencyKey: null, taskId, stepId: 's1', runToken: `rt-${taskId}`, kind: 'agent_call',
      payload: { stepId: 's1', runToken: `rt-${taskId}`, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: cost, estimated: false }, ts: 'T',
    })
    // parent budget 10, already spent 9 (its own usage) → parent has $1 left. Child budget is 99
    // with zero usage of its own: consulting only the child's row would wrongly report ~99.
    const state = fold([t('p', null, 10), t('c', 'p', 99), usage('p', 9)].map((e, i) => ({ ...e, seq: i + 1 })))
    expect(remainingBudget(state, 'c')).toBe(1)  // capped by the ancestor, not its own huge budget
    expect(remainingBudget(state, 'p')).toBe(1)
    // no budget anywhere in the chain → unconstrained (null)
    const free = fold([t('x', null, null), t('y', 'x', null)].map((e, i) => ({ ...e, seq: i + 1 })))
    expect(remainingBudget(free, 'y')).toBeNull()
  })

  it('runCwd: a split child inherits its PARENT\'s run cwd; a root falls back to the project dir', () => {
    const state = fold([
      evt(1, 'task_created', { task: { ...task, id: 'p' } }),
      evt(2, 'task_created', { task: { ...task, id: 'c', parentId: 'p', depth: 1 } }),
      eventFixture({ seq: 3, ts: '2026-07-16T00:00:00.000Z', taskId: 'p', kind: 'run_started', payload: { planVersion: 1, retryIndex: 0, workflowId: 'w1', cwd: '/tree' } }),
    ])
    expect(runCwd(state, state.tasks.get('c')!, undefined, '/proj')).toBe('/tree')
    expect(runCwd(state, state.tasks.get('p')!, undefined, '/proj')).toBe('/proj')
    expect(runCwd(state, state.tasks.get('c')!, '/explicit', '/proj')).toBe('/explicit')
  })

  it('inheritedCwd: override wins; else the last run that HAD a cwd (skip null history); else fallback', () => {
    const run = (cwd: string | null) => ({ planVersion: 1, retryIndex: 0, workflowId: 'w', cwd })
    expect(inheritedCwd(undefined, undefined, '/proj')).toBe('/proj')          // no runs → fallback
    expect(inheritedCwd([], 'over', '/proj')).toBe('over')                      // override always wins
    expect(inheritedCwd([run(null), run(null)], undefined, '/proj')).toBe('/proj') // all-null history → fallback
    expect(inheritedCwd([run('/repo'), run(null), run(null)], undefined, '/proj')).toBe('/repo') // skip the null poison
    expect(inheritedCwd([run('/repo')], '/override', '/proj')).toBe('/override') // override beats a real history too
  })

  it('plan_proposed replay with the same (taskId, version) folds once', () => {
    const plan = planFixture({ taskId: 't1', version: 1 })
    const state = fold([
      { seq: 1, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null, runToken: null, kind: 'plan_proposed', payload: { plan }, usage: null, ts: 'T' },
      { seq: 2, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null, runToken: null, kind: 'plan_proposed', payload: { plan }, usage: null, ts: 'T' },
    ])
    expect(state.plans.get('t1')?.versions).toHaveLength(1)
  })

  it('folds artifacts by task; distinct paths survive, a replayed receipt folds once', () => {
    const receipt = (seq: number, p: string): EventRecord => ({
      seq, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1',
      runToken: rt('s1'), kind: 'artifact_produced',
      payload: { path: p, sha256: 'a'.repeat(64), size: 1 }, usage: null, ts: 'T',
    })
    const state = fold([receipt(1, 'a.md'), receipt(2, 'b.md'), receipt(3, 'a.md')])
    expect(state.artifacts.get('t1')?.map(a => a.path)).toEqual(['a.md', 'b.md'])
  })

  it('folds operation transitions into replayable journal state', () => {
    const op = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord => ({
      seq, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1',
      runToken: rt('s1'), kind, payload, usage: null, ts: `T${seq}`,
    })
    const id = 'step:t1:s1:a1:model:1'
    const state = fold([
      op(1, 'operation_started', { operationId: id, attempt: 1, operationKind: 'model', name: 'fake/m', before: { q: 1 } }),
      op(2, 'operation_failed', { operationId: id, attempt: 1, error: { message: 'boom' } }),
      op(3, 'operation_started', { operationId: id, attempt: 2, operationKind: 'model', name: 'fake/m', before: { q: 1 } }),
      op(4, 'operation_completed', { operationId: id, attempt: 2, after: { text: 'ok' } }),
    ])
    const node = state.operations.get(id)
    expect(node?.status).toBe('completed')
    expect(node?.attempts).toBe(2)
    expect(node?.after).toEqual({ text: 'ok' })
    expect(node?.startedSeq).toBe(3)
    expect(node?.finishedSeq).toBe(4)

    const unresolved = fold([
      op(1, 'operation_started', { operationId: id, attempt: 1, operationKind: 'model', name: 'fake/m', before: null }),
    ]).operations.get(id)
    expect(unresolved?.status).toBe('started')
    expect(unresolved?.finishedSeq).toBeNull()
  })

  it('fold is total: one poison operation/artifact event skips its case, never throws (contract: never wedge on history)', () => {
    const good = 'step:t1:s1:a1:model:1'
    const op = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord => ({
      seq, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: 's1', runToken: rt('s1'), kind, payload, usage: null, ts: `T${seq}`,
    })
    // an orphaned completion (no started node) and a malformed artifact payload would previously
    // throw out of fold and wedge status/vault/ui/replay for the whole project on one bad event.
    let state!: ReturnType<typeof fold>
    expect(() => {
      state = fold([
        op(1, 'operation_completed', { operationId: 'orphan', attempt: 1, after: {} }), // no started node
        op(2, 'operation_started', { operationId: good, attempt: 1, operationKind: 'model', name: 'fake/m', before: null }),
        exEvt(3, 'artifact_produced', { nope: true }), // malformed artifact payload
        exEvt(4, 'artifact_produced', { path: 'ok.md', sha256: 'ab'.repeat(32), size: 3 }),
      ])
    }).not.toThrow()
    expect(state.operations.get(good)?.status).toBe('started') // the good event still applied
    expect(state.operations.has('orphan')).toBe(false)         // the poison one skipped
    expect(state.artifacts.get('t1')?.map(a => a.path)).toEqual(['ok.md']) // only the valid receipt
  })
})

// The incremental fold. `fold` is the truth function every replay and audit path uses, so an
// incremental applier is only safe if it is the SAME function driven one event at a time — the
// equivalence below is the whole contract, and it is what lets a long-lived process (the DBOS port's
// budget check, the supervisor's idle probe, the signal router) answer from a live accumulator
// instead of re-reading and re-folding the entire project log per question.
describe('foldInto / emptyFold', () => {
  const lifecycle: EventRecord[] = [
    evt(1, 'task_created', { task }),
    evt(2, 'plan_proposed', { plan: planV(1) }),
    evt(3, 'task_status_changed', { taskId: 't1', from: 'draft', to: 'awaiting_approval' }),
    evt(4, 'plan_approved', { taskId: 't1', version: 1, approvedAt: '2026-07-16T01:00:00.000Z' }),
    evt(5, 'task_status_changed', { taskId: 't1', from: 'awaiting_approval', to: 'approved' }),
    eventFixture({ seq: 6, taskId: 't1', runToken: 'r1', kind: 'run_started', payload: { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null } }),
    eventFixture({ seq: 7, taskId: 't1', runToken: 'r1', kind: 'step_started', payload: { stepId: 's1', runToken: 'r1', attempt: 1 } }),
    eventFixture({ seq: 8, taskId: 't1', stepId: 's1', runToken: 'r1', kind: 'agent_call', usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.5, estimated: false }, payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: {} } }),
    eventFixture({ seq: 9, taskId: 't1', runToken: 'r1', kind: 'step_completed', payload: { stepId: 's1', runToken: 'r1', summary: 'ok' } }),
  ]

  const asJson = (s: ReturnType<typeof fold>) =>
    JSON.stringify(s, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v))

  it('applying events one at a time equals folding them in one pass', () => {
    const incremental = lifecycle.reduce(foldInto, emptyFold())
    expect(asJson(incremental.state)).toEqual(asJson(fold(lifecycle)))
  })

  it('carries crash-boundary dedup ACROSS applications, not just within one batch', () => {
    // the same tool_result delivered twice — the dedup key lives on the accumulator, so a
    // duplicate arriving in a later application is still suppressed
    const dup = eventFixture({ seq: 10, taskId: 't1', stepId: 's1', runToken: 'r1', kind: 'agent_call', usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.5, estimated: false }, payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: {} } })
    const acc = [...lifecycle, dup].reduce(foldInto, emptyFold())
    expect(acc.state.usage.get('t1')?.costUSD).toBe(0.5) // not 1.0 — the replay folded once
    expect(asJson(acc.state)).toEqual(asJson(fold([...lifecycle, dup])))
  })

  it('an empty accumulator is an empty state', () => {
    expect(asJson(emptyFold().state)).toEqual(asJson(fold([])))
  })
})

// Observed live: a grounded run's plan step finished, its split child blocked, and the CLI printed
// "run finished: done" and exited 0. The root's own status is not the run's outcome.
describe('subtreeOutcome', () => {
  const t = (id: string, status: TaskNode['status'], parentId: string | null = null): EventRecord =>
    evt(1, 'task_created', { task: { ...task, id, status, parentId, depth: parentId ? 1 : 0 } })

  it('a blocked descendant makes the run blocked even when the root finished', () => {
    const state = fold([t('root', 'done'), t('root.child', 'blocked', 'root')])
    expect(subtreeOutcome(state, 'root')).toBe('blocked')
  })

  it('all done is done', () => {
    const state = fold([t('root', 'done'), t('root.child', 'done', 'root')])
    expect(subtreeOutcome(state, 'root')).toBe('done')
  })

  it("the root's own non-done outcome still wins", () => {
    const state = fold([t('root', 'cancelled'), t('root.child', 'done', 'root')])
    expect(subtreeOutcome(state, 'root')).toBe('cancelled')
  })
})

// The scoped change set (audit): the paths a task's steps WROTE, derived purely from the log so the
// auditor never has to trust git. It pairs each fs_write/fs_edit/fs_delete tool_call with the SAME
// toolCallId's tool_result, keeps only isError===false, and folds artifact_produced receipts in as a
// floor. It is a MEMBERSHIP projection — never a diff, never a substitute for the full test/typecheck
// gate. See the role-auditor skill contract: any defect in an in-zone file still fails the signal.
describe('taskChangedPaths', () => {
  // one tool_call event
  const call = (seq: number, toolCallId: string, toolName: string, input: unknown, stepId = 's1'): EventRecord =>
    eventFixture({ seq, ts: 'T', stepId, runToken: rt(stepId), kind: 'tool_call',
      payload: { stepId, runToken: rt(stepId), iteration: 1, toolCallId, toolName, input } })
  // its paired tool_result
  const result = (seq: number, toolCallId: string, toolName: string, isError: boolean, stepId = 's1'): EventRecord =>
    eventFixture({ seq, ts: 'T', stepId, runToken: rt(stepId), kind: 'tool_result',
      payload: { stepId, runToken: rt(stepId), iteration: 1, toolCallId, toolName, output: {}, isError } })
  const artifact = (seq: number, path: string, stepId = 's1'): EventRecord =>
    eventFixture({ seq, ts: 'T', stepId, runToken: rt(stepId), kind: 'artifact_produced',
      payload: { path, sha256: 'a'.repeat(64), size: 1 } })

  const paths = (rows: ReturnType<typeof taskChangedPaths>): string[] => rows.map(r => r.path)

  it('includes a successful fs_write (call paired with an isError:false result)', () => {
    const rows = taskChangedPaths([
      call(1, 'c1', 'fs_write', { path: 'src/a.ts' }),
      result(2, 'c1', 'fs_write', false),
    ])
    expect(paths(rows)).toEqual(['src/a.ts'])
    expect(rows[0]!.steps).toEqual([{ stepId: 's1', tool: 'fs_write', seq: 1 }])
  })

  it('EXCLUDES a write whose tool_result isError === true', () => {
    const rows = taskChangedPaths([
      call(1, 'c1', 'fs_write', { path: 'src/a.ts' }),
      result(2, 'c1', 'fs_write', true),
    ])
    expect(paths(rows)).toEqual([])
  })

  it('EXCLUDES a tool_call with no matching tool_result (crash before result is not a write)', () => {
    const rows = taskChangedPaths([call(1, 'c1', 'fs_write', { path: 'src/a.ts' })])
    expect(paths(rows)).toEqual([])
  })

  it('includes fs_edit and fs_delete', () => {
    const rows = taskChangedPaths([
      call(1, 'c1', 'fs_edit', { path: 'e.ts' }), result(2, 'c1', 'fs_edit', false),
      call(3, 'c2', 'fs_delete', { path: 'd.ts' }), result(4, 'c2', 'fs_delete', false),
    ])
    expect(paths(rows)).toEqual(['e.ts', 'd.ts'])
  })

  it('excludes non-write tools (fs_read, memory_write, exec) even when paired', () => {
    const rows = taskChangedPaths([
      call(1, 'c1', 'fs_read', { path: 'r.ts' }), result(2, 'c1', 'fs_read', false),
      call(3, 'c2', 'memory_write', { path: 'm.ts' }), result(4, 'c2', 'memory_write', false),
      call(5, 'c3', 'exec', { path: 'x.ts' }), result(6, 'c3', 'exec', false),
    ])
    expect(paths(rows)).toEqual([])
  })

  it('skips a malformed write input (no path / path not a string) without throwing', () => {
    let rows!: ReturnType<typeof taskChangedPaths>
    expect(() => {
      rows = taskChangedPaths([
        call(1, 'c1', 'fs_write', { nope: true }), result(2, 'c1', 'fs_write', false),
        call(3, 'c2', 'fs_write', { path: 42 }), result(4, 'c2', 'fs_write', false),
        call(5, 'c3', 'fs_write', { path: '' }), result(6, 'c3', 'fs_write', false),
        call(7, 'c4', 'fs_write', 'not-a-record'), result(8, 'c4', 'fs_write', false),
      ])
    }).not.toThrow()
    expect(paths(rows)).toEqual([])
  })

  it("normalizes './x.ts' and 'x.ts' to one deduped entry keeping every contributing step", () => {
    const rows = taskChangedPaths([
      call(1, 'c1', 'fs_write', { path: './x.ts' }, 's1'), result(2, 'c1', 'fs_write', false, 's1'),
      call(3, 'c2', 'fs_edit', { path: 'x.ts' }, 's2'), result(4, 'c2', 'fs_edit', false, 's2'),
    ])
    expect(paths(rows)).toEqual(['x.ts'])
    expect(rows[0]!.steps).toEqual([
      { stepId: 's1', tool: 'fs_write', seq: 1 },
      { stepId: 's2', tool: 'fs_edit', seq: 3 },
    ])
  })

  it('collapses duplicate slashes and a leading ./ on normalization', () => {
    const rows = taskChangedPaths([
      call(1, 'c1', 'fs_write', { path: './a//b/c.ts' }), result(2, 'c1', 'fs_write', false),
    ])
    expect(paths(rows)).toEqual(['a/b/c.ts'])
  })

  it('folds an artifact_produced receipt into the set as a contributing path', () => {
    const rows = taskChangedPaths([artifact(1, 'out/report.md')])
    expect(paths(rows)).toEqual(['out/report.md'])
    expect(rows[0]!.steps).toEqual([{ stepId: 's1', tool: 'artifact_produced', seq: 1 }])
  })

  it('orders deterministically by first seq, then path', () => {
    // written out of seq order in the array; first-contributing seq decides order
    const rows = taskChangedPaths([
      call(5, 'c2', 'fs_write', { path: 'b.ts' }), result(6, 'c2', 'fs_write', false),
      call(1, 'c1', 'fs_write', { path: 'a.ts' }), result(2, 'c1', 'fs_write', false),
    ])
    expect(paths(rows)).toEqual(['a.ts', 'b.ts']) // a.ts first-seen at seq 1, b.ts at seq 5
  })
})

const write = (seq: number, note: Record<string, unknown>, taskId: string | undefined): EventRecord =>
  eventFixture({ seq, ts: 'T', kind: 'memory_written',
    payload: { note, author: { source: 'agent', ...(taskId ? { taskId } : {}) } } })
const del = (seq: number, id: string, scope = 'project'): EventRecord =>
  eventFixture({ seq, ts: 'T', kind: 'memory_deleted',
    payload: { id, scope, author: { source: 'cli' } } })
const verified = (seq: number, id: string, taskId: string | undefined, scope = 'project'): EventRecord =>
  eventFixture({ seq, ts: 'T', kind: 'memory_verified',
    payload: { id, scope, stamp: { revision: 'head1', at: 'T', by: 'exec·m·auditor' },
      author: { source: 'agent', ...(taskId ? { taskId } : {}) } } })
const semantic = (id: string, paths: string[]): Record<string, unknown> =>
  ({ id, scope: 'project', title: id, tier: 'semantic', paths })
const subtree = new Set(['t1', 't1.c1'])

describe('taskNoteWrites', () => {
  it('collects a semantic note written by a subtree task, latest write supplying the paths', () => {
    const rows = taskNoteWrites([
      write(1, semantic('area-x', ['src/old.ts']), 't1'),
      write(2, semantic('area-x', ['src/new.ts']), 't1'),
    ], subtree)
    // the subtree created it — a fresh note, never a heal, however many times it rewrote it
    expect(rows).toEqual([{ id: 'area-x', scope: 'project', paths: ['src/new.ts'], preexisting: false }])
  })

  it('a later write by an OUTSIDE author updates paths but membership stays (the task touched it)', () => {
    const rows = taskNoteWrites([
      write(1, semantic('area-x', ['a.ts']), 't1.c1'),
      write(2, semantic('area-x', ['b.ts']), 'other-task'),
    ], subtree)
    expect(rows).toEqual([{ id: 'area-x', scope: 'project', paths: ['b.ts'], preexisting: false }])
  })

  // preexisting is the HEAL test: a write to a note that already existed corrects standing prose,
  // which is what earns a restamp. A write that CREATED the note proves nothing about its truth —
  // the piggyback that let every ambient step note ride the commit stamp out of the auditor's reach.
  it('a note that existed before the subtree first wrote it is preexisting — a HEAL', () => {
    expect(taskNoteWrites([
      write(1, semantic('area-x', ['a.ts']), 'other-task'), // someone else wrote it first
      write(2, semantic('area-x', ['a.ts']), 't1'),         // the subtree corrected it
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['a.ts'], preexisting: true }])
  })

  it('preexisting is decided at the subtree FIRST write, not the last', () => {
    expect(taskNoteWrites([
      write(1, semantic('area-x', ['a.ts']), 't1'),         // created here → fresh
      write(2, semantic('area-x', ['a.ts']), 'other-task'),
      write(3, semantic('area-x', ['b.ts']), 't1'),         // a later rewrite cannot make it a heal
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['b.ts'], preexisting: false }])
  })

  it('a re-write after a delete is fresh — the note it would have healed is gone', () => {
    expect(taskNoteWrites([
      write(1, semantic('area-x', ['a.ts']), 'other-task'),
      del(2, 'area-x'),
      write(3, semantic('area-x', ['a.ts']), 't1'),
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['a.ts'], preexisting: false }])
  })

  it('excludes notes only ever written outside the subtree, or with no author task', () => {
    expect(taskNoteWrites([
      write(1, semantic('theirs', ['a.ts']), 'other-task'),
      write(2, semantic('manual', ['b.ts']), undefined),
    ], subtree)).toEqual([])
  })

  it('a memory_deleted after the write drops the note', () => {
    expect(taskNoteWrites([
      write(1, semantic('gone', ['a.ts']), 't1'),
      del(2, 'gone'),
    ], subtree)).toEqual([])
  })

  it('excludes non-semantic tiers and pathless semantic notes', () => {
    expect(taskNoteWrites([
      write(1, { id: 'step-a', scope: 'plan-t1', title: 's', tier: 'episodic' }, 't1'),
      write(2, semantic('no-paths', []), 't1'),
    ], subtree)).toEqual([])
  })
})

// The other half of the post-commit stamp set: notes a step of this subtree DECLARED verified.
// Verification is never inferred from a write, so it needs its own fold — the note's paths still
// come from its latest write, because the post-commit dirty gate can only judge declared paths.
describe('taskVerifiedNotes', () => {
  it('returns a note verified by a subtree task, with the paths its latest write declared', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('area-x', ['a.ts']), 'other-task'), // written by anyone
      write(2, semantic('area-x', ['b.ts']), 'other-task'),
      verified(3, 'area-x', 't1.c1'),                       // verified by us → ours to reverify
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['b.ts'] }])
  })

  it('excludes a verification by a task outside the subtree, or with no author task', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('theirs', ['a.ts']), 't1'),  // OUR write does not make it verified
      verified(2, 'theirs', 'other-task'),
      write(3, semantic('manual', ['b.ts']), 't1'),
      verified(4, 'manual', undefined),
    ], subtree)).toEqual([])
  })

  it('dedupes repeated verifications of the same note', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('area-x', ['a.ts']), 'other-task'),
      verified(2, 'area-x', 't1'),
      verified(3, 'area-x', 't1.c1'),
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['a.ts'] }])
  })

  // deriveNoteProvenance CARRIES a stamp across a byte-identical rewrite and CLEARS it on any
  // change to what the note says. This fold must agree: reverifying a note whose stamp the log
  // already destroyed would mint a check that never happened — the false confidence the whole
  // declared-verification design exists to prevent.
  it('a later write that CHANGES the note drops the verification, whoever wrote it', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('area-x', ['a.ts']), 'other-task'),
      verified(2, 'area-x', 't1'),
      write(3, { ...semantic('area-x', ['a.ts']), body: 'rewritten after the audit' }, 'other-task'),
    ], subtree)).toEqual([])
  })

  it('a byte-identical rewrite (the commit restamp) keeps the verification', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('area-x', ['a.ts']), 'other-task'),
      verified(2, 'area-x', 't1'),
      write(3, semantic('area-x', ['a.ts']), 't1'), // same fields, rewritten by us — the restamp
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['a.ts'] }])
  })

  // A TIER FLIP is a content change like any other — `tier` is one of noteContentKey's CONTENT_FIELDS
  // — so deriveNoteProvenance clears the stored row's stamp. This fold ran its tier gate BEFORE the
  // content compare, so the flipped note stayed in the verified set: the commit step reverified it at
  // the new HEAD, minting a stamp for text nobody audited, on a row the read model had already
  // un-stamped. The two carry/clear implementations must agree or the stamp resurrects.
  it('a later write that flips the note off the semantic tier drops the verification', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('area-x', ['a.ts']), 'other-task'),
      verified(2, 'area-x', 't1'),
      write(3, { id: 'area-x', scope: 'project', title: 'area-x', tier: 'episodic', body: 'now a step note' }, 'other-task'),
    ], subtree)).toEqual([])
  })

  it('a memory_deleted after the verification drops the note', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('gone', ['a.ts']), 'other-task'),
      verified(2, 'gone', 't1'),
      del(3, 'gone'),
    ], subtree)).toEqual([])
  })

  it('excludes non-semantic tiers and pathless notes — nothing for the dirty gate to judge', () => {
    expect(taskVerifiedNotes([
      write(1, { id: 'step-a', scope: 'plan-t1', title: 's', tier: 'episodic' }, 'other-task'),
      verified(2, 'step-a', 't1', 'plan-t1'),
      write(3, semantic('no-paths', []), 'other-task'),
      verified(4, 'no-paths', 't1'),
    ], subtree)).toEqual([])
  })
})
