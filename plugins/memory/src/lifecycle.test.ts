import { describe, expect, it } from 'bun:test'
import { eventFixture } from '@orc/contracts/fixtures'
import { taskCompletedId } from './lifecycle'

describe('taskCompletedId', () => {
  it('returns the task id for a terminal (done) task_status_changed', () => {
    const e = eventFixture({ seq: 1, kind: 'task_status_changed', payload: { taskId: 't1', from: 'running', to: 'done' } })
    expect(taskCompletedId(e)).toBe('t1')
  })

  it('ignores non-done transitions and other event kinds — no premature or spurious consolidation', () => {
    const running = eventFixture({ seq: 2, kind: 'task_status_changed', payload: { taskId: 't1', from: 'approved', to: 'running' } })
    const failed = eventFixture({ seq: 3, kind: 'task_status_changed', payload: { taskId: 't1', from: 'running', to: 'failed' } })
    const other = eventFixture({ seq: 4, kind: 'memory_written', payload: { note: { id: 'n', title: 'T' }, author: { source: 'cli' } } })
    expect(taskCompletedId(running)).toBeNull()
    expect(taskCompletedId(failed)).toBeNull()
    expect(taskCompletedId(other)).toBeNull()
  })
})
