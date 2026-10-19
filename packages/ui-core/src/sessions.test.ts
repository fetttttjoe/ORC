import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { AUTHOR_SOURCE, Door, EVENT_KIND, IsolationTier, NO_CHAT, type EventInput, type MemoryAuthor, type Origin, type Scope, ScopeType } from '@orc/contracts'

// these histories are arranged through the terminal door; the run halves are the supervisor's
const CLI = NO_CHAT(Door.cli)
const SUPERVISOR = NO_CHAT(Door.supervisor)
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { createProjectSessions, type ProjectSessions, type SessionUpdate } from './sessions'
import { viewOf } from './views/registry'
import type { ViewParams } from './views/view'
import { VIEW } from './wire'
import { authorFixture, must, planNoteFixture } from '@orc/contracts/fixtures'

// Every read here goes through the door helper the tools use, against a REAL session: the views'
// own unit tests answer from a hand-built model, and what those cannot show is that the thing the
// session folds out of Postgres is the same thing a view reads.
const PROJECT: Scope = { type: ScopeType.project }
const taskScope = (id: string): Scope => ({ type: ScopeType.task, id, subtree: false })
const logOf = async (sessions: ProjectSessions, params: ViewParams<'timeline'> = { scope: PROJECT }) =>
  await viewOf(sessions, TEST_PROJECT_ID, VIEW.timeline, params) ?? []

// the subset the node-view assertion pins, parsed at the read boundary instead of cast
const TaskDetailView = z.object({ task: z.object({ title: z.string() }) })

const dbs: Array<{ drop: () => Promise<void> }> = []
// Everything setup() opens is torn down HERE, before its database is dropped, whether or not the
// test remembered — same idiom as graph-ui's server.test.ts. createProjectSessions holds an event
// stream AND a project watch; a test that returned early on a failed expect used to leave both
// alive against a database this afterAll then dropped.
const openSessions: Array<{ close: () => Promise<void> }> = []
const openStores: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  for (const s of openSessions) await s.close().catch(() => {})
  for (const st of openStores) await st.close().catch(() => {})
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

async function setup() {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  openStores.push(storage)
  const k = new Kernel(storage.events)
  // a task must name a workspace the fold has seen — one seeded record, then tasks as before
  await seedTestWorkspace(storage.events, CLI)
  const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'seed task', spec: '' }, CLI)
  const sessions = createProjectSessions({ url: db.url, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' } })
  openSessions.push(sessions)
  return { storage, taskId: t.id, sessions }
}

const claimsWritten = (why: string, author: MemoryAuthor, origin: Origin): EventInput => ({
  ...origin,
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.knowledge_written,
  payload: { added: [], changed: [], retired: [], files: [], why, decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author },
})

// a plan note of the task; its id IS the child step id (instantiateFrozenPlan)
const planNoteEvent = (taskId: string, id: string): EventInput => ({
  ...CLI,
  taskId, stepId: null, runToken: null, kind: EVENT_KIND.plan_note_written,
  payload: { note: planNoteFixture({ id, title: id }) },
})

// A frozen child plan step (post-expansion shape) carrying the note id verbatim.
const childStep = (id: string) => ({
  id, role: 'implementer', title: id, instructions: 'do it', executorRef: 'api-loop',
  modelRef: 'p/m', skillRefs: [], toolRefs: [], isolation: IsolationTier.local, zone: [],
  maxIterations: 8, dependsOn: [],
})

describe('ProjectSessions', () => {
  it('projects() omits event-less projects — a deleted chat leaves no row, even the cwd one', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const sessions = createProjectSessions({ url: db.url, cwdProject: { id: 'deleted-project', name: 'ghost' } })
    openSessions.push(sessions)
    expect(await sessions.projects()).toEqual([])
  })

  it('projects() names the cwd project; snapshot holds the seeded task', async () => {
    const { storage, taskId, sessions } = await setup()
    expect(await sessions.projects()).toEqual([{ id: TEST_PROJECT_ID, name: 'test-proj', dir: null }])
    const snap = await sessions.snapshot(TEST_PROJECT_ID)
    expect(snap.seq).toBeGreaterThan(0)
    expect(snap.graph.nodes.map(n => n.id)).toContain(taskId)
  })

  it('a freshly opened session lists the latest project identity from the log', async () => {
    const { storage, sessions } = await setup()
    for (const name of ['a', 'b']) {
      await storage.events.append({ ...CLI, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.project_identified, payload: { name, dir: '/' + name } })
    }
    await sessions.snapshot(TEST_PROJECT_ID)
    expect(await sessions.projects()).toEqual([{ id: TEST_PROJECT_ID, name: 'b', dir: '/b' }])
  })

  it('an opened session with no identity event lists the cwd project', async () => {
    const { sessions } = await setup()
    await sessions.snapshot(TEST_PROJECT_ID)
    expect(await sessions.projects()).toEqual([{ id: TEST_PROJECT_ID, name: 'test-proj', dir: null }])
  })

  it('a subscriber receives a patch adding exactly a newly created task', async () => {
    const { storage, sessions } = await setup()
    await sessions.snapshot(TEST_PROJECT_ID)
    const updates: SessionUpdate[] = []
    const unsub = await sessions.subscribe(TEST_PROJECT_ID, u => updates.push(u))
    const live = await new Kernel(storage.events).createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'live task', spec: '' }, CLI)
    for (let i = 0; i < 40 && updates.length === 0; i++) await Bun.sleep(50) // LISTEN/NOTIFY latency
    expect(updates).toHaveLength(1)
    expect(must(updates[0], 'updates[0]').patch.addNodes.map(n => n.id)).toEqual([live.id])
    expect(must(updates[0], 'updates[0]').event?.kind).toBe(EVENT_KIND.task_created)
    unsub()
  })

  it('since(oldSeq) returns the missed task in one cumulative patch; null when current', async () => {
    const { storage, sessions } = await setup()
    const { seq } = await sessions.snapshot(TEST_PROJECT_ID)
    const missed = await new Kernel(storage.events).createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'missed task', spec: '' }, CLI)
    const tip = (await storage.events.all()).at(-1)?.seq ?? 0
    // wait until the session has absorbed the append (its own subscription is async)
    for (let i = 0; i < 40 && (await sessions.snapshot(TEST_PROJECT_ID)).seq < tip; i++) await Bun.sleep(50)
    const u = await sessions.since(TEST_PROJECT_ID, seq)
    expect(u?.patch.addNodes.map(n => n.id)).toEqual([missed.id])
    expect(await sessions.since(TEST_PROJECT_ID, must(u, 'u').seq)).toBeNull()
  })

  it('an empty-patch event still notifies with a summary', async () => {
    const { storage, sessions } = await setup()
    await sessions.snapshot(TEST_PROJECT_ID)
    const updates: SessionUpdate[] = []
    const unsub = await sessions.subscribe(TEST_PROJECT_ID, u => updates.push(u))
    await storage.events.append({
      ...CLI,
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.knowledge_written,
      payload: { added: [{ id: 'abcd1234', location: 'knowledge/src/a.ts.md' }], changed: [], retired: [], files: ['knowledge/src/a.ts.md'], why: null, decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture() },
    })
    for (let i = 0; i < 40 && updates.length === 0; i++) await Bun.sleep(50)
    expect(updates).toHaveLength(1)
    expect(must(updates[0], 'updates[0]').summary?.kind).toBe(EVENT_KIND.knowledge_written)
    expect(must(updates[0], 'updates[0]').patch.addNodes).toEqual([])
    unsub()
  })

  it('the transcript, plans and timeline views read from the cached session', async () => {
    const { storage, taskId, sessions } = await setup()
    await storage.events.append({
      ...SUPERVISOR,
      taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: { text: 'hello there', toolCalls: [] } },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: null, estimated: false },
    })
    const items = await viewOf(sessions, TEST_PROJECT_ID, VIEW.transcript, { taskId })
    expect(items).toEqual([{ kind: 'message', iteration: 1, stepId: 's1', text: 'hello there' }])

    expect(await viewOf(sessions, TEST_PROJECT_ID, VIEW.plans, { taskId })).toBeNull() // no plan proposed
    const rows = await logOf(sessions, { scope: taskScope(taskId) })
    expect(must(rows.at(-1), 'rows.at(-1)').line).toContain('hello there')
    expect(await logOf(sessions, { scope: PROJECT, limit: 1 })).toHaveLength(1)
  })

  it('a task-scoped timeline attributes each task its own step rows + its author.taskId knowledge rows, and no sibling/ownerless knowledge row', async () => {
    const { storage, taskId: taskA, sessions } = await setup()
    // a second task in the same project — its step rows must never leak into A's log and vice versa
    const k = new Kernel(storage.events)
    // setup() already seeded TEST_WORKSPACE into this same log — this kernel reads the same fold
    const taskB = (await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'task B', spec: '' }, CLI)).id

    // each task's own step_started (envelope taskId carries the real owner)
    await storage.events.append({ ...SUPERVISOR, taskId: taskA, stepId: 'sa', runToken: 'ra', kind: EVENT_KIND.step_started, payload: { stepId: 'sa', runToken: 'ra', attempt: 1 } })
    await storage.events.append({ ...SUPERVISOR, taskId: taskB, stepId: 'sb', runToken: 'rb', kind: EVENT_KIND.step_started, payload: { stepId: 'sb', runToken: 'rb', attempt: 1 } })

    // project-scoped knowledge rows (envelope taskId null) authored by A, by B, and ownerless (cli)
    await storage.events.append(claimsWritten('claim-by-a', authorFixture({ source: AUTHOR_SOURCE.agent, taskId: taskA, origin: SUPERVISOR }), SUPERVISOR))
    await storage.events.append(claimsWritten('claim-by-b', authorFixture({ source: AUTHOR_SOURCE.agent, taskId: taskB, origin: SUPERVISOR }), SUPERVISOR))
    await storage.events.append(claimsWritten('ownerless-claim', authorFixture(), CLI)) // author.source 'cli', no taskId

    const linesFor = async (t: string): Promise<string[]> => (await logOf(sessions, { scope: taskScope(t) })).map(r => r.line)

    const aLines = await linesFor(taskA)
    expect(aLines.some(l => l.includes('sa'))).toBe(true) // A's own step row
    expect(aLines.some(l => l.includes('claim-by-a'))).toBe(true) // A-authored knowledge row
    expect(aLines.some(l => l.includes('sb'))).toBe(false) // NOT B's step row
    expect(aLines.some(l => l.includes('claim-by-b'))).toBe(false) // NOT B-authored knowledge row
    expect(aLines.some(l => l.includes('ownerless-claim'))).toBe(false) // NOT the ownerless knowledge row

    const bLines = await linesFor(taskB)
    expect(bLines.some(l => l.includes('sb'))).toBe(true)
    expect(bLines.some(l => l.includes('claim-by-b'))).toBe(true)
    expect(bLines.some(l => l.includes('sa'))).toBe(false)
    expect(bLines.some(l => l.includes('claim-by-a'))).toBe(false)
    expect(bLines.some(l => l.includes('ownerless-claim'))).toBe(false)
  })

  it('a timeline cursor filters BEFORE the limit slice, keeping the newest matching rows', async () => {
    const { storage, taskId, sessions } = await setup()
    const step = (id: string) => storage.events.append({
      ...SUPERVISOR,
      taskId, stepId: id, runToken: 'r1', kind: EVENT_KIND.step_started,
      payload: { stepId: id, runToken: 'r1', attempt: 1 },
    })
    const ask = (topic: string) => storage.events.append({
      ...SUPERVISOR,
      taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { question: `q-${topic}`, topic },
    })
    const s1 = await step('s1')
    const q1 = await ask('one')
    const s2 = await step('s2')
    const q2 = await ask('two')

    // sinceSeq is EXCLUSIVE: the row a poller already saw must not come back
    const since = await logOf(sessions, { scope: taskScope(taskId), sinceSeq: s1.seq })
    expect(since.map(r => r.seq)).toEqual([q1.seq, s2.seq, q2.seq])
    expect(since.every(r => r.seq > s1.seq)).toBe(true)

    const asked = await logOf(sessions, { scope: taskScope(taskId), kinds: [EVENT_KIND.feedback_requested] })
    expect(asked.map(r => r.seq)).toEqual([q1.seq, q2.seq])
    expect(asked.every(r => r.kind === EVENT_KIND.feedback_requested)).toBe(true)

    // composed with limit: the newest MATCHING row, not the newest event (which is q2's neighbour)
    expect((await logOf(sessions, { scope: taskScope(taskId), kinds: [EVENT_KIND.step_started], limit: 1 })).map(r => r.seq))
      .toEqual([s2.seq])
    expect((await logOf(sessions, { scope: taskScope(taskId), sinceSeq: q1.seq, limit: 1 })).map(r => r.seq)).toEqual([q2.seq])
    // whole-project reads take the same filters
    expect((await logOf(sessions, { scope: PROJECT, sinceSeq: q2.seq })).map(r => r.seq)).toEqual([])
    expect((await logOf(sessions, { scope: PROJECT, kinds: [EVENT_KIND.feedback_requested] })).map(r => r.seq))
      .toEqual([q1.seq, q2.seq])

    // beforeSeq is EXCLUSIVE and pages BACKWARD: the ledger asks for what precedes its oldest
    // row, and with limit it must get the rows nearest the cursor, not the start of the log
    // (the head of the unlimited read is the task's own task_created row, so assert the tail)
    const before = await logOf(sessions, { scope: taskScope(taskId), beforeSeq: q2.seq })
    expect(before.every(r => r.seq < q2.seq)).toBe(true)
    expect(before.map(r => r.seq).slice(-3)).toEqual([s1.seq, q1.seq, s2.seq])
    expect((await logOf(sessions, { scope: taskScope(taskId), beforeSeq: q2.seq, limit: 2 })).map(r => r.seq))
      .toEqual([q1.seq, s2.seq])
    expect((await logOf(sessions, { scope: PROJECT, beforeSeq: s1.seq, limit: 5 })).every(r => r.seq < s1.seq)).toBe(true)
  })

  // A guard, not a rendering test: the plan wire must not grow a serialized diagram back, because
  // a projection nothing renders is built and paid for on every request.
  it('the plan wire carries waves and notes only — no rendered diagram', async () => {
    const { storage, taskId, sessions } = await setup()
    await storage.events.append(planNoteEvent(taskId, 'sub'))
    await storage.events.append({
      ...CLI,
      taskId, stepId: null, runToken: null, kind: EVENT_KIND.plan_proposed,
      payload: { plan: { taskId, version: 1, strategyRef: 'split', costEstimateUSD: null, steps: [childStep('own')] } },
    })
    for (let i = 0; i < 40 && (await sessions.snapshot(TEST_PROJECT_ID)).seq < 2; i++) await Bun.sleep(50)

    const tp = await viewOf(sessions, TEST_PROJECT_ID, VIEW.plans, { taskId })
    expect(tp?.visual?.waves.flatMap(w => w.steps.map(s => s.id))).toEqual(['own'])
    expect(Object.keys(tp?.visual ?? {}).sort()).toEqual(['version', 'waves'])

    expect(Object.keys(must(await viewOf(sessions, TEST_PROJECT_ID, VIEW.planNotes, { taskId }), 'planNotes'))).toEqual(['notes'])
  })

  it('the node view resolves a task; unknown ids are null', async () => {
    const { taskId, sessions } = await setup()
    const task = TaskDetailView.parse(await viewOf(sessions, TEST_PROJECT_ID, VIEW.node, { id: taskId }))
    expect(task.task.title).toBe('seed task')
    expect(await viewOf(sessions, TEST_PROJECT_ID, VIEW.node, { id: 'nope' })).toBeNull()
  })
})
