import { describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, Door, EVENT_KIND, FailureClass, OperationKind, OperationStatus, RunOutcome, StepRunStatus, TASK_STATUS, TaskStatus, type EventRecord, type Origin, type Plan, type TaskNode } from '@orc/contracts'
import { authorFixture, eventFixture, draftFixture, must, planFixture, stepFixture, taskFixture } from '@orc/contracts/fixtures'
import { TEST_WORKSPACE_ID } from './test-helpers'
import { blockingVerdicts, canRetry, retryIsFutile, startedAttempts, type State, type StepState, emptyFold, estimateCostUSD, fold, foldInto, subtreeOutcome, completedStepIds, nextAttempts, crashDedupKey, stepUsage, subtreeTaskIds, subtreeUsage, pendingSplitForChild, remainingBudget, inheritedCwd, runCwd, taskChangedPaths, taskNoteWrites, taskVerifiedNotes } from './projections'

// An agent authors inside its run's chat; MemoryAuthor.origin is required, and a payload author
// missing it fails zod at runtime (payload is untyped, so nothing flags it at compile time).
const RUN: Origin = { chatId: 'run:t1:v1', door: Door.supervisor }

const task: TaskNode = taskFixture()

const planV = (version: number): Plan => planFixture({ version })

const evt = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord =>
  eventFixture({ seq, ts: '2026-07-16T00:00:00.000Z', kind, payload })

// A step folded `running` is a LIVE attempt only while the run is live. Once the task settles, the
// fold says `running` only because the step died between its last checkpoint and step_failed — so
// reusing the attempt re-attached to a DEAD workflow, which replays its stored error and makes
// every `orc retry` fail identically, forever.
describe('nextAttempts and an orphaned running step', () => {
  const plan: Pick<Plan, 'steps'> = { steps: [stepFixture({ id: 'a' }), stepFixture({ id: 'b' })] }
  const stateWith = (status: TaskStatus, stepStatus: StepRunStatus) => {
    const st = emptyFold().state
    st.tasks.set('t1', taskFixture({ title: 'T', status, createdAt: '2026-07-27T00:00:00.000Z' }))
    const step: StepState = {
      stepId: 'a', runToken: 'rt', attempt: 2, status: stepStatus,
      iterations: 1, output: null, failure: null,
    }
    st.steps.set('t1', new Map([['a', step]]))
    return st
  }

  it('reuses the attempt while the run is LIVE, so the workflow id re-attaches', () => {
    expect(nextAttempts(stateWith(TASK_STATUS.running, StepRunStatus.running), 't1', plan).a).toBe(2)
  })

  it('gives a fresh attempt once the task has settled — the running step is orphaned', () => {
    expect(nextAttempts(stateWith(TASK_STATUS.blocked, StepRunStatus.running), 't1', plan).a).toBe(3)
  })

  it('a step with no history starts at 1 either way', () => {
    expect(nextAttempts(stateWith(TASK_STATUS.blocked, StepRunStatus.running), 't1', plan).b).toBe(1)
  })
})

describe('fold', () => {
  it('replays a full lifecycle into consistent state', () => {
    const state = fold([
      evt(1, EVENT_KIND.task_created, { task }),
      evt(2, EVENT_KIND.plan_proposed, { plan: planV(1) }),
      evt(3, EVENT_KIND.task_status_changed, { taskId: 't1', from: 'draft', to: 'awaiting_approval' }),
      evt(4, EVENT_KIND.plan_edited, { plan: planV(2) }),
      evt(5, EVENT_KIND.plan_approved, { taskId: 't1', version: 2, approvedAt: '2026-07-16T01:00:00.000Z' }),
      evt(6, EVENT_KIND.task_status_changed, { taskId: 't1', from: 'awaiting_approval', to: 'approved' }),
    ])
    expect(state.tasks.get('t1')?.status).toBe(TaskStatus.approved)
    expect(state.plans.get('t1')?.versions.map(p => p.version)).toEqual([1, 2])
    expect(state.plans.get('t1')?.approvedVersion).toBe(2)
  })
  it('is pure: same input, same output', () => {
    const events = [evt(1, EVENT_KIND.task_created, { task })]
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
    const base = eventFixture({
      ts: '2026-07-17T00:00:00.000Z', stepId: 's1', runToken: 'step:t1:s1:a1', kind: EVENT_KIND.tool_call,
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
    })
    const other: EventRecord = { ...base, payload: { ...base.payload, toolCallId: 'c2' } }
    expect(crashDedupKey(base)).not.toBe(crashDedupKey(other))
  })

  it('matches when (runToken, kind, iteration, toolCallId, name) match, regardless of other fields', () => {
    const e1 = eventFixture({
      ts: '2026-07-17T00:00:00.000Z', stepId: 's1', runToken: 'step:t1:s1:a1', kind: EVENT_KIND.tool_call,
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} },
    })
    const e2 = eventFixture({
      seq: 2, ts: '2026-07-17T00:05:00.000Z', stepId: 's1', runToken: 'step:t1:s1:a1', kind: EVENT_KIND.tool_call,
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', iteration: 1, toolCallId: 'c1', toolName: 'different_tool', input: { x: 1 } },
    })
    expect(crashDedupKey(e1)).toBe(crashDedupKey(e2))
  })

  it('skill_loaded events dedup per skill name, not per step', () => {
    const mk = (seq: number, name: string): EventRecord => eventFixture({
      seq, ts: 't', stepId: 's1', runToken: 'step:t1:s1:a1', kind: EVENT_KIND.skill_loaded,
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', name, hash: 'h' },
    })
    // two different skills in one init: both keys distinct
    expect(crashDedupKey(mk(1, 'alpha'))).not.toBe(crashDedupKey(mk(2, 'beta')))
    // crash-boundary duplicate of the same skill: identical key
    expect(crashDedupKey(mk(1, 'alpha'))).toBe(crashDedupKey(mk(3, 'alpha')))
  })

  it('returns null for task_status_changed even when a runToken is present', () => {
    const e = eventFixture({
      ts: '2026-07-17T00:00:00.000Z', runToken: 'step:t1:s1:a1', kind: EVENT_KIND.task_status_changed,
      payload: { taskId: 't1', from: 'draft', to: 'approved' },
    })
    expect(crashDedupKey(e)).toBeNull()
  })

  it('returns null for any event with a null runToken', () => {
    const e = eventFixture({ ts: '2026-07-17T00:00:00.000Z', payload: { task } })
    expect(crashDedupKey(e)).toBeNull()
  })

  it('returns null for rate_limit_wait, whose db idempotency key already forbids raw duplicates', () => {
    const mk = (waitsSoFar: number): EventRecord => eventFixture({
      ts: '2026-07-17T00:00:00.000Z', runToken: 'step:t1:s1:a1', kind: EVENT_KIND.rate_limit_wait,
      payload: { stepId: 's1', runToken: 'step:t1:s1:a1', waitMs: 5000, waitsSoFar, errorMessage: 'rate limited' },
    })
    // every wait in a run shares (runToken, kind) and none of iteration/toolCallId/name/splitId/path —
    // without this exclusion both collapse to the same key and the second is dropped as a duplicate
    expect(crashDedupKey(mk(0))).toBeNull()
    expect(crashDedupKey(mk(1))).toBeNull()
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
      exEvt(1, EVENT_KIND.run_started, { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null }),
      exEvt(2, EVENT_KIND.step_started, { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      exEvt(3, EVENT_KIND.agent_call, { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
        { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false }),
      exEvt(4, EVENT_KIND.signal_received, { stepId: 's1', runToken: rt('s1'), signal: { stepId: 's1', runToken: rt('s1'), outcome: 'success', summary: 'ok' } }),
      exEvt(5, EVENT_KIND.step_completed, { stepId: 's1', runToken: rt('s1'), summary: 'ok' }),
    ])
    const step = state.steps.get('t1')?.get('s1')
    expect(step?.status).toBe(StepRunStatus.completed)
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
      exEvt(1, EVENT_KIND.run_started, { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null }),
      exEvt(2, EVENT_KIND.step_started, { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      exEvt(3, EVENT_KIND.skill_loaded, { stepId: 's1', runToken: rt('s1'), name: 'alpha', hash: 'h' }),
      exEvt(4, EVENT_KIND.agent_call, { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
        { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false }),
      exEvt(5, EVENT_KIND.signal_received, { stepId: 's1', runToken: rt('s1'), signal: { stepId: 's1', runToken: rt('s1'), outcome: 'success', summary: 'ok' } }),
      exEvt(6, EVENT_KIND.step_completed, { stepId: 's1', runToken: rt('s1'), summary: 'ok' }),
    ])
    const step = state.steps.get('t1')?.get('s1')
    expect(step?.status).toBe(StepRunStatus.completed)
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
    const withMem = fold([eventFixture({
      taskId: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'x', title: 'X', scope: 'project', categories: [], tags: [], links: [], paths: [], summary: '', body: '' }, author: authorFixture() },
      ts: '2026-07-18T00:00:00Z',
    })])
    expect(withMem.tasks.size).toBe(base.tasks.size)
  })

  it('dedups crash-boundary duplicates by (runToken, kind, iteration, toolCallId)', () => {
    const dup = exEvt(3, EVENT_KIND.agent_call, { stepId: 's1', runToken: rt('s1'), iteration: 1, request: {}, response: {} },
      { inputTokens: 100, outputTokens: 50, costUSD: 0.01, estimated: false })
    const state = fold([
      exEvt(2, EVENT_KIND.step_started, { stepId: 's1', runToken: rt('s1'), attempt: 1 }),
      dup,
      { ...dup, seq: 4 }, // crash-boundary replay of the same iteration
      exEvt(5, EVENT_KIND.tool_call, { stepId: 's1', runToken: rt('s1'), iteration: 1, toolCallId: 'c1', toolName: 'fs_read', input: {} }),
      exEvt(6, EVENT_KIND.tool_call, { stepId: 's1', runToken: rt('s1'), iteration: 1, toolCallId: 'c2', toolName: 'fs_read', input: {} }),
    ])
    expect(state.usage.get('t1')?.inputTokens).toBe(100) // counted once
    expect(state.steps.get('t1')?.get('s1')?.iterations).toBe(1)
    // two DISTINCT tool calls in one iteration both survive (toolCallId disambiguates)
  })

  it('failed attempt then fresh attempt: latest wins, nextAttempts increments', () => {
    const plan = draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: 's2' })])
    const state = fold([
      exEvt(1, EVENT_KIND.step_started, { stepId: 's1', runToken: rt('s1', 1), attempt: 1 }),
      exEvt(2, EVENT_KIND.step_failed, { stepId: 's1', runToken: rt('s1', 1), class: 'agent_error', message: 'nope' }),
      exEvt(3, EVENT_KIND.step_started, { stepId: 's1', runToken: rt('s1', 2), attempt: 2 }),
      exEvt(4, EVENT_KIND.step_completed, { stepId: 's1', runToken: rt('s1', 2), summary: 'fixed' }),
    ])
    expect(state.steps.get('t1')?.get('s1')?.status).toBe(StepRunStatus.completed)
    expect(state.steps.get('t1')?.get('s1')?.attempt).toBe(2)
    expect(nextAttempts(state, 't1', plan)).toEqual({ s1: 3, s2: 1 })
  })

  it('rejects a late event carrying a superseded attempt runToken', () => {
    const state = fold([
      exEvt(1, EVENT_KIND.step_started, { stepId: 's1', runToken: rt('s1', 1), attempt: 1 }),
      exEvt(2, EVENT_KIND.step_failed, { stepId: 's1', runToken: rt('s1', 1), class: 'agent_error', message: 'boom' }),
      exEvt(3, EVENT_KIND.step_started, { stepId: 's1', runToken: rt('s1', 2), attempt: 2 }),
      exEvt(4, EVENT_KIND.step_completed, { stepId: 's1', runToken: rt('s1', 2), summary: 'fresh' }),
      // late/stale events from the superseded attempt 1 — envelope and payload both carry the old runToken
      exEvt(5, EVENT_KIND.step_completed, { stepId: 's1', runToken: rt('s1', 1), summary: 'stale' }),
      exEvt(6, EVENT_KIND.agent_call, { stepId: 's1', runToken: rt('s1', 1), iteration: 9, request: {}, response: {} },
        { inputTokens: 5, outputTokens: 5, costUSD: 0, estimated: false }),
    ])
    const step = state.steps.get('t1')?.get('s1')
    expect(step?.status).toBe(StepRunStatus.completed)
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
      eventFixture({ stepId: 's1', runToken: rt('s1'), kind: EVENT_KIND.split_proposed, payload: splitP, ts: 'T' }),
      eventFixture({ seq: 2, stepId: 's1', runToken: rt('s1'), kind: EVENT_KIND.split_proposed, payload: splitP, ts: 'T' }), // crash replay
      eventFixture({
        seq: 3, stepId: 's1', runToken: rt('s1'), kind: EVENT_KIND.split_proposed,
        payload: { ...splitP, splitId: 'sp2', childTaskId: 'c2' }, ts: 'T',
      }),
    ])
    expect(state.splits.size).toBe(2) // sp1 deduped, sp2 distinct despite same runToken
    expect(state.splits.get('sp1')?.resolved).toBe(false)
    expect(pendingSplitForChild(state, 'c1')?.splitId).toBe('sp1')
    const resolved = fold([
      eventFixture({ stepId: 's1', runToken: rt('s1'), kind: EVENT_KIND.split_proposed, payload: splitP, ts: 'T' }),
      eventFixture({
        seq: 2, kind: EVENT_KIND.split_resolved,
        payload: { splitId: 'sp1', childTaskId: 'c1', outcome: 'done', summary: 'ok', notes: [] }, ts: 'T',
      }),
    ])
    expect(resolved.splits.get('sp1')?.resolved).toBe(true)
    expect(pendingSplitForChild(resolved, 'c1')).toBeUndefined()
  })

  it('subtreeUsage sums a task and its descendants; subtreeTaskIds walks parentId', () => {
    const t = (id: string, parentId: string | null): EventRecord => eventFixture({
      seq: 0, taskId: id,
      payload: { task: { id, parentId, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title: id, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: parentId ? 1 : 0, createdAt: 'T' } },
      ts: 'T',
    })
    const usage = (taskId: string, cost: number): EventRecord => eventFixture({
      seq: 0, taskId, stepId: 's1', runToken: `rt-${taskId}`, kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken: `rt-${taskId}`, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: cost, estimated: false }, ts: 'T',
    })
    const state = fold([t('p', null), t('c1', 'p'), t('c2', 'p'), t('g1', 'c1'), usage('p', 1), usage('c1', 2), usage('g1', 4)].map((e, i) => ({ ...e, seq: i + 1 })))
    expect(subtreeTaskIds(state, 'p')).toEqual(['p', 'c1', 'c2', 'g1'])
    expect(subtreeUsage(state, 'p').costUSD).toBe(7)
    expect(subtreeUsage(state, 'c1').costUSD).toBe(6)
  })

  it("remainingBudget is the min over the ancestor chain, not just the task's own budget", () => {
    const t = (id: string, parentId: string | null, budgetUSD: number | null): EventRecord => eventFixture({
      seq: 0, taskId: id,
      payload: { task: { id, parentId, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title: id, spec: '', status: 'draft', zone: [], budgetUSD, depth: parentId ? 1 : 0, createdAt: 'T' } },
      ts: 'T',
    })
    const usage = (taskId: string, cost: number): EventRecord => eventFixture({
      seq: 0, taskId, stepId: 's1', runToken: `rt-${taskId}`, kind: EVENT_KIND.agent_call,
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
      evt(1, EVENT_KIND.task_created, { task: { ...task, id: 'p' } }),
      evt(2, EVENT_KIND.task_created, { task: { ...task, id: 'c', parentId: 'p', depth: 1 } }),
      eventFixture({ seq: 3, ts: '2026-07-16T00:00:00.000Z', taskId: 'p', kind: EVENT_KIND.run_started, payload: { planVersion: 1, retryIndex: 0, workflowId: 'w1', cwd: '/tree' } }),
    ])
    expect(runCwd(state, must(state.tasks.get('c'), 'child task'), undefined, '/proj')).toBe('/tree')
    expect(runCwd(state, must(state.tasks.get('p'), 'parent task'), undefined, '/proj')).toBe('/proj')
    expect(runCwd(state, must(state.tasks.get('c'), 'child task'), '/explicit', '/proj')).toBe('/explicit')
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
      eventFixture({ kind: EVENT_KIND.plan_proposed, payload: { plan }, ts: 'T' }),
      eventFixture({ seq: 2, kind: EVENT_KIND.plan_proposed, payload: { plan }, ts: 'T' }),
    ])
    expect(state.plans.get('t1')?.versions).toHaveLength(1)
  })

  it('folds artifacts by task; distinct paths survive, a replayed receipt folds once', () => {
    const receipt = (seq: number, p: string): EventRecord => eventFixture({
      seq, stepId: 's1', runToken: rt('s1'), kind: EVENT_KIND.artifact_produced,
      payload: { path: p, sha256: 'a'.repeat(64), size: 1 }, ts: 'T',
    })
    const state = fold([receipt(1, 'a.md'), receipt(2, 'b.md'), receipt(3, 'a.md')])
    expect(state.artifacts.get('t1')?.map(a => a.path)).toEqual(['a.md', 'b.md'])
  })

  it('folds operation transitions into replayable journal state', () => {
    const op = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord => eventFixture({
      seq, stepId: 's1', runToken: rt('s1'), kind, payload, ts: `T${seq}`,
    })
    const id = 'step:t1:s1:a1:model:1'
    const state = fold([
      op(1, EVENT_KIND.operation_started, { operationId: id, attempt: 1, operationKind: OperationKind.model, name: 'fake/m', before: { q: 1 } }),
      op(2, EVENT_KIND.operation_failed, { operationId: id, attempt: 1, error: { message: 'boom' } }),
      op(3, EVENT_KIND.operation_started, { operationId: id, attempt: 2, operationKind: OperationKind.model, name: 'fake/m', before: { q: 1 } }),
      op(4, EVENT_KIND.operation_completed, { operationId: id, attempt: 2, after: { text: 'ok' } }),
    ])
    const node = state.operations.get(id)
    expect(node?.status).toBe(OperationStatus.completed)
    expect(node?.attempts).toBe(2)
    expect(node?.after).toEqual({ text: 'ok' })
    expect(node?.startedSeq).toBe(3)
    expect(node?.finishedSeq).toBe(4)

    const unresolved = fold([
      op(1, EVENT_KIND.operation_started, { operationId: id, attempt: 1, operationKind: OperationKind.model, name: 'fake/m', before: null }),
    ]).operations.get(id)
    expect(unresolved?.status).toBe(OperationStatus.started)
    expect(unresolved?.finishedSeq).toBeNull()
  })

  it('fold is total: one poison operation/artifact event skips its case, never throws (contract: never wedge on history)', () => {
    const good = 'step:t1:s1:a1:model:1'
    const op = (seq: number, kind: EventRecord['kind'], payload: Record<string, unknown>): EventRecord => eventFixture({
      seq, stepId: 's1', runToken: rt('s1'), kind, payload, ts: `T${seq}`,
    })
    // an orphaned completion (no started node) and a malformed artifact payload would previously
    // throw out of fold and wedge status/vault/ui/replay for the whole project on one bad event.
    let state!: ReturnType<typeof fold>
    expect(() => {
      state = fold([
        op(1, EVENT_KIND.operation_completed, { operationId: 'orphan', attempt: 1, after: {} }), // no started node
        op(2, EVENT_KIND.operation_started, { operationId: good, attempt: 1, operationKind: OperationKind.model, name: 'fake/m', before: null }),
        exEvt(3, EVENT_KIND.artifact_produced, { nope: true }), // malformed artifact payload
        exEvt(4, EVENT_KIND.artifact_produced, { path: 'ok.md', sha256: 'ab'.repeat(32), size: 3 }),
      ])
    }).not.toThrow()
    expect(state.operations.get(good)?.status).toBe(OperationStatus.started) // the good event still applied
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
    evt(1, EVENT_KIND.task_created, { task }),
    evt(2, EVENT_KIND.plan_proposed, { plan: planV(1) }),
    evt(3, EVENT_KIND.task_status_changed, { taskId: 't1', from: 'draft', to: 'awaiting_approval' }),
    evt(4, EVENT_KIND.plan_approved, { taskId: 't1', version: 1, approvedAt: '2026-07-16T01:00:00.000Z' }),
    evt(5, EVENT_KIND.task_status_changed, { taskId: 't1', from: 'awaiting_approval', to: 'approved' }),
    eventFixture({ seq: 6, taskId: 't1', runToken: 'r1', kind: EVENT_KIND.run_started, payload: { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null } }),
    eventFixture({ seq: 7, taskId: 't1', runToken: 'r1', kind: EVENT_KIND.step_started, payload: { stepId: 's1', runToken: 'r1', attempt: 1 } }),
    eventFixture({ seq: 8, taskId: 't1', stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call, usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.5, estimated: false }, payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: {} } }),
    eventFixture({ seq: 9, taskId: 't1', runToken: 'r1', kind: EVENT_KIND.step_completed, payload: { stepId: 's1', runToken: 'r1', summary: 'ok' } }),
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
    const dup = eventFixture({ seq: 10, taskId: 't1', stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call, usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.5, estimated: false }, payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: {} } })
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
    evt(1, EVENT_KIND.task_created, { task: { ...task, id, status, parentId, depth: parentId ? 1 : 0 } })

  it('a blocked descendant makes the run blocked even when the root finished', () => {
    const state = fold([t('root', TaskStatus.done), t('root.child', TaskStatus.blocked, 'root')])
    expect(subtreeOutcome(state, 'root')).toBe(RunOutcome.blocked)
  })

  it('all done is done', () => {
    const state = fold([t('root', TaskStatus.done), t('root.child', TaskStatus.done, 'root')])
    expect(subtreeOutcome(state, 'root')).toBe(RunOutcome.done)
  })

  it("the root's own non-done outcome still wins", () => {
    const state = fold([t('root', TaskStatus.cancelled), t('root.child', TaskStatus.done, 'root')])
    expect(subtreeOutcome(state, 'root')).toBe(RunOutcome.cancelled)
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
    eventFixture({ seq, ts: 'T', stepId, runToken: rt(stepId), kind: EVENT_KIND.tool_call,
      payload: { stepId, runToken: rt(stepId), iteration: 1, toolCallId, toolName, input } })
  // its paired tool_result
  const result = (seq: number, toolCallId: string, toolName: string, isError: boolean, stepId = 's1'): EventRecord =>
    eventFixture({ seq, ts: 'T', stepId, runToken: rt(stepId), kind: EVENT_KIND.tool_result,
      payload: { stepId, runToken: rt(stepId), iteration: 1, toolCallId, toolName, output: {}, isError } })
  const artifact = (seq: number, path: string, stepId = 's1'): EventRecord =>
    eventFixture({ seq, ts: 'T', stepId, runToken: rt(stepId), kind: EVENT_KIND.artifact_produced,
      payload: { path, sha256: 'a'.repeat(64), size: 1 } })

  const paths = (rows: ReturnType<typeof taskChangedPaths>): string[] => rows.map(r => r.path)

  it('includes a successful fs_write (call paired with an isError:false result)', () => {
    const rows = taskChangedPaths([
      call(1, 'c1', 'fs_write', { path: 'src/a.ts' }),
      result(2, 'c1', 'fs_write', false),
    ])
    expect(paths(rows)).toEqual(['src/a.ts'])
    expect(must(rows[0], 'first row').steps).toEqual([{ stepId: 's1', tool: 'fs_write', seq: 1 }])
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
    expect(must(rows[0], 'first row').steps).toEqual([
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
    expect(must(rows[0], 'first row').steps).toEqual([{ stepId: 's1', tool: 'artifact_produced', seq: 1 }])
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
  eventFixture({ seq, ts: 'T', kind: EVENT_KIND.memory_written,
    payload: { note, author: authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, ...(taskId ? { taskId } : {}) }) } })
const del = (seq: number, id: string, scope = 'project'): EventRecord =>
  eventFixture({ seq, ts: 'T', kind: EVENT_KIND.memory_deleted,
    payload: { id, scope, author: authorFixture() } })
const verified = (seq: number, id: string, taskId: string | undefined, scope = 'project', revision = 'head1'): EventRecord =>
  eventFixture({ seq, ts: 'T', kind: EVENT_KIND.memory_verified,
    payload: { id, scope, stamp: { revision, at: 'T', by: 'exec·m·auditor' },
      author: authorFixture({ source: AUTHOR_SOURCE.agent, origin: RUN, ...(taskId ? { taskId } : {}) }) } })
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
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['b.ts'], stampRevision: 'head1' }])
  })

  // The commit step's reverify gate diffs the note's cited paths between the stamp's revision and
  // the tree it is about to stamp, so the fold must CARRY that revision. Dropping it is what let a
  // commit advance a verification across a sibling's change to the same file — the note read fresh
  // against code nobody re-read. Latest verify wins, the same last-write-wins `paths` already follow:
  // the commit-step reverify appends its own memory_verified at the new HEAD, and that newer stamp
  // is what the NEXT commit in the subtree must measure from.
  it('carries the stamp revision, and the LATEST verification wins', () => {
    expect(taskVerifiedNotes([
      write(1, semantic('area-x', ['a.ts']), 'other-task'),
      verified(2, 'area-x', 't1', 'project', 'rev-old'),
      verified(3, 'area-x', 't1.c1', 'project', 'rev-new'),
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['a.ts'], stampRevision: 'rev-new' }])
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
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['a.ts'], stampRevision: 'head1' }])
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
    ], subtree)).toEqual([{ id: 'area-x', scope: 'project', paths: ['a.ts'], stampRevision: 'head1' }])
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

// The plan-approval door's estimate: measured history only. A fabricated zero would be worse than
// no number at all — the human would approve against a figure nothing measured.
describe('estimateCostUSD', () => {
  let seq = 0
  const ev = (over: Partial<EventRecord>): EventRecord => eventFixture({ seq: ++seq, ts: '2026-08-01T00:00:00.000Z', ...over })

  // one past task: created, planned, charged (maybe), settled
  const past = (id: string, o: {
    strategyRef: string; analyzerRef?: string; status?: TaskNode['status']; costUSD?: number | null
    parentId?: string
  }): EventRecord[] => {
    const status = o.status ?? 'done'
    const runToken = `step:${id}:s1:a1`
    return [
      ev({ taskId: id, kind: EVENT_KIND.task_created, payload: { task: { ...task, id, parentId: o.parentId ?? null, status: 'draft' } } }),
      ev({ taskId: id, kind: EVENT_KIND.plan_proposed, payload: { plan: planFixture({ taskId: id, strategyRef: o.strategyRef, ...(o.analyzerRef === undefined ? {} : { analyzerRef: o.analyzerRef }) }) } }),
      ...(o.costUSD === undefined ? [] : [ev({
        taskId: id, stepId: 's1', runToken, kind: EVENT_KIND.agent_call,
        payload: { stepId: 's1', runToken, iteration: 1, request: {}, response: {} },
        usage: { inputTokens: 100, outputTokens: 20, costUSD: o.costUSD, estimated: false },
      })]),
      ev({ taskId: id, kind: EVENT_KIND.task_status_changed, payload: { taskId: id, from: 'draft', to: status } }),
    ]
  }

  it('returns null when no comparable task has ever settled — never a fabricated zero', () => {
    expect(estimateCostUSD(fold([]), { strategyRef: 'grounded-plan' })).toBeNull()
    // a matching plan that has NOT settled measures nothing yet
    const running = fold(past('t-run', { strategyRef: 'grounded-plan', status: TaskStatus.running, costUSD: 0.4 }))
    expect(estimateCostUSD(running, { strategyRef: 'grounded-plan' })).toBeNull()
  })

  it('averages the measured subtree cost of matching terminal tasks', () => {
    const state = fold([
      ...past('t-a', { strategyRef: 'grounded-plan', costUSD: 0.1 }),
      ...past('t-b', { strategyRef: 'grounded-plan', costUSD: 0.3 }),
    ])
    expect(estimateCostUSD(state, { strategyRef: 'grounded-plan' })).toBeCloseTo(0.2, 10)
  })

  // subtree, not task: a grounded parent's real cost is the children its plan step split off
  it('counts the whole subtree of a matching task, children included', () => {
    const state = fold([
      ...past('t-root', { strategyRef: 'grounded-plan', costUSD: 0.1 }),
      ...past('t-kid', { strategyRef: 'split', costUSD: 0.5, parentId: 't-root' }),
    ])
    expect(estimateCostUSD(state, { strategyRef: 'grounded-plan' })).toBeCloseTo(0.6, 10)
  })

  it('excludes a matching task whose cost was never measured — an unpriced run is not a $0 run', () => {
    const state = fold([
      ...past('t-a', { strategyRef: 'grounded-plan', costUSD: 0.2 }),
      ...past('t-null', { strategyRef: 'grounded-plan', costUSD: null }), // priced nothing (no cost table)
      ...past('t-none', { strategyRef: 'grounded-plan' }),                // never charged at all
    ])
    expect(estimateCostUSD(state, { strategyRef: 'grounded-plan' })).toBeCloseTo(0.2, 10)
  })

  it('excludes a different strategyRef, and a different analyzerRef when one is named', () => {
    const state = fold([
      ...past('t-grounded', { strategyRef: 'grounded-plan', analyzerRef: 'agent-analyzer', costUSD: 0.2 }),
      ...past('t-split', { strategyRef: 'split', costUSD: 9 }),
      ...past('t-other-analyzer', { strategyRef: 'grounded-plan', analyzerRef: 'other-analyzer', costUSD: 9 }),
    ])
    expect(estimateCostUSD(state, { strategyRef: 'grounded-plan', analyzerRef: 'agent-analyzer' })).toBeCloseTo(0.2, 10)
    expect(estimateCostUSD(state, { strategyRef: 'split' })).toBeCloseTo(9, 10)
    expect(estimateCostUSD(state, { strategyRef: 'grounded-plan', analyzerRef: 'ghost' })).toBeNull()
    // no analyzerRef named → the analyzer is not part of the comparison
    expect(estimateCostUSD(state, { strategyRef: 'grounded-plan' })).toBeCloseTo(4.6, 10)
  })
})

describe('blockingVerdicts / retryIsFutile — a verdict is not a malfunction', () => {
  const failedStep = (id: string, cls: FailureClass) => ({
    stepId: id, runToken: `rt-${id}`, attempt: 1, status: StepRunStatus.failed,
    iterations: 1, output: null, failure: { class: cls, message: `${id} says no` },
  })
  const stateWith = (...steps: ReturnType<typeof failedStep>[]): State => {
    const s = fold([])
    s.steps.set('t1', new Map(steps.map(x => [x.stepId, x])))
    return s
  }

  it('lists only the steps that REJECTED, with their verdict text', () => {
    const state = stateWith(failedStep('verify', FailureClass.rejected), failedStep('build', FailureClass.provider_error))
    expect(blockingVerdicts(state, 't1')).toEqual([{ stepId: 'verify', message: 'verify says no' }])
  })

  it('calls a retry futile when EVERY failure is a verdict', () => {
    expect(retryIsFutile(stateWith(failedStep('verify', FailureClass.rejected)), 't1')).toBe(true)
  })

  /**
   * The case that must stay retryable. Clearing the provider error may change what the verdict
   * sees on the next pass, so refusing here would withhold a recovery that could genuinely work.
   */
  it('keeps a MIXED failure retryable — the error may be what the verdict is reacting to', () => {
    const state = stateWith(failedStep('verify', FailureClass.rejected), failedStep('build', FailureClass.provider_error))
    expect(retryIsFutile(state, 't1')).toBe(false)
  })

  it('is not futile when nothing failed at all', () => {
    expect(retryIsFutile(fold([]), 'nobody')).toBe(false)
    expect(blockingVerdicts(fold([]), 'nobody')).toEqual([])
  })

  /**
   * The whole admission rule for a retry, in one place. Three sites need the same verdict and only
   * two of them can raise an error: the actions door and the port each refuse with their own
   * message, and a read model has to decide whether to OFFER the retry at all. Spelled once, an
   * offer cannot disagree with the refusal that would follow it.
   */
  describe('canRetry', () => {
    const atStatus = (status: TaskStatus, ...steps: ReturnType<typeof failedStep>[]): State => {
      const s = stateWith(...steps)
      s.tasks.set('t1', taskFixture({ id: 't1', status }))
      return s
    }

    it('admits a blocked task whose failure could be cleared by running again', () => {
      expect(canRetry(atStatus(TASK_STATUS.blocked, failedStep('build', FailureClass.agent_error)), 't1')).toBe(true)
    })

    it('refuses every status but blocked — nothing else has a run waiting to resume', () => {
      for (const status of [TASK_STATUS.running, TASK_STATUS.cancelled, TASK_STATUS.done, TASK_STATUS.failed, TASK_STATUS.draft])
        expect(canRetry(atStatus(status, failedStep('build', FailureClass.agent_error)), 't1')).toBe(false)
    })

    it('refuses a blocked task held up only by verdicts', () => {
      expect(canRetry(atStatus(TASK_STATUS.blocked, failedStep('verify', FailureClass.rejected)), 't1')).toBe(false)
    })

    it('refuses a task nothing knows about', () => {
      expect(canRetry(fold([]), 'nobody')).toBe(false)
    })
  })
})

/**
 * The distinction that decides whether retry is offered, pinned because getting it wrong is
 * expensive in BOTH directions and the first attempt got it wrong one way.
 *
 * A worker signalling failure has done its own work badly — a fresh attempt re-does that work and
 * may well succeed, which is exactly what retry is for. An auditor signalling failure has JUDGED
 * work other steps produced; retry re-runs only what did not complete, so it meets the same
 * completed siblings and reaches the same verdict forever.
 */
describe('rejected is an AUDITOR verdict, not any signalled failure', () => {
  const failed = (id: string, cls: FailureClass) => ({
    stepId: id, runToken: `rt-${id}`, attempt: 1, status: StepRunStatus.failed,
    iterations: 1, output: null, failure: { class: cls, message: `${id} failed` },
  })
  const stateWith = (...steps: ReturnType<typeof failed>[]): State => {
    const s = fold([])
    s.steps.set('t1', new Map(steps.map(x => [x.stepId, x])))
    return s
  }

  it('keeps a worker failure retryable — its next attempt re-does the work', () => {
    expect(retryIsFutile(stateWith(failed('build', FailureClass.agent_error)), 't1')).toBe(false)
    expect(blockingVerdicts(stateWith(failed('build', FailureClass.agent_error)), 't1')).toEqual([])
  })

  it('refuses retry only for the verdict class', () => {
    expect(retryIsFutile(stateWith(failed('verify', FailureClass.rejected)), 't1')).toBe(true)
  })
})

/**
 * The two attempt derivations answer OPPOSITE questions, and conflating them broke cancel.
 *
 * nextAttempts: "which attempt should the next run start?" — deliberately attempt+1 once the task
 * is settled, so a retry gets a fresh workflow id instead of re-attaching to a dead one.
 * startedAttempts: "which attempt is running right now?" — what a cancel must target.
 *
 * cancelSubtree stamps `cancelled` BEFORE cancelWorkflowsFor runs, so `settled` is always true by
 * then: cancel asked nextAttempts and got an id one ahead of the live workflow, every time.
 */
describe('startedAttempts vs nextAttempts — cancel targets the running attempt', () => {
  const plan = planFixture({ steps: [stepFixture({ id: 'a' }), stepFixture({ id: 'b' })] })
  const running = (attempt: number) => ({
    stepId: 'a', runToken: 'rt', attempt, status: StepRunStatus.running,
    iterations: 1, output: null, failure: null,
  })
  const stateOf = (status: TaskStatus): State => {
    const s = fold([])
    s.tasks.set('t1', taskFixture({ id: 't1', status }))
    s.steps.set('t1', new Map([['a', running(1)]]))
    return s
  }

  it('targets the CURRENT attempt even after the task is stamped cancelled', () => {
    const state = stateOf(TASK_STATUS.cancelled)
    expect(startedAttempts(state, 't1', plan)).toEqual({ a: 1 })
    // the trap: nextAttempts yields the attempt AFTER the running one, which is not what cancel targets
    expect(nextAttempts(state, 't1', plan).a).toBe(2)
  })

  it('omits a step that never started, so cancel never invents a workflow id', () => {
    expect(startedAttempts(stateOf(TASK_STATUS.running), 't1', plan)).not.toHaveProperty('b')
    // nextAttempts fills it with 1 — right for starting, wrong for cancelling
    expect(nextAttempts(stateOf(TASK_STATUS.running), 't1', plan).b).toBe(1)
  })
})
