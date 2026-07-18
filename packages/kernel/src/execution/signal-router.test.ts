import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { EVENT_KIND, TASK_STATUS, type EventRecord, type SplitResult, type TaskNode } from '@orc/contracts'
import { EventLog } from '../eventlog'
import { createTestDb, TEST_PROJECT_ID } from '../test-helpers'
import { composeSplitResult, createSignalRouter } from './signal-router'

const split = { splitId: 'sp1', taskId: 'p', stepId: 's1', runToken: 'rt', childTaskId: 'c1', resolved: false }
const evt = (over: Partial<EventRecord>): EventRecord =>
  ({ seq: 1, projectId: TEST_PROJECT_ID, idempotencyKey: null, taskId: 'c1', stepId: null, runToken: null, kind: 'task_created', payload: {}, usage: null, ts: 'T', ...over })
const childTask = (id: string, parentId: string) => evt({
  taskId: id,
  payload: { task: { id, parentId, type: 'split', title: id, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 1, createdAt: 'T' } },
})

describe('composeSplitResult', () => {
  it('done: joins terminal-step summaries; collects subtree note (id, scope) pairs', () => {
    const events: EventRecord[] = [
      childTask('c1', 'p'),
      evt({ seq: 2, kind: 'plan_proposed', payload: { plan: { taskId: 'c1', version: 1, strategyRef: 'split', costEstimateUSD: null, steps: [
        { id: 'w1', role: 'worker', title: 'w1', instructions: 'x', executorRef: 'e', modelRef: 'f/m', skillRefs: [], toolRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn: [] },
        { id: 'w2', role: 'worker', title: 'w2', instructions: 'x', executorRef: 'e', modelRef: 'f/m', skillRefs: [], toolRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn: ['w1'] },
      ] } } }),
      evt({ seq: 3, kind: 'step_started', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', attempt: 1 } }),
      evt({ seq: 4, kind: 'step_completed', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', summary: 'first' } }),
      evt({ seq: 5, kind: 'step_started', stepId: 'w2', runToken: 'rt-w2', payload: { stepId: 'w2', runToken: 'rt-w2', attempt: 1 } }),
      evt({ seq: 6, kind: 'step_completed', stepId: 'w2', runToken: 'rt-w2', payload: { stepId: 'w2', runToken: 'rt-w2', summary: 'second' } }),
      evt({ seq: 7, kind: 'task_status_changed', payload: { taskId: 'c1', from: 'running', to: 'done' } }),
      evt({ seq: 8, taskId: null, kind: 'memory_written', payload: { note: { id: 'finding', scope: 'project', title: 'F', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' }, author: { source: 'agent', taskId: 'c1' } } }),
      evt({ seq: 9, taskId: null, kind: 'memory_written', payload: { note: { id: 'other', scope: 'project', title: 'O', categories: [], tags: [], links: [], paths: [], rules: [], summary: '', body: '' }, author: { source: 'agent', taskId: 'unrelated' } } }),
    ]
    const r = composeSplitResult(events, split)
    expect(r).toEqual({
      splitId: 'sp1', childTaskId: 'c1', outcome: 'done',
      summary: 'second',                       // w2 is the only terminal step (nothing depends on it)
      notes: [{ id: 'finding', scope: 'project' }],
    })
  })
  it('blocked: failing step message; cancelled: fixed summary', () => {
    const blocked = composeSplitResult([
      childTask('c1', 'p'),
      evt({ seq: 2, kind: 'step_started', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', attempt: 1 } }),
      evt({ seq: 3, kind: 'step_failed', stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', class: 'agent_error', message: 'nope' } }),
      evt({ seq: 4, kind: 'task_status_changed', payload: { taskId: 'c1', from: 'running', to: 'blocked' } }),
    ], split)
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.summary).toBe('nope')
    const cancelled = composeSplitResult([
      childTask('c1', 'p'),
      evt({ seq: 2, kind: 'task_status_changed', payload: { taskId: 'c1', from: 'running', to: 'cancelled' } }),
    ], split)
    expect(cancelled).toMatchObject({ outcome: 'cancelled', summary: 'cancelled' })
  })
})

describe('createSignalRouter (integration, real EventLog)', () => {
  let db: { url: string; drop: () => Promise<void> }
  let log: EventLog
  let router: { start(): Promise<void>; close(): Promise<void> } | null = null

  beforeEach(async () => {
    db = await createTestDb()
    log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
    router = null
  })
  afterEach(async () => {
    if (router) await router.close()
    await log.close()
    await db.drop()
  })

  const taskNode = (id: string, parentId: string | null): TaskNode =>
    ({ id, parentId, type: parentId ? 'split' : 'root', title: id, spec: '', status: TASK_STATUS.draft, zone: [], budgetUSD: null, depth: parentId ? 1 : 0, createdAt: 'T' })

  // parent + child tasks and the split that binds them (runToken = the parent step's send target)
  const seedSplit = async (): Promise<void> => {
    await log.append({ taskId: 'p', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('p', null) } })
    await log.append({ taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('c', 'p') } })
    await log.append({ taskId: 'p', stepId: 's1', runToken: 'rt', kind: EVENT_KIND.split_proposed, payload: { splitId: 'sp1', taskId: 'p', stepId: 's1', runToken: 'rt', childTaskId: 'c' } })
  }
  const terminal = (to: string) => log.append({
    taskId: 'c', stepId: null, runToken: null,
    kind: EVENT_KIND.task_status_changed, payload: { taskId: 'c', from: TASK_STATUS.running, to },
  })
  const resolvedCount = async (): Promise<number> => (await log.all()).filter(e => e.kind === EVENT_KIND.split_resolved).length
  const waitFor = async (pred: () => Promise<boolean>, ms = 3000): Promise<boolean> => {
    const start = Date.now()
    while (Date.now() - start < ms) { if (await pred()) return true; await Bun.sleep(50) }
    return false
  }

  it('route 1: terminal child appends split_resolved once and sends on split:<id> with idempotencyKey', async () => {
    const sends: { dest: string; result: SplitResult; topic: string; key: string }[] = []
    router = createSignalRouter({ log, onChildApproved: async () => {}, send: async (dest, result, topic, key) => { sends.push({ dest, result, topic, key }) } })
    await router.start()
    await seedSplit()
    await terminal(TASK_STATUS.done)
    expect(await waitFor(async () => (await resolvedCount()) === 1)).toBe(true)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ dest: 'rt', topic: 'split:sp1', key: 'sp1' })
    expect(sends[0]!.result).toMatchObject({ splitId: 'sp1', childTaskId: 'c', outcome: 'done' })
  })

  it('sweep: a terminal split that landed before start is resolved by start() alone', async () => {
    const sends: SplitResult[] = []
    await seedSplit()
    await terminal(TASK_STATUS.blocked) // lands with NO router subscribed
    router = createSignalRouter({ log, onChildApproved: async () => {}, send: async (_d, result) => { sends.push(result) } })
    await router.start() // sweep runs synchronously before returning
    expect(await resolvedCount()).toBe(1)
    expect(sends).toHaveLength(1)
    expect(sends[0]!.outcome).toBe('blocked')
  })

  it('sweep route 2: an approved pending-split child with no run gets startChildRun on start()', async () => {
    const approved: string[] = []
    await seedSplit()
    // child approved while the router was down — the plan_approved event will never be redelivered
    await log.append({ taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.plan_approved, payload: { taskId: 'c', version: 1, approvedAt: 'T', approvedBy: 'policy' } })
    await log.append({ taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 'c', from: TASK_STATUS.draft, to: TASK_STATUS.approved } })
    router = createSignalRouter({ log, onChildApproved: async id => { approved.push(id) }, send: async () => {} })
    await router.start() // sweep runs (and awaits onChildApproved) synchronously before returning
    expect(approved).toEqual(['c'])
  })

  it('route 2: plan_approved for a pending-split child calls onChildApproved', async () => {
    const approved: string[] = []
    router = createSignalRouter({ log, onChildApproved: async id => { approved.push(id) }, send: async () => {} })
    await router.start()
    await seedSplit()
    await log.append({ taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.plan_approved, payload: { taskId: 'c', version: 1, approvedAt: 'T', approvedBy: 'policy' } })
    expect(await waitFor(async () => approved.length > 0)).toBe(true)
    expect(approved).toEqual(['c'])
  })

  it('redelivery: a second terminal status does not double-append split_resolved', async () => {
    const sends: SplitResult[] = []
    router = createSignalRouter({ log, onChildApproved: async () => {}, send: async (_d, result) => { sends.push(result) } })
    await router.start()
    await seedSplit()
    await terminal(TASK_STATUS.done)
    expect(await waitFor(async () => (await resolvedCount()) === 1)).toBe(true)
    await terminal(TASK_STATUS.done) // duplicate delivery of the terminal event
    await Bun.sleep(200) // give the pump time to (not) re-resolve
    expect(await resolvedCount()).toBe(1)
    expect(sends).toHaveLength(1)
  })
})
