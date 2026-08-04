import { afterAll, describe, expect, it } from 'bun:test'
import { EVENT_KIND, planScope, slugId, type TaskNode } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { createLiveMemory } from './test-helpers'
import { consolidateTask } from './consolidate'
import { consolidateOnCompletion, createMemoryLifecycle } from './lifecycle'

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

const taskNode = (id: string, title: string): TaskNode => ({
  id, parentId: null, type: 'task', title, spec: '', status: 'done',
  zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-24T00:00:00.000Z',
})
const done = (taskId: string) =>
  eventFixture({ kind: EVENT_KIND.task_status_changed, payload: { taskId, from: 'running', to: 'done' } })

// A live memory stack seeded with the task's task_created event — consolidation folds the title
// out of the log, so a task the log has never heard of is the "unknown task" case.
async function harness(taskId: string, title: string) {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode(taskId, title) } })
  return live
}

// A completion nobody was listening for used to be lost for good: the subscription starts at the
// latest seq, and nothing supervises runs, so a task that finished while the CLI process was on its
// way out simply never got consolidated. Observed live on a real grounded run.
it('consolidates a task that finished while no lifecycle was attached', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t9', 'Detached task') } })
  await live.store.write({ id: 'sa', scope: planScope('t9'), title: 'Step A', summary: 'did A' }, { source: 'cli' })
  await live.store.write({ id: 'sb', scope: planScope('t9'), title: 'Step B', summary: 'did B' }, { source: 'cli' })
  // the completion lands with NOBODY subscribed — exactly the case that used to vanish
  await live.log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't9', from: 'running', to: 'done' } })
  const outcomeId = slugId('outcome t9')
  await live.projector.catchUp()
  expect(await live.store.get(outcomeId)).toBeNull()

  // starting a lifecycle later must find it
  const lifecycle = createMemoryLifecycle({ log: live.log, store: live.store, catchUp: () => live.projector.catchUp() })
  await lifecycle.start()
  await lifecycle.close()
  await live.projector.catchUp()
  expect(await live.store.get(outcomeId)).not.toBeNull()
})

describe('consolidateTask (integration)', () => {
  it('substantive task: non-force converges idempotently, force always rewrites', async () => {
    const { log, store, projector } = await harness('t1', 'My task')
    await store.write({ id: 'sa', scope: planScope('t1'), title: 'Step A', summary: 'did A' }, { source: 'cli' })
    await store.recordAccess('area-x', 'project', 'read', { source: 'agent', taskId: 't1' }) // provenance → substantive
    const outcomeId = slugId('outcome t1')
    const rev = async (): Promise<number> => { await projector.catchUp(); return (await store.get(outcomeId))?.revision ?? 0 }

    // reads a project note → substantive → the auto (non-force) path writes
    expect(await consolidateTask({ log, store }, 't1')).not.toBeNull()
    const r1 = await rev()
    expect(r1).toBeGreaterThan(0)
    // non-force again → the `consolidate:t1` idempotency key dedupes → no new event → revision unchanged
    await consolidateTask({ log, store }, 't1')
    expect(await rev()).toBe(r1)
    // force → no idempotency key → a fresh rewrite → revision advances (the 7dbfead fix)
    await consolidateTask({ log, store }, 't1', { force: true })
    expect(await rev()).toBe(r1 + 1)
  })

  it('unknown task → null; trivial task gated unless forced; a throwing distiller falls back to extractive', async () => {
    const { log, store, projector } = await harness('t2', 'Trivial task')
    await store.write({ id: 'sb', scope: planScope('t2'), title: 'Step B', summary: 'x' }, { source: 'cli' })
    await projector.catchUp()
    expect(await consolidateTask({ log, store }, 'no-such-task')).toBeNull()      // no task_created
    expect(await consolidateTask({ log, store }, 't2')).toBeNull()                // 1 step, no provenance → not substantive
    // force bypasses the gate; a distiller that throws is caught → the extractive note, not null/rejection
    const note = await consolidateTask({ log, store, distill: async () => { throw new Error('model down') } }, 't2', { force: true })
    expect(note?.title).toBe('Outcome: Trivial task')
  })
})

describe('consolidateOnCompletion (subscriber action)', () => {
  it('a done event consolidates (catch-up + write); a non-done event does nothing', async () => {
    const { log, store, projector } = await harness('t3', 'Subscribed task')
    await store.write({ id: 'sc', scope: planScope('t3'), title: 'Step C', summary: 'did C' }, { source: 'cli' })
    await store.recordAccess('area-y', 'project', 'read', { source: 'agent', taskId: 't3' })
    const deps = { log, store, catchUp: () => projector.catchUp() }
    const outcomeId = slugId('outcome t3')
    // a non-done transition → the classifier gates it → no note
    await consolidateOnCompletion(deps, eventFixture({ kind: EVENT_KIND.task_status_changed, payload: { taskId: 't3', from: 'running', to: 'blocked' } }))
    await projector.catchUp()
    expect(await store.get(outcomeId)).toBeNull()
    // a done event → trigger + the internal catch-up + consolidate → the outcome note appears
    await consolidateOnCompletion(deps, done('t3'))
    await projector.catchUp()
    expect(await store.get(outcomeId)).not.toBeNull()
  })

  it('swallows a consolidation error so the subscription stream is not wedged', async () => {
    const { log, store, projector } = await harness('t4', 'Boom task')
    // a store whose list throws → consolidateTask rejects → consolidateOnCompletion must still RESOLVE
    const throwingStore = { ...store, list: async (): Promise<never> => { throw new Error('read model down') } }
    const deps = { log, store: throwingStore, catchUp: () => projector.catchUp() }
    await expect(consolidateOnCompletion(deps, done('t4'))).resolves.toBeUndefined()
  })
})
