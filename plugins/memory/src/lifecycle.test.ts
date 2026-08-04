import { describe, expect, it } from 'bun:test'
import { eventFixture } from '@orc/contracts/fixtures'
import { createDrain, taskCompletedId } from './lifecycle'

describe('createDrain', () => {
  // The lifecycle has TWO producers — the backlog pass and the live subscription — and they overlap
  // between subscribe() returning and the backlog starting. A single `inflight` slot held only the
  // most recent, so a completion landing in that window was never awaited and close() returned
  // while its write was still running.
  it('drains work that OVERLAPS, not just the most recently tracked', async () => {
    const { track, drain } = createDrain()
    const done: string[] = []
    let releaseFirst = (): void => {}
    const first = new Promise<void>(r => { releaseFirst = r }).then(() => void done.push('first'))
    track(first)
    track(Promise.resolve().then(() => void done.push('second'))) // overwrote `first` under one slot

    const drained = drain().then(() => done.slice().sort())
    // released on a LATER macrotask: a one-slot tracker resolves as soon as `second` settles (a
    // microtask away), so this is what separates "drained everything" from "drained the last one"
    setTimeout(releaseFirst, 0)
    // sorted, not ordered: tracking records SETTLEMENT and deliberately does not serialize
    // execution — the unblocked one finishes first. What must hold is that neither is missing.
    expect(await drained).toEqual(['first', 'second'])
  })

  it('a rejection settles the chain rather than poisoning it — close() must not throw', async () => {
    const { track, drain } = createDrain()
    const boom = track(Promise.reject(new Error('consolidate failed')))
    expect(boom).rejects.toThrow('consolidate failed') // still the caller's to surface
    await expect(drain()).resolves.toBeUndefined()
  })
})

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
