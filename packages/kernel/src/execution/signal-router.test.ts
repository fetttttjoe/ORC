import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { ApprovedBy, Door, EVENT_KIND, FailureClass, NO_CHAT, REACTION, ReactionFailedPayload, RunOutcome, TASK_STATUS, TaskType, type EventRecord, type Origin, type SplitResult, type TaskNode, type TaskStatus } from '@orc/contracts'
import { Kernel } from '../kernel'
import { fold } from '../projections'
import { openStorage, type EventLog } from '../storage'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, waitFor } from '../test-helpers'
import { composeSplitResult, createSignalRouter } from './signal-router'
import { authorFixture, eventFixture, must } from '@orc/contracts/fixtures'

// these arrangements are a client acting through no chat; the split below is asked for from a real
// one, because that chat is what a supervisor reaction has to answer to
const CLI: Origin = NO_CHAT(Door.cli)
const SPLIT_CHAT: Origin = { chatId: 'chat-split', door: Door.web }

const split = { splitId: 'sp1', taskId: 'p', stepId: 's1', runToken: 'rt', childTaskId: 'c1', resolved: false }
const evt = (over: Partial<EventRecord>): EventRecord =>
  eventFixture({ projectId: TEST_PROJECT_ID, taskId: 'c1', ts: 'T', ...over })
const childTask = (id: string, parentId: string) => evt({
  taskId: id,
  payload: { task: { id, parentId, workspaceId: TEST_WORKSPACE_ID, type: TaskType.split, title: id, spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 1, createdAt: 'T' } },
})

describe('composeSplitResult', () => {
  it('done: joins terminal-step summaries; collects subtree note (id, scope) pairs', () => {
    const events: EventRecord[] = [
      childTask('c1', 'p'),
      evt({ seq: 2, kind: EVENT_KIND.plan_proposed, payload: { plan: { taskId: 'c1', version: 1, strategyRef: 'split', costEstimateUSD: null, steps: [
        { id: 'w1', role: 'worker', title: 'w1', instructions: 'x', executorRef: 'e', modelRef: 'f/m', skillRefs: [], toolRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn: [] },
        { id: 'w2', role: 'worker', title: 'w2', instructions: 'x', executorRef: 'e', modelRef: 'f/m', skillRefs: [], toolRefs: [], isolation: 'local', zone: [], maxIterations: 5, dependsOn: ['w1'] },
      ] } } }),
      evt({ seq: 3, kind: EVENT_KIND.step_started, stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', attempt: 1 } }),
      evt({ seq: 4, kind: EVENT_KIND.step_completed, stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', summary: 'first' } }),
      evt({ seq: 5, kind: EVENT_KIND.step_started, stepId: 'w2', runToken: 'rt-w2', payload: { stepId: 'w2', runToken: 'rt-w2', attempt: 1 } }),
      evt({ seq: 6, kind: EVENT_KIND.step_completed, stepId: 'w2', runToken: 'rt-w2', payload: { stepId: 'w2', runToken: 'rt-w2', summary: 'second' } }),
      evt({ seq: 7, kind: EVENT_KIND.task_status_changed, payload: { taskId: 'c1', from: 'running', to: 'done' } }),
    ]
    // knowledge events arrive separately: they are NOT router kinds, so the router fetches them
    // only when it actually composes a result rather than on every routed event
    const knowledge: EventRecord[] = [
      evt({ seq: 8, taskId: 'c1', kind: EVENT_KIND.knowledge_written, payload: { added: [{ id: 'aaaaaaaa', location: 'knowledge/a.md' }, { id: 'bbbbbbbb', location: 'knowledge/b.md' }], changed: [], retired: [], files: ['knowledge/a.md', 'knowledge/b.md'], why: 'w', decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture({ taskId: 'c1' }) } }),
      evt({ seq: 9, taskId: 'c1', kind: EVENT_KIND.knowledge_written, payload: { added: [], changed: [], retired: [{ id: 'bbbbbbbb', location: 'knowledge/b.md' }], files: ['knowledge/b.md'], why: 'w', decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture({ taskId: 'c1' }) } }),
      evt({ seq: 10, taskId: 'unrelated', kind: EVENT_KIND.knowledge_written, payload: { added: [{ id: 'cccccccc', location: 'knowledge/c.md' }], changed: [], retired: [], files: [], why: 'w', decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture({ taskId: 'unrelated' }) } }),
    ]
    const r = composeSplitResult(events, knowledge, split)
    expect(r).toEqual({
      splitId: 'sp1', childTaskId: 'c1', outcome: RunOutcome.done,
      summary: 'second',                       // w2 is the only terminal step (nothing depends on it)
      claims: [{ id: 'aaaaaaaa', location: 'knowledge/a.md' }],
    })
  })
  it('blocked: failing step message; cancelled: fixed summary', () => {
    const blocked = composeSplitResult([
      childTask('c1', 'p'),
      evt({ seq: 2, kind: EVENT_KIND.step_started, stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', attempt: 1 } }),
      evt({ seq: 3, kind: EVENT_KIND.step_failed, stepId: 'w1', runToken: 'rt-w1', payload: { stepId: 'w1', runToken: 'rt-w1', class: FailureClass.agent_error, message: 'nope' } }),
      evt({ seq: 4, kind: EVENT_KIND.task_status_changed, payload: { taskId: 'c1', from: TASK_STATUS.running, to: TASK_STATUS.blocked } }),
    ], [], split)
    expect(blocked.outcome).toBe(RunOutcome.blocked)
    expect(blocked.summary).toBe('nope')
    const cancelled = composeSplitResult([
      childTask('c1', 'p'),
      evt({ seq: 2, kind: EVENT_KIND.task_status_changed, payload: { taskId: 'c1', from: 'running', to: 'cancelled' } }),
    ], [], split)
    expect(cancelled).toMatchObject({ outcome: 'cancelled', summary: 'cancelled' })
  })
})

describe('createSignalRouter (integration, real EventLog)', () => {
  let db: { url: string; drop: () => Promise<void> }
  let log: EventLog
  let router: { start(): Promise<void>; close(): Promise<void> } | null = null

  beforeEach(async () => {
    db = await createTestDb()
    log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    router = null
  })
  afterEach(async () => {
    if (router) await router.close()
    await log.close()
    await db.drop()
  })

  const taskNode = (id: string, parentId: string | null): TaskNode =>
    ({ id, parentId, workspaceId: TEST_WORKSPACE_ID, type: parentId ? TaskType.split : TaskType.generic, title: id, spec: '', status: TASK_STATUS.draft, zone: [], budgetUSD: null, depth: parentId ? 1 : 0, createdAt: 'T' })

  // parent + child tasks and the split that binds them (runToken = the parent step's send target)
  const seedSplit = async (): Promise<void> => {
    await log.append({ ...CLI, taskId: 'p', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('p', null) } })
    await log.append({ ...CLI, taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('c', 'p') } })
    await log.append({ ...SPLIT_CHAT, taskId: 'p', stepId: 's1', runToken: 'rt', kind: EVENT_KIND.split_proposed, payload: { splitId: 'sp1', taskId: 'p', stepId: 's1', runToken: 'rt', childTaskId: 'c' } })
  }
  const terminal = (to: TaskStatus) => log.append({
    ...CLI, taskId: 'c', stepId: null, runToken: null,
    kind: EVENT_KIND.task_status_changed, payload: { taskId: 'c', from: TASK_STATUS.running, to },
  })
  const resolvedCount = async (): Promise<number> => (await log.all()).filter(e => e.kind === EVENT_KIND.split_resolved).length

  it('routes live feedback_provided with the committed event idempotency key', async () => {
    const sends: Array<{ dest: string; message: string; topic: string; key: string }> = []
    router = createSignalRouter({
      log,
      onChildApproved: async () => {},
      onRunRequested: async () => {},
      onCancelled: async () => {},
      send: async () => {},
      sendFeedback: async (dest, message, topic, key) => { sends.push({ dest, message, topic, key }) },
    })
    await router.start()
    await log.append({ ...CLI, taskId: 'f', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('f', null) } })
    await log.append({ ...CLI, taskId: 'f', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 'f', from: TASK_STATUS.draft, to: TASK_STATUS.running } })
    const event = await log.append({
      ...CLI, taskId: 'f', stepId: 'plan', runToken: 'step:f:plan:a1', kind: EVENT_KIND.feedback_provided,
      payload: { topic: 'approval', text: 'approve', author: authorFixture() },
    })

    expect(await waitFor(async () => sends.length === 1)).toBe(true)
    expect(sends).toEqual([{
      dest: 'step:f:plan:a1', message: 'approve', topic: 'feedback:approval', key: `feedback:${event.seq}`,
    }])
  })

  it('startup replays feedback only while its task is running', async () => {
    const sends: Array<{ dest: string; key: string }> = []
    for (const [id, status] of [['running', TASK_STATUS.running], ['done', TASK_STATUS.done]] as const) {
      await log.append({ ...CLI, taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode(id, null) } })
      await log.append({ ...CLI, taskId: id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: id, from: TASK_STATUS.draft, to: status } })
      await log.append({
        ...CLI, taskId: id, stepId: 'plan', runToken: `step:${id}:plan:a1`, kind: EVENT_KIND.feedback_provided,
        payload: { topic: id, text: 'answer', author: authorFixture() },
      })
    }
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {}, send: async () => {},
      sendFeedback: async (dest, _message, _topic, key) => { sends.push({ dest, key }) },
    })

    await router.start()

    const event = must((await log.byTask('running')).find(e => e.kind === EVENT_KIND.feedback_provided), 'feedback provided event')
    expect(sends).toEqual([{ dest: 'step:running:plan:a1', key: `feedback:${event.seq}` }])
  })

  it('startup heals a reply committed before its immediate send failed', async () => {
    const kernel = new Kernel(log, undefined, undefined, async () => { throw new Error('simulated send failure') })
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    const task = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'feedback recovery' }, CLI)
    await log.append({
      ...CLI, taskId: task.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: task.id, from: TASK_STATUS.draft, to: TASK_STATUS.running },
    })
    const runToken = `step:${task.id}:s1:a1`
    await log.append({
      ...CLI, taskId: task.id, stepId: 's1', runToken, kind: EVENT_KIND.feedback_requested,
      payload: { question: 'continue?', topic: 'consent' },
    })

    await expect(kernel.replyFeedback(task.id, 'yes', CLI)).rejects.toThrow('simulated send failure')
    const provided = must((await log.byTask(task.id)).find(e => e.kind === EVENT_KIND.feedback_provided), 'feedback provided event')
    expect(await kernel.openFeedback(task.id)).toBeNull()

    const sends: Array<{ dest: string; message: string; topic: string; key: string }> = []
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {}, send: async () => {},
      sendFeedback: async (dest, message, topic, key) => { sends.push({ dest, message, topic, key }) },
    })
    await router.start()

    expect(sends).toEqual([{
      dest: runToken, message: 'yes', topic: 'feedback:consent', key: `feedback:${provided.seq}`,
    }])
  })

  it('route 1: terminal child appends split_resolved once and sends on split:<id> with idempotencyKey', async () => {
    const sends: { dest: string; result: SplitResult; topic: string; key: string }[] = []
    router = createSignalRouter({ log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {}, send: async (dest, result, topic, key) => { sends.push({ dest, result, topic, key }) }, sendFeedback: async () => {} })
    await router.start()
    await seedSplit()
    await terminal(TASK_STATUS.done)
    expect(await waitFor(async () => (await resolvedCount()) === 1)).toBe(true)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toMatchObject({ dest: 'rt', topic: 'split:sp1', key: 'sp1' })
    expect(must(sends[0], 'first send').result).toMatchObject({ splitId: 'sp1', childTaskId: 'c', outcome: 'done' })
    // the reaction answers to the chat that ASKED for the split, stamped with the supervisor's door
    const resolved = must((await log.all()).find(e => e.kind === EVENT_KIND.split_resolved), 'split resolved event')
    expect({ chatId: resolved.chatId, door: resolved.door }).toEqual({ chatId: SPLIT_CHAT.chatId, door: Door.supervisor })
  })

  it('route 1: a knowledge_written claim the child recorded reaches the parent split_resolved claims', async () => {
    const sends: { dest: string; result: SplitResult; topic: string; key: string }[] = []
    router = createSignalRouter({ log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {}, send: async (dest, result, topic, key) => { sends.push({ dest, result, topic, key }) }, sendFeedback: async () => {} })
    await router.start()
    await seedSplit()
    await log.append({
      ...CLI, taskId: 'c', stepId: 'w1', runToken: 'rt-w1', kind: EVENT_KIND.knowledge_written,
      payload: {
        added: [{ id: 'aaaaaaaa', location: 'knowledge/a.md' }], changed: [], retired: [], files: ['knowledge/a.md'],
        why: 'w', decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture({ taskId: 'c' }),
      },
    })
    await terminal(TASK_STATUS.done)
    expect(await waitFor(async () => (await resolvedCount()) === 1)).toBe(true)
    expect(must(sends[0], 'first send').result.claims).toEqual([{ id: 'aaaaaaaa', location: 'knowledge/a.md' }])
  })

  it('sweep: a terminal split that landed before start is resolved by start() alone', async () => {
    const sends: SplitResult[] = []
    await seedSplit()
    await terminal(TASK_STATUS.blocked) // lands with NO router subscribed
    router = createSignalRouter({ log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {}, send: async (_d, result) => { sends.push(result) }, sendFeedback: async () => {} })
    await router.start() // sweep runs synchronously before returning
    expect(await resolvedCount()).toBe(1)
    expect(sends).toHaveLength(1)
    expect(must(sends[0], 'first send').outcome).toBe(RunOutcome.blocked)
  })

  it('sweep route 2: an approved pending-split child with no run gets startChildRun on start()', async () => {
    const approved: string[] = []
    await seedSplit()
    // child approved while the router was down — the plan_approved event will never be redelivered
    await log.append({ ...CLI, taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.plan_approved, payload: { taskId: 'c', version: 1, approvedAt: 'T', approvedBy: ApprovedBy.policy } })
    await log.append({ ...CLI, taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 'c', from: TASK_STATUS.draft, to: TASK_STATUS.approved } })
    router = createSignalRouter({ log, onChildApproved: async id => { approved.push(id) }, onRunRequested: async () => {}, onCancelled: async () => {}, send: async () => {}, sendFeedback: async () => {} })
    await router.start() // sweep runs (and awaits onChildApproved) synchronously before returning
    expect(approved).toEqual(['c'])
  })

  it('route 2: plan_approved for a pending-split child calls onChildApproved', async () => {
    const approved: string[] = []
    router = createSignalRouter({ log, onChildApproved: async id => { approved.push(id) }, onRunRequested: async () => {}, onCancelled: async () => {}, send: async () => {}, sendFeedback: async () => {} })
    await router.start()
    await seedSplit()
    await log.append({ ...CLI, taskId: 'c', stepId: null, runToken: null, kind: EVENT_KIND.plan_approved, payload: { taskId: 'c', version: 1, approvedAt: 'T', approvedBy: ApprovedBy.policy } })
    expect(await waitFor(async () => approved.length > 0)).toBe(true)
    expect(approved).toEqual(['c'])
  })

  it('redelivery: a second terminal status does not double-append split_resolved', async () => {
    const sends: SplitResult[] = []
    router = createSignalRouter({ log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {}, send: async (_d, result) => { sends.push(result) }, sendFeedback: async () => {} })
    await router.start()
    await seedSplit()
    await terminal(TASK_STATUS.done)
    expect(await waitFor(async () => (await resolvedCount()) === 1)).toBe(true)
    await terminal(TASK_STATUS.done) // duplicate delivery of the terminal event
    await Bun.sleep(200) // give the pump time to (not) re-resolve
    expect(await resolvedCount()).toBe(1)
    expect(sends).toHaveLength(1)
  })

  it('a run_requested event asks the runtime to start that run, with its recorded cwd', async () => {
    const started: Array<{ taskId: string; cwd: string | null; retry: boolean }> = []
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async (taskId, o) => { started.push({ taskId, ...o }) },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start()
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_requested, payload: { taskId: 't1', cwd: '/tree', retry: false } })
    expect(await waitFor(async () => started.length > 0)).toBe(true)
    expect(started).toEqual([{ taskId: 't1', cwd: '/tree', retry: false }])
  })

  it('sweep: a run_requested that landed before start still starts the run', async () => {
    const started: string[] = []
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    // lands with NO router subscribed — the pump never redelivers it, only start()'s sweep can catch it
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_requested, payload: { taskId: 't1', cwd: null, retry: false } })
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async taskId => { started.push(taskId) },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start() // sweep runs synchronously before returning
    expect(started).toEqual(['t1'])
  })

  // A request nothing can ever serve must not be retried forever. startRunAt admits only
  // approved/running/blocked, so a run_requested left over from before a task settled was
  // re-attempted and re-refused on EVERY boot — three done tasks did exactly that on all 18
  // supervisor starts.
  it('sweep: a run_requested for a task that has since settled is NOT re-served', async () => {
    const started: string[] = []
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_requested, payload: { taskId: 't1', cwd: null, retry: false } })
    // the task finished afterwards — the ask is answered by the outcome, not by another run
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: TASK_STATUS.running, to: TASK_STATUS.done } })
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async taskId => { started.push(taskId) },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start()
    expect(started).toEqual([])
  })

  // The other half of the same rule, and the reason the skip uses TERMINAL_TASK_STATUS rather than
  // this file's local TERMINAL (which also holds `blocked`): blocked is the state a retry resumes
  // FROM, so an unserved retry MUST still be redelivered by the sweep.
  it('sweep: a run_requested for a BLOCKED task is still served — that is what retry resumes from', async () => {
    const started: string[] = []
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: TASK_STATUS.running, to: TASK_STATUS.blocked } })
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_requested, payload: { taskId: 't1', cwd: null, retry: true } })
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async taskId => { started.push(taskId) },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start()
    expect(started).toEqual(['t1'])
  })

  it('a task stamped cancelled asks the runtime to cancel its workflows', async () => {
    const cancelled: string[] = []
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onRunRequested: async () => {},
      onCancelled: async id => { cancelled.push(id) },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start()
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: TASK_STATUS.running, to: TASK_STATUS.cancelled } })
    expect(await waitFor(async () => cancelled.length > 0)).toBe(true)
    expect(cancelled).toEqual(['t1'])
  })

  // A reaction that throws is the runtime failing at its own job. It used to leave nothing but a
  // console.warn on the supervisor's stdout: the client had been told its ask was recorded, and
  // `orc status` showed a task that simply never moved — at the terminal, a hang.
  it('a reaction that throws is recorded as data, naming the cause, once per cause', async () => {
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async () => { throw new Error('nothing can serve this') },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start()
    const asker: Origin = { chatId: 'chat-ask', door: Door.web }
    await log.append({ ...asker, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    const asked = await log.append({ ...asker, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_requested, payload: { taskId: 't1', cwd: null, retry: false } })

    const failures = async () => (await log.byTask('t1')).filter(e => e.kind === EVENT_KIND.reaction_failed)
    expect(await waitFor(async () => (await failures()).length > 0)).toBe(true)
    const recorded = ReactionFailedPayload.parse(must((await failures())[0], 'reaction failed event').payload)
    expect(recorded).toEqual({
      reaction: REACTION.runRequested, taskId: 't1', message: 'nothing can serve this', causeSeq: asked.seq,
    })
    // the diagnosis belongs to the chat whose ask failed — otherwise the client that asked never
    // sees why its task did not move
    const diagnosis = must((await failures())[0], 'reaction failed event')
    expect({ chatId: diagnosis.chatId, door: diagnosis.door }).toEqual({ chatId: 'chat-ask', door: Door.supervisor })

    // a fresh supervisor sweeps the same unserved request on every boot — the diagnosis is keyed by
    // the CAUSE, so a permanently broken reaction cannot grow the log without bound
    const second = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async () => { throw new Error('nothing can serve this') },
      send: async () => {}, sendFeedback: async () => {},
    })
    await second.start()
    await second.close()
    expect(await failures()).toHaveLength(1)
  })

  // The reactor route (knowledge provenance plan T2): a hand-made commit's hook event reaches an
  // injected handler, so the composition root can run the free restamp/heal reaction the operator
  // ran by hand twice on 2026-08-03 (commit → restamp → drift 0, ~1 min, zero LLM cost each time).
  describe('commit_recorded routing', () => {
    const commit = (sha: string, paths: string[]) =>
      log.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.commit_recorded, payload: { sha, paths, workspaceId: TEST_WORKSPACE_ID } })

    it('a live commit_recorded event reaches onCommitRecorded with its payload', async () => {
      const seen: Array<{ sha: string; paths: string[] }> = []
      router = createSignalRouter({
        log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {},
        onCommitRecorded: async p => { seen.push({ sha: p.sha, paths: [...p.paths] }) },
        send: async () => {}, sendFeedback: async () => {},
      })
      await router.start()
      await commit('a'.repeat(40), ['src/x.ts'])
      expect(await waitFor(async () => seen.length > 0)).toBe(true)
      expect(seen).toEqual([{ sha: 'a'.repeat(40), paths: ['src/x.ts'] }])
    })

    it('sweep: only the LATEST commit that landed while down is served on start()', async () => {
      // the reaction is idempotent corpus-wide (restamp covers everything behind), so serving
      // every historical commit on every boot would be pure duplicate work
      await commit('b'.repeat(40), ['a.ts'])
      await commit('c'.repeat(40), ['b.ts'])
      const seen: string[] = []
      router = createSignalRouter({
        log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {},
        onCommitRecorded: async p => { seen.push(p.sha) },
        send: async () => {}, sendFeedback: async () => {},
      })
      await router.start()
      expect(seen).toEqual(['c'.repeat(40)])
    })

    it('without a handler the event is ignored, not an error', async () => {
      router = createSignalRouter({
        log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {},
        send: async () => {}, sendFeedback: async () => {},
      })
      await router.start()
      await commit('d'.repeat(40), [])
      await Bun.sleep(200)
      expect((await log.all()).filter(e => e.kind === EVENT_KIND.reaction_failed)).toHaveLength(0)
    })

    it('a throwing handler is contained as reaction_failed naming the commit reaction', async () => {
      router = createSignalRouter({
        log, onChildApproved: async () => {}, onRunRequested: async () => {}, onCancelled: async () => {},
        onCommitRecorded: async () => { throw new Error('memory down') },
        send: async () => {}, sendFeedback: async () => {},
      })
      await router.start()
      const c = await commit('e'.repeat(40), ['x.ts'])
      const failures = async () => (await log.all()).filter(e => e.kind === EVENT_KIND.reaction_failed)
      expect(await waitFor(async () => (await failures()).length > 0)).toBe(true)
      const recorded = ReactionFailedPayload.parse(must((await failures())[0], 'reaction failed event').payload)
      expect(recorded).toEqual({ reaction: REACTION.commitRecorded, taskId: null, message: 'memory down', causeSeq: c.seq })
    })
  })

  it('the failure is folded onto the task, so status can say why it never moved', async () => {
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async () => { throw new Error('budget exhausted') },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start()
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_requested, payload: { taskId: 't1', cwd: null, retry: false } })
    expect(await waitFor(async () => fold(await log.all()).reactionFailures.has('t1'))).toBe(true)
    expect(fold(await log.all()).reactionFailures.get('t1')?.map(f => f.message)).toEqual(['budget exhausted'])
  })

  it('sweep: a retry request that landed after an earlier run still starts it', async () => {
    const started: Array<{ taskId: string; retry: boolean }> = []
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    // an earlier run already happened — the OLD "does this task have any run" gate would have
    // wrongly treated the request below as already served
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_started, payload: { taskId: 't1', planVersion: 1, retryIndex: 0, workflowId: 'run:t1:v1', cwd: null } })
    // the retry request lands AFTER that run, with no router subscribed
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.run_requested, payload: { taskId: 't1', cwd: null, retry: true } })
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onCancelled: async () => {},
      onRunRequested: async (taskId, o) => { started.push({ taskId, retry: o.retry }) },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start() // sweep runs synchronously before returning
    expect(started).toEqual([{ taskId: 't1', retry: true }])
  })

  it('sweep: a cancelled task that landed before start still cancels its workflows', async () => {
    const cancelled: string[] = []
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: taskNode('t1', null) } })
    // lands with NO router subscribed — DBOS recovery on THIS boot would otherwise resume the
    // workflow with nobody ever telling it to stop
    await log.append({ ...CLI, taskId: 't1', stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: 't1', from: TASK_STATUS.running, to: TASK_STATUS.cancelled } })
    router = createSignalRouter({
      log, onChildApproved: async () => {}, onRunRequested: async () => {},
      onCancelled: async id => { cancelled.push(id) },
      send: async () => {}, sendFeedback: async () => {},
    })
    await router.start() // sweep runs synchronously before returning
    expect(cancelled).toEqual(['t1'])
  })
})
