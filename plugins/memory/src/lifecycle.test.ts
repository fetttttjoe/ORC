import { describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, NOTE_TIER, NO_CHAT, planScope, type EventRecord, type MemoryAuthor, type NoteSummary } from '@orc/contracts'
import { TEST_WORKSPACE_ID, authorFixture, eventFixture } from '@orc/contracts/fixtures'
import { CONSOLIDATE_EXECUTOR, type ConsolidationLog, type ConsolidationStore } from './consolidate'
import { consolidateOnCompletion, createDrain, taskCompletedId } from './lifecycle'

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

describe('consolidateOnCompletion resolves the completed task once', () => {
  const TASK = 'reso-task-1'
  // Consolidation is a background drain over a completed task, not a turn anyone typed, so it
  // belongs to no chat and comes through the supervisor door.
  const CONSOLIDATE_AUTHOR: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, executor: CONSOLIDATE_EXECUTOR, origin: NO_CHAT(Door.supervisor) }

  const created: EventRecord = eventFixture({
    taskId: TASK, kind: EVENT_KIND.task_created,
    payload: {
      task: {
        id: TASK, parentId: null, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title: 'Resolved once',
        spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-26T00:00:00.000Z',
      },
    },
  })
  const doneEvent: EventRecord = eventFixture({ kind: EVENT_KIND.task_status_changed, payload: { taskId: TASK, from: 'running', to: 'done' } })

  // one episodic step note: enough for retireStepTrail to reach its author, too little for
  // isSubstantive — so consolidateTask never writes and the test is about the resolution only
  const episodicStep: NoteSummary = {
    id: 'step-a', scope: planScope(TASK), title: 'Step A', tier: NOTE_TIER.episodic,
    categories: [], tags: [], summary: 'did A', hits: 0, lastAccessedAt: null,
    sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID,
  }

  it('reads task_created ONCE per completion — not once for the outcome and again for the archive', async () => {
    let taskCreatedReads = 0
    const log: ConsolidationLog = {
      after: async (_seq, kinds) => {
        if (kinds?.includes(EVENT_KIND.task_created)) taskCreatedReads += 1
        return [created].filter(e => !kinds || kinds.includes(e.kind))
      },
    }
    const archivedCalls: { entries: ReadonlyArray<{ id: string; scope: string }>; author: MemoryAuthor }[] = []
    const store: ConsolidationStore = {
      list: async () => [episodicStep],
      write: async () => { throw new Error('consolidateTask should not write for a non-substantive task') },
      setArchivedAll: async (entries, _archived, author) => { archivedCalls.push({ entries, author }) },
    }
    const deps = { log, store, authorFor: () => CONSOLIDATE_AUTHOR }

    await consolidateOnCompletion(deps, doneEvent)

    expect(taskCreatedReads).toBe(1)
    // the trail was still archived under the resolved author — shared lookup, not a skipped one
    expect(archivedCalls).toEqual([{ entries: [{ id: 'step-a', scope: planScope(TASK) }], author: CONSOLIDATE_AUTHOR }])
  })
})

describe('taskCompletedId', () => {
  it('returns the task id for a terminal (done) task_status_changed', () => {
    const e = eventFixture({ seq: 1, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: 'running', to: 'done' } })
    expect(taskCompletedId(e)).toBe('t1')
  })

  it('ignores non-done transitions and other event kinds — no premature or spurious consolidation', () => {
    const running = eventFixture({ seq: 2, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: 'approved', to: 'running' } })
    const failed = eventFixture({ seq: 3, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: 'running', to: 'failed' } })
    const other = eventFixture({ seq: 4, kind: EVENT_KIND.memory_written, payload: { note: { id: 'n', title: 'T' }, author: authorFixture() } })
    expect(taskCompletedId(running)).toBeNull()
    expect(taskCompletedId(failed)).toBeNull()
    expect(taskCompletedId(other)).toBeNull()
  })
})
