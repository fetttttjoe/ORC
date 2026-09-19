import { afterAll, describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, NO_CHAT, type Origin, type TaskNode } from '@orc/contracts'
import { openStorage, type EventLog, type Storage } from './storage'
import { openLiveState } from './live-state'
import { createTestDb, TEST_PROJECT_ID, waitFor } from './test-helpers'
import { taskFixture } from '@orc/contracts/fixtures'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

async function freshStorage(): Promise<Storage> {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  return storage
}

const task = (id: string, over: Partial<TaskNode> = {}): TaskNode => taskFixture({ id, title: id, ...over })

// This file folds synthetic history that no conversation ever produced, so every append here names
// the cli door and no chat — spelled at each call site, never defaulted in.
const CLI: Origin = NO_CHAT(Door.cli)

const createTask = (log: EventLog, t: TaskNode) =>
  log.append({ ...CLI, taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: t } })

// `settled` waits for the subscription to have applied everything committed so far. The stream is
// push-based and the handler is async, so a test that asserts immediately after an append races it.
const settled = async (until: () => boolean): Promise<void> => {
  if (!(await waitFor(async () => until(), 2000))) throw new Error('live state did not catch up within 2s')
}

describe('openLiveState', () => {
  it('seeds from the log at open, so history written before it existed is already there', async () => {
    const storage = await freshStorage()
    await createTask(storage.events, task('t1'))
    const live = await openLiveState(storage.events)
    try {
      expect(live.current().tasks.get('t1')?.title).toBe('t1')
    } finally {
      await live.close()
    }
  })

  it('applies events appended AFTER it opened, without re-reading the log', async () => {
    const storage = await freshStorage()
    const live = await openLiveState(storage.events)
    try {
      await createTask(storage.events, task('t2'))
      await settled(() => live.current().tasks.has('t2'))
      expect(live.current().tasks.get('t2')?.status).toBe('draft')

      await storage.events.append({
        ...CLI, taskId: 't2', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
        payload: { taskId: 't2', from: 'draft', to: 'awaiting_approval' },
      })
      await settled(() => live.current().tasks.get('t2')?.status === 'awaiting_approval')
    } finally {
      await live.close()
    }
  })

  // The equivalence that makes the cache safe to substitute for a refold anywhere: what it holds
  // must be what fold() would have produced from the same log, event for event.
  it('matches a from-scratch fold of the same log', async () => {
    const storage = await freshStorage()
    const live = await openLiveState(storage.events)
    try {
      await createTask(storage.events, task('a'))
      await createTask(storage.events, task('b', { parentId: 'a', depth: 1 }))
      await storage.events.append({
        ...CLI, taskId: 'a', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
        payload: { taskId: 'a', from: 'draft', to: 'awaiting_approval' },
      })
      await settled(() => live.current().tasks.get('a')?.status === 'awaiting_approval')
      const { fold } = await import('./projections')
      const batch = fold(await storage.events.all())
      const asJson = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Map ? Object.fromEntries(x) : x))
      expect(asJson(live.current())).toEqual(asJson(batch))
    } finally {
      await live.close()
    }
  })

  // A purge truncates the log out of band and no event announces it. Left alone the cache keeps
  // serving tasks that no longer exist — and cannot recover, because every new seq is BELOW the
  // cursor it is waiting past, so the stream goes permanently quiet.
  it('re-seeds when the log underneath it was truncated', async () => {
    const storage = await freshStorage()
    await createTask(storage.events, task('ghost'))
    const live = await openLiveState(storage.events)
    try {
      expect(live.current().tasks.has('ghost')).toBe(true)
      await storage.purge()
      await createTask(storage.events, task('fresh'))
      await settled(() => live.current().tasks.has('fresh'))
      expect(live.current().tasks.has('ghost')).toBe(false)
    } finally {
      await live.close()
    }
  })
})
