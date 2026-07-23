import { describe, expect, it } from 'bun:test'
import { type EventRecord, type TaskNode } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import { planFixture, stepFixture } from '@orc/contracts/fixtures'
import { eventFixture } from '@orc/contracts/fixtures'
import { renderRootIndex, renderTaskFiles } from './render'

let seq = 0
const ev = (over: Partial<EventRecord>): EventRecord =>
  eventFixture({ seq: ++seq, ts: '2026-07-17T00:00:00.000Z', ...over })
const task = (over: Partial<TaskNode> = {}): TaskNode => ({
  id: 't1', parentId: null, type: 'generic', title: 'demo', spec: 'do it', status: 'running',
  zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-17T00:00:00.000Z', ...over,
})

describe('renderTaskFiles', () => {
  it('emits task index with a mermaid DAG, a plan file, log, and a session', () => {
    seq = 0
    const plan = planFixture({ taskId: 't1', version: 1, steps: [stepFixture({ id: 's1' })] })
    const events: EventRecord[] = [
      ev({ kind: EVENT_KIND.task_created, payload: { task: task() } }),
      ev({ kind: EVENT_KIND.plan_proposed, payload: { plan } }),
      ev({ kind: EVENT_KIND.step_started, stepId: 's1', runToken: 'r', payload: { stepId: 's1', runToken: 'r', attempt: 1 } }),
      ev({ kind: EVENT_KIND.tool_call, stepId: 's1', runToken: 'r', payload: { stepId: 's1', runToken: 'r', iteration: 1, toolCallId: 'c1', toolName: 'fs_write', input: { path: 'x.txt' } } }),
    ]
    const files = renderTaskFiles('t1', events)
    expect(files['tasks/t1/index.md']).toContain('type: task')
    expect(files['tasks/t1/index.md']).toContain('graph TD')
    expect(files['tasks/t1/index.md']).toContain('s1')
    expect(files['tasks/t1/index.md']).toMatch(/^---\n[\s\S]+\n---\n/)
    expect(files['tasks/t1/plan-v1.md']).toContain('type: plan')
    expect(files['tasks/t1/log.md']).toContain('type: log')
    expect(files['tasks/t1/sessions/s1.md']).toContain('fs_write')
  })
})

describe('renderTaskFiles — ## Usage table', () => {
  // a plan-step step, plus an agent_call carrying envelope usage bound to that step
  // per-step runTokens, as production issues them: the fold dedupes usage by
  // (runToken, iteration) — at-least-once redelivery must not double-bill — so a shared
  // token across steps would silently swallow every step's usage after the first.
  const agentCall = (stepId: string, usage: EventRecord['usage']) =>
    ev({ kind: EVENT_KIND.agent_call, stepId, runToken: `step:t1:${stepId}:a1`, usage, payload: { stepId, runToken: `step:t1:${stepId}:a1`, iteration: 1, request: {}, response: {} } })

  it('tabulates per-step usage in stored order with a totals row; pins null-cost and absent-cacheRead', () => {
    seq = 0
    const plan = planFixture({
      taskId: 't1', version: 1,
      steps: [stepFixture({ id: 's1' }), stepFixture({ id: 's2' })],
    })
    const events: EventRecord[] = [
      ev({ kind: EVENT_KIND.task_created, payload: { task: task() } }),
      ev({ kind: EVENT_KIND.plan_proposed, payload: { plan } }),
      // s1: full usage, costUSD set, cacheReadTokens present
      agentCall('s1', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, costUSD: 0.05, estimated: false }),
      // s2: costUSD null → placeholder; cacheReadTokens absent → `?? 0`
      agentCall('s2', { inputTokens: 200, outputTokens: 40, costUSD: null, estimated: false }),
    ]
    const md = renderTaskFiles('t1', events)['tasks/t1/index.md']!
    // header + separator
    expect(md).toContain('## Usage\n\n| Step | Input | Output | Cache Read | Cost USD |\n| --- | --- | --- | --- | --- |')
    // per-step rows, in stored order
    expect(md).toContain('| s1 | 100 | 20 | 10 | 0.05 |')
    expect(md).toContain('| s2 | 200 | 40 | 0 | — |') // null-cost placeholder + absent cacheRead → 0
    // totals row: costs sum over the non-null step(s); tokens are additive
    expect(md).toContain('| **Totals** | 300 | 60 | 10 | 0.05 |')
    // stored order: s1 row before s2 row before totals
    expect(md.indexOf('| s1 |')).toBeLessThan(md.indexOf('| s2 |'))
    expect(md.indexOf('| s2 |')).toBeLessThan(md.indexOf('| **Totals** |'))
    // the Totals row is the single source of task token totals — no separate duplicate line
    expect(md).not.toContain('_tokens in/out:')
  })

  it('empty view: no plan yet renders the italic gap, not an empty table', () => {
    seq = 0
    const md = renderTaskFiles('t1', [ev({ kind: EVENT_KIND.task_created, payload: { task: task() } })])['tasks/t1/index.md']!
    expect(md).toContain('## Usage\n\n_no plan yet_')
    expect(md).not.toContain('| Step | Input |')
  })

  it('two renders of a usage history are byte-identical', () => {
    seq = 0
    const plan = planFixture({ taskId: 't1', version: 1, steps: [stepFixture({ id: 's1' }), stepFixture({ id: 's2' })] })
    const events: EventRecord[] = [
      ev({ kind: EVENT_KIND.task_created, payload: { task: task() } }),
      ev({ kind: EVENT_KIND.plan_proposed, payload: { plan } }),
      agentCall('s1', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, costUSD: 0.05, estimated: false }),
      agentCall('s2', { inputTokens: 200, outputTokens: 40, costUSD: null, estimated: false }),
    ]
    expect(renderTaskFiles('t1', events)).toEqual(renderTaskFiles('t1', events))
  })
})

describe('renderTaskFiles — execution and lineage graphs', () => {
  it('renders operation nodes with attempts; unresolved is visually distinct from done/failed', () => {
    seq = 0
    const plan = planFixture({ taskId: 't1', version: 1, steps: [stepFixture({ id: 's1' })] })
    const rt = 'step:t1:s1:a1'
    const op = (operationId: string, kind: string, payload: Record<string, unknown>) =>
      ev({ kind: EVENT_KIND.operation_started, stepId: 's1', runToken: rt, payload: { operationId, ...payload } })
    const events: EventRecord[] = [
      ev({ kind: EVENT_KIND.task_created, payload: { task: task() } }),
      ev({ kind: EVENT_KIND.plan_proposed, payload: { plan } }),
      ev({ kind: EVENT_KIND.step_started, stepId: 's1', runToken: rt, payload: { stepId: 's1', runToken: rt, attempt: 1 } }),
      op(`${rt}:model:1`, 'operation_started', { attempt: 1, operationKind: 'model', name: 'fake/m', before: {} }),
      ev({ kind: EVENT_KIND.operation_completed, stepId: 's1', runToken: rt, payload: { operationId: `${rt}:model:1`, attempt: 1, after: {} } }),
      op(`${rt}:tool:1:c9`, 'operation_started', { attempt: 2, operationKind: 'tool', name: 'fs_write', before: {} }),
    ]
    const md = renderTaskFiles('t1', events)['tasks/t1/execution.md']!
    expect(md).toContain('type: execution')
    expect(md).toContain('model fake/m · completed · attempts 1')
    expect(md).toContain('tool fs_write · started · attempts 2')
    expect(md).toMatch(/op1\[[^\]]*\]:::unresolved/)
    expect(md).toMatch(/op0\[[^\]]*\]:::done/)
    expect(md).toContain('stroke-dasharray') // unresolved is visually distinct
    // deterministic node/edge order: op0 (earlier startedSeq) renders before op1
    expect(md.indexOf('op0[')).toBeLessThan(md.indexOf('op1['))
  })

  it('renders step → artifact lineage edges with hash prefix and size', () => {
    seq = 0
    const rt = 'step:t1:s1:a1'
    const events: EventRecord[] = [
      ev({ kind: EVENT_KIND.task_created, payload: { task: task() } }),
      ev({ kind: EVENT_KIND.artifact_produced, stepId: 's1', runToken: rt, payload: { path: 'report.md', sha256: 'ab'.repeat(32), size: 42 } }),
    ]
    const md = renderTaskFiles('t1', events)['tasks/t1/lineage.md']!
    expect(md).toContain('type: lineage')
    expect(md).toContain('report.md · sha256:abababababab… · 42B')
    expect(md).toContain('s1 --> art0')
    // no receipts → explicit empty view, deterministic
    const empty = renderTaskFiles('t1', [ev({ kind: EVENT_KIND.task_created, payload: { task: task() } })])['tasks/t1/lineage.md']!
    expect(empty).toContain('_no declared outputs_')
  })

  it('two renders of one history are byte-identical', () => {
    seq = 0
    const events: EventRecord[] = [ev({ kind: EVENT_KIND.task_created, payload: { task: task() } })]
    expect(renderTaskFiles('t1', events)).toEqual(renderTaskFiles('t1', events))
  })
})

describe('renderRootIndex', () => {
  it('lists running tasks under active runs', () => {
    const md = renderRootIndex([task({ status: 'running' })])
    expect(md).toContain('type: index')
    expect(md).toContain('Active runs')
    expect(md).toContain('tasks/t1/index.md')
    expect(md).toMatch(/^---\n[\s\S]+\n---\n/)
  })

  it('renders the parent→child task-expansion graph with status labels, deterministically sorted', () => {
    const parent = task({ id: 'p1', title: 'parent', status: 'blocked', depth: 0 })
    const child = task({ id: 'c1', parentId: 'p1', title: 'child', status: 'done', depth: 1 })
    const md = renderRootIndex([child, parent]) // input order must not matter
    expect(md).toContain('Task expansion')
    expect(md).toContain('t0["parent · blocked"]')
    expect(md).toContain('t1["child · done"]')
    expect(md).toContain('t0 --> t1')
    expect(md).toBe(renderRootIndex([parent, child]))
  })
})
