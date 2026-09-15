import { afterAll, describe, expect, it } from 'bun:test'
import { EVENT_KIND, planScope, slugId, type MemoryAuthor, type TaskNode } from '@orc/contracts'
import { eventFixture } from '@orc/contracts/fixtures'
import { TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { createLiveMemory } from './test-helpers'
import { consolidateTask, CONSOLIDATE_EXECUTOR } from './consolidate'
import { consolidateOnCompletion, createMemoryLifecycle } from './lifecycle'

// The author the composition root hands in (runtime.ts / `orc memory consolidate`): 'agent' named
// through `executor`, stamped with the workspace it writes from. The plugin builds none of its own.
const CONSOLIDATE_AUTHOR: MemoryAuthor = { source: 'agent', workspaceId: TEST_WORKSPACE_ID, executor: CONSOLIDATE_EXECUTOR }

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

const taskNode = (id: string, title: string): TaskNode => ({
  id, parentId: null, workspaceId: TEST_WORKSPACE_ID, type: 'task', title, spec: '', status: 'done',
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
  await live.store.write({ id: 'sa', scope: planScope('t9'), title: 'Step A', summary: 'did A' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
  await live.store.write({ id: 'sb', scope: planScope('t9'), title: 'Step B', summary: 'did B' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
  // the completion lands with NOBODY subscribed — exactly the case that used to vanish
  await live.log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't9', from: 'running', to: 'done' } })
  const outcomeId = slugId('outcome t9')
  await live.projector.catchUp()
  expect(await live.store.get(outcomeId)).toBeNull()

  // starting a lifecycle later must find it
  const lifecycle = createMemoryLifecycle({ log: live.log, store: live.store, author: CONSOLIDATE_AUTHOR, catchUp: () => live.projector.catchUp() })
  await lifecycle.start()
  await lifecycle.close()
  await live.projector.catchUp()
  expect(await live.store.get(outcomeId)).not.toBeNull()
})

describe('consolidateTask (integration)', () => {
  it('substantive task: non-force converges idempotently, force always rewrites', async () => {
    const { log, store, projector } = await harness('t1', 'My task')
    await store.write({ id: 'sa', scope: planScope('t1'), title: 'Step A', summary: 'did A' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.recordAccess('area-x', 'project', 'read', { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't1' }) // provenance → substantive
    const outcomeId = slugId('outcome t1')
    const rev = async (): Promise<number> => { await projector.catchUp(); return (await store.get(outcomeId))?.revision ?? 0 }

    // reads a project note → substantive → the auto (non-force) path writes
    expect(await consolidateTask({ log, store, author: CONSOLIDATE_AUTHOR }, 't1')).not.toBeNull()
    const r1 = await rev()
    expect(r1).toBeGreaterThan(0)
    // non-force again → the `consolidate:t1` idempotency key dedupes → no new event → revision unchanged
    await consolidateTask({ log, store, author: CONSOLIDATE_AUTHOR }, 't1')
    expect(await rev()).toBe(r1)
    // force → no idempotency key → a fresh rewrite → revision advances (the 7dbfead fix)
    await consolidateTask({ log, store, author: CONSOLIDATE_AUTHOR }, 't1', { force: true })
    expect(await rev()).toBe(r1 + 1)
  })

  it('unknown task → null; trivial task gated unless forced; a throwing distiller falls back to extractive', async () => {
    const { log, store, projector } = await harness('t2', 'Trivial task')
    await store.write({ id: 'sb', scope: planScope('t2'), title: 'Step B', summary: 'x' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await projector.catchUp()
    expect(await consolidateTask({ log, store, author: CONSOLIDATE_AUTHOR }, 'no-such-task')).toBeNull()      // no task_created
    expect(await consolidateTask({ log, store, author: CONSOLIDATE_AUTHOR }, 't2')).toBeNull()                // 1 step, no provenance → not substantive
    // force bypasses the gate; a distiller that throws is caught → the extractive note, not null/rejection
    const notes = await consolidateTask({ log, store, author: CONSOLIDATE_AUTHOR, distill: async () => { throw new Error('model down') } }, 't2', { force: true })
    expect(notes?.[0]?.title).toBe('Outcome: Trivial task')
  })
})

describe('consolidateOnCompletion (subscriber action)', () => {
  it('a done event consolidates (catch-up + write); a non-done event does nothing', async () => {
    const { log, store, projector } = await harness('t3', 'Subscribed task')
    await store.write({ id: 'sc', scope: planScope('t3'), title: 'Step C', summary: 'did C' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await store.recordAccess('area-y', 'project', 'read', { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't3' })
    const deps = { log, store, author: CONSOLIDATE_AUTHOR, catchUp: () => projector.catchUp() }
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
    const deps = { log, store: throwingStore, author: CONSOLIDATE_AUTHOR, catchUp: () => projector.catchUp() }
    await expect(consolidateOnCompletion(deps, done('t4'))).resolves.toBeUndefined()
  })
})

describe('the step trail retires with the task, the design record does not', () => {
  /**
   * Every finished task leaves ~5-6 plan-scope notes behind for good. Measured on this corpus: 23
   * live EPISODIC notes carrying zero body characters, and 18 PLAN-tier notes carrying 42,596 —
   * every rationale and uncertainty behind those decompositions. archive.ts's task-settled rule
   * treats both alike, which is a fine judgement for an operator running `recheck --apply` and the
   * wrong one for something that fires on its own.
   */
  it('archives the empty step trail and keeps the plan notes', async () => {
    const live = await harness('t20', 'Trail task')
    await live.store.write({ id: 'step-a', scope: planScope('t20'), title: 'Step A', summary: 'did A', tier: 'episodic', retention: 'expirable' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await live.store.write({ id: 'step-b', scope: planScope('t20'), title: 'Step B', summary: 'did B', tier: 'episodic', retention: 'expirable' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await live.store.write({ id: 'masterplan', scope: planScope('t20'), title: 'Masterplan', summary: 'the split', rationale: 'why it was split this way' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await live.projector.catchUp()

    await consolidateOnCompletion({ log: live.log, store: live.store, author: CONSOLIDATE_AUTHOR, catchUp: live.projector.catchUp }, done('t20'))
    await live.projector.catchUp()

    expect(await live.store.get('step-a', planScope('t20'))).toBeNull()
    expect(await live.store.get('step-b', planScope('t20'))).toBeNull()
    // the reasoning survives — `orc plan-notes` still reads this for a settled task.
    // Narrowed by tier rather than reached for: `rationale` is a plan-tier field, and the union
    // store.get returns is exactly what stops a semantic note from pretending to have one.
    const kept = await live.store.get('masterplan', planScope('t20'))
    expect(kept?.tier).toBe('plan')
    expect(kept?.tier === 'plan' ? kept.rationale : '').toContain('why it was split')
  })

  /**
   * ORDER, asserted directly rather than through a side effect.
   *
   * The obvious test — archive first, expect an empty outcome note — PASSES either way, because
   * setArchivedAll is event-first and the projector has not drained when consolidation reads. The
   * rows are still there. So the wrong order is invisible today by accident of projection lag, and
   * a test resting on that observation guards nothing (verified: flipping the calls kept it green).
   * Recording the call sequence is what actually pins the contract.
   */
  it('consolidates BEFORE it retires — asserted on call order, not on a side effect', async () => {
    const live = await harness('t21', 'Ordering task')
    // two steps: consolidation is salience-gated, and a single trail note does not clear it
    await live.store.write({ id: 'step-a', scope: planScope('t21'), title: 'Step A', summary: 'a real finding worth keeping', tier: 'episodic', retention: 'expirable' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await live.store.write({ id: 'step-b', scope: planScope('t21'), title: 'Step B', summary: 'a second real finding', tier: 'episodic', retention: 'expirable' }, { source: 'cli', workspaceId: TEST_WORKSPACE_ID })
    await live.projector.catchUp()

    const calls: string[] = []
    const spy = new Proxy(live.store, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver)
        if (typeof v !== 'function') return v
        return (...args: unknown[]) => {
          // the outcome write is consolidation's observable act; setArchivedAll is the retire's
          if (prop === 'write' && (args[0] as { id?: string })?.id === slugId('outcome t21')) calls.push('consolidate')
          if (prop === 'setArchivedAll') calls.push('retire')
          return (v as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    })

    await consolidateOnCompletion({ log: live.log, store: spy, author: CONSOLIDATE_AUTHOR, catchUp: live.projector.catchUp }, done('t21'))
    expect(calls).toEqual(['consolidate', 'retire'])
  })
})
