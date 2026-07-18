import { describe, expect, it } from 'bun:test'
import type { EventRecord, TaskNode } from '@orc/contracts'
import { EVENT_KIND } from '@orc/contracts'
import { planFixture, stepFixture } from '@orc/contracts/fixtures'
import { renderRootIndex, renderTaskFiles } from './render'

let seq = 0
const ev = (over: Partial<EventRecord>): EventRecord => ({
  seq: ++seq, projectId: 'p1', idempotencyKey: null, taskId: 't1', stepId: null, runToken: null,
  kind: EVENT_KIND.task_created, payload: {}, usage: null, ts: '2026-07-17T00:00:00.000Z', ...over,
})
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

describe('renderRootIndex', () => {
  it('lists running tasks under active runs', () => {
    const md = renderRootIndex([task({ status: 'running' })])
    expect(md).toContain('type: index')
    expect(md).toContain('Active runs')
    expect(md).toContain('tasks/t1/index.md')
    expect(md).toMatch(/^---\n[\s\S]+\n---\n/)
  })
})
