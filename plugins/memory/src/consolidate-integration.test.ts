import { afterAll, describe, expect, it } from 'bun:test'
import { AUTHOR_SOURCE, Door, EVENT_KIND, NO_CHAT, PAYLOAD_SCHEMAS, planScope, slugId, TASK_STATUS, WORKSPACE_KIND, type MemoryAuthor, type Origin, type TaskNode } from '@orc/contracts'
import { authorFixture, eventFixture } from '@orc/contracts/fixtures'
import { seedTestWorkspace, TEST_WORKSPACE, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { createLiveMemory } from './test-helpers'
import { consolidateTask, taskInfo, CONSOLIDATE_EXECUTOR } from './consolidate'
import { consolidateOnCompletion, createMemoryLifecycle } from './lifecycle'

// The author the composition root hands in (runtime.ts / `orc memory consolidate`): 'agent' named
// through `executor`, stamped with the workspace it writes from. The plugin builds none of its own.
// Consolidation is a background drain over a finished task, not a turn anyone typed, so it belongs
// to no chat and comes through the supervisor door; the log rows this file hand-builds are `orc`.
const CONSOLIDATE_ORIGIN: Origin = NO_CHAT(Door.supervisor)
const CLI_ORIGIN: Origin = NO_CHAT(Door.cli)
const CLI: MemoryAuthor = authorFixture()
const CONSOLIDATE_AUTHOR: MemoryAuthor = authorFixture({ source: AUTHOR_SOURCE.agent, executor: CONSOLIDATE_EXECUTOR, origin: CONSOLIDATE_ORIGIN })

// The builder shape BOTH composition roots pass (runtime.ts's lifecycle subscriber and `orc memory
// consolidate`): the plugin never invents an author, it asks for one PER TASK.
const authorForTask = (task: { id: string; workspaceId: string }): MemoryAuthor =>
  authorFixture({ source: AUTHOR_SOURCE.agent, workspaceId: task.workspaceId, executor: CONSOLIDATE_EXECUTOR, taskId: task.id, origin: CONSOLIDATE_ORIGIN })

const drops: (() => Promise<void>)[] = []
afterAll(async () => { for (const d of drops) await d() })

const taskNode = (id: string, title: string, workspaceId: string = TEST_WORKSPACE_ID): TaskNode => ({
  id, parentId: null, workspaceId, type: 'task', title, spec: '', status: TASK_STATUS.done,
  zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-24T00:00:00.000Z',
})
const done = (taskId: string) =>
  eventFixture({ kind: EVENT_KIND.task_status_changed, payload: { taskId, from: 'running', to: 'done' } })

// A live memory stack seeded with the task's task_created event — consolidation folds the title
// out of the log, so a task the log has never heard of is the "unknown task" case.
async function harness(taskId: string, title: string) {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.log.append({ ...CLI_ORIGIN, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode(taskId, title) } })
  return live
}

// A task that finishes while no listener is attached still gets consolidated: the subscription
// starts at the latest seq and nothing supervises runs, so consolidation must work retroactively
// (a real grounded run finished while the CLI process exited).
it('consolidates a task that finished while no lifecycle was attached', async () => {
  const live = await createLiveMemory()
  drops.push(live.close)
  await live.log.append({ ...CLI_ORIGIN, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t9', 'Detached task') } })
  await live.store.write({ id: 'sa', scope: planScope('t9'), title: 'Step A', summary: 'did A' }, CLI)
  await live.store.write({ id: 'sb', scope: planScope('t9'), title: 'Step B', summary: 'did B' }, CLI)
  // the completion lands with NOBODY subscribed — exactly the case that used to vanish
  await live.log.append({ ...CLI_ORIGIN, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't9', from: TASK_STATUS.running, to: TASK_STATUS.done } })
  const outcomeId = slugId('outcome t9')
  await live.projector.catchUp()
  expect(await live.store.get(outcomeId)).toBeNull()

  // starting a lifecycle later must find it
  const lifecycle = createMemoryLifecycle({ log: live.log, store: live.store, authorFor: () => CONSOLIDATE_AUTHOR, catchUp: () => live.projector.catchUp() })
  await lifecycle.start()
  await lifecycle.close()
  await live.projector.catchUp()
  expect(await live.store.get(outcomeId)).not.toBeNull()
})

describe('consolidateTask (integration)', () => {
  it('substantive task: non-force converges idempotently, force always rewrites', async () => {
    const { log, store, projector } = await harness('t1', 'My task')
    await store.write({ id: 'sa', scope: planScope('t1'), title: 'Step A', summary: 'did A' }, CLI)
    await store.recordAccess('area-x', 'project', 'read', authorFixture({ source: AUTHOR_SOURCE.agent, taskId: 't1', origin: { chatId: 'run:t1:v1', door: Door.supervisor } })) // provenance → substantive
    const outcomeId = slugId('outcome t1')
    const rev = async (): Promise<number> => { await projector.catchUp(); return (await store.get(outcomeId))?.revision ?? 0 }

    // reads a project note → substantive → the auto (non-force) path writes. Each call resolves for
    // itself — this test has no second half (no retireStepTrail) to thread a shared resolution into.
    expect(await consolidateTask({ log, store, authorFor: () => CONSOLIDATE_AUTHOR }, 't1', await taskInfo(log, 't1'))).not.toBeNull()
    const r1 = await rev()
    expect(r1).toBeGreaterThan(0)
    // non-force again → the `consolidate:t1` idempotency key dedupes → no new event → revision unchanged
    await consolidateTask({ log, store, authorFor: () => CONSOLIDATE_AUTHOR }, 't1', await taskInfo(log, 't1'))
    expect(await rev()).toBe(r1)
    // force → no idempotency key → a fresh rewrite → revision advances (the 7dbfead fix)
    await consolidateTask({ log, store, authorFor: () => CONSOLIDATE_AUTHOR }, 't1', await taskInfo(log, 't1'), { force: true })
    expect(await rev()).toBe(r1 + 1)
  })

  it('unknown task → null; trivial task gated unless forced; a throwing distiller falls back to extractive', async () => {
    const { log, store, projector } = await harness('t2', 'Trivial task')
    await store.write({ id: 'sb', scope: planScope('t2'), title: 'Step B', summary: 'x' }, CLI)
    await projector.catchUp()
    // 'no-such-task' resolves to null — the exact "skip rather than guess" case, not a special path
    expect(await consolidateTask({ log, store, authorFor: () => CONSOLIDATE_AUTHOR }, 'no-such-task', await taskInfo(log, 'no-such-task'))).toBeNull()
    expect(await consolidateTask({ log, store, authorFor: () => CONSOLIDATE_AUTHOR }, 't2', await taskInfo(log, 't2'))).toBeNull() // 1 step, no provenance → not substantive
    // force bypasses the gate; a distiller that throws is caught → the extractive note, not null/rejection
    const notes = await consolidateTask(
      { log, store, authorFor: () => CONSOLIDATE_AUTHOR, distill: async () => { throw new Error('model down') } },
      't2', await taskInfo(log, 't2'), { force: true },
    )
    expect(notes?.[0]?.title).toBe('Outcome: Trivial task')
  })
})

// MEASURED DEFECT: consolidation used to build ONE cwdAuthor from the supervisor's own
// checkout and stamp it on every outcome note. A task that ran in a worktree (its own workspace)
// then had its outcome filed under the SUPERVISOR's workspace — durable knowledge attributed to a
// checkout that never did the work, while the task's own branch was still unmerged. `authorFor`
// exists so the outcome always carries the workspace the WRITING TASK ran in.
describe('consolidateTask attributes the outcome to the TASK\'s workspace, not a fixed default', () => {
  it('the outcome note\'s author names the workspace the task ran in, even when a different one is the default', async () => {
    const live = await createLiveMemory()
    drops.push(live.close)
    // Two distinct, REAL workspace records — mirroring the supervisor's own checkout (A) and a
    // second worktree a task actually ran in (B). Real records because that is what a live
    // supervisor always has: one process, N adopted checkouts.
    await seedTestWorkspace(live.log, CLI_ORIGIN, '/test/workspace-a')
    const workspaceB = '22222222-0000-4000-8000-000000000002'
    await live.log.append({
      ...CLI_ORIGIN, taskId: null, stepId: null, runToken: null,
      kind: EVENT_KIND.workspace_created,
      payload: { workspace: { ...TEST_WORKSPACE, id: workspaceB, cwd: '/test/workspace-b', kind: WORKSPACE_KIND.worktree } },
    })

    const taskId = 't30'
    await live.log.append({
      ...CLI_ORIGIN, taskId: null, stepId: null, runToken: null,
      kind: EVENT_KIND.task_created,
      payload: { task: taskNode(taskId, 'Worked in a worktree', workspaceB) },
    })
    // two steps: salience-gated on its own (isSubstantive), no provenance access needed
    await live.store.write({ id: 'sa', scope: planScope(taskId), title: 'Step A', summary: 'did A' }, authorFixture({ source: AUTHOR_SOURCE.agent, workspaceId: workspaceB, taskId, origin: { chatId: `run:${taskId}:v1`, door: Door.supervisor } }))
    await live.store.write({ id: 'sb', scope: planScope(taskId), title: 'Step B', summary: 'did B' }, authorFixture({ source: AUTHOR_SOURCE.agent, workspaceId: workspaceB, taskId, origin: { chatId: `run:${taskId}:v1`, door: Door.supervisor } }))

    await consolidateTask({ log: live.log, store: live.store, authorFor: authorForTask }, taskId, await taskInfo(live.log, taskId), { force: true })
    await live.projector.catchUp()

    const outcomeId = slugId(`outcome ${taskId}`)
    // read the AUTHOR OFF THE LOG (memory_written), not off the projected note — the note this
    // fix is about is the one an operator would actually go looking at.
    const writes = (await live.log.after(0, [EVENT_KIND.memory_written]))
      .map(e => PAYLOAD_SCHEMAS.memory_written.safeParse(e.payload))
      .flatMap(p => (p.success && p.data.note.id === outcomeId ? [p.data] : []))
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.at(-1)?.author.workspaceId).toBe(workspaceB)
    expect(writes.at(-1)?.author.workspaceId).not.toBe(TEST_WORKSPACE_ID) // TEST_WORKSPACE_ID IS workspace A
  })
})

describe('consolidateOnCompletion (subscriber action)', () => {
  it('a done event consolidates (catch-up + write); a non-done event does nothing', async () => {
    const { log, store, projector } = await harness('t3', 'Subscribed task')
    await store.write({ id: 'sc', scope: planScope('t3'), title: 'Step C', summary: 'did C' }, CLI)
    await store.recordAccess('area-y', 'project', 'read', authorFixture({ source: AUTHOR_SOURCE.agent, taskId: 't3', origin: { chatId: 'run:t3:v1', door: Door.supervisor } }))
    const deps = { log, store, authorFor: () => CONSOLIDATE_AUTHOR, catchUp: () => projector.catchUp() }
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
    const deps = { log, store: throwingStore, authorFor: () => CONSOLIDATE_AUTHOR, catchUp: () => projector.catchUp() }
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
    await live.store.write({ id: 'step-a', scope: planScope('t20'), title: 'Step A', summary: 'did A', tier: 'episodic', retention: 'expirable' }, CLI)
    await live.store.write({ id: 'step-b', scope: planScope('t20'), title: 'Step B', summary: 'did B', tier: 'episodic', retention: 'expirable' }, CLI)
    await live.store.write({ id: 'masterplan', scope: planScope('t20'), title: 'Masterplan', summary: 'the split', rationale: 'why it was split this way' }, CLI)
    await live.projector.catchUp()

    await consolidateOnCompletion({ log: live.log, store: live.store, authorFor: () => CONSOLIDATE_AUTHOR, catchUp: live.projector.catchUp }, done('t20'))
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
    await live.store.write({ id: 'step-a', scope: planScope('t21'), title: 'Step A', summary: 'a real finding worth keeping', tier: 'episodic', retention: 'expirable' }, CLI)
    await live.store.write({ id: 'step-b', scope: planScope('t21'), title: 'Step B', summary: 'a second real finding', tier: 'episodic', retention: 'expirable' }, CLI)
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

    await consolidateOnCompletion({ log: live.log, store: spy, authorFor: () => CONSOLIDATE_AUTHOR, catchUp: live.projector.catchUp }, done('t21'))
    expect(calls).toEqual(['consolidate', 'retire'])
  })
})
