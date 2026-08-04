import { afterAll, describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { EVENT_KIND, ISOLATION_TIER, TASK_STATUS } from '@orc/contracts'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { noteNodeId } from './graph'
import { createProjectSessions, type SessionUpdate } from './sessions'

// nodeDetail returns an opaque view (Promise<unknown | null>); these name the subsets each
// assertion pins, parsed at the read boundary instead of cast.
const BacklinksView = z.object({ backlinks: z.array(z.object({ id: z.string() })) })
const TaskDetailView = z.object({ task: z.object({ title: z.string() }) })
const NoteHitsView = z.object({ hits: z.number() })

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
  const t = await k.createTask({ title: 'seed task', spec: '' })
  const sessions = createProjectSessions({ url: db.url, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' } })
  openSessions.push(sessions)
  return { storage, taskId: t.id, sessions }
}

const noteEvent = (id: string) => ({
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: { note: { id, title: id }, author: { source: 'cli' as const } },
})

// a plan-note in the parent's plan scope; its id IS the child step id (instantiateFrozenPlan),
// which is how planNotes correlates the decomposition graph to child execution.
const planNoteEvent = (taskId: string, id: string, links: Array<{ id: string; kind: string }> = []) => ({
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: {
    note: { id, title: id, scope: `plan-${taskId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, tier: 'plan' as const, links },
    author: { source: 'cli' as const },
  },
})

// A frozen child plan step (post-expansion shape) carrying the note id verbatim.
const childStep = (id: string) => ({
  id, role: 'implementer', title: id, instructions: 'do it', executorRef: 'api-loop',
  modelRef: 'p/m', skillRefs: [], toolRefs: [], isolation: ISOLATION_TIER.local, zone: [],
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

  it('a subscriber receives a patch adding exactly a newly appended note', async () => {
    const { storage, sessions } = await setup()
    await sessions.snapshot(TEST_PROJECT_ID)
    const updates: SessionUpdate[] = []
    const unsub = await sessions.subscribe(TEST_PROJECT_ID, u => updates.push(u))
    await storage.events.append(noteEvent('live-note'))
    for (let i = 0; i < 40 && updates.length === 0; i++) await Bun.sleep(50) // LISTEN/NOTIFY latency
    expect(updates).toHaveLength(1)
    expect(updates[0]!.patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'live-note')])
    expect(updates[0]!.event?.kind).toBe(EVENT_KIND.memory_written)
    unsub()
  })

  it('since(oldSeq) returns the missed note in one cumulative patch; null when current', async () => {
    const { storage, sessions } = await setup()
    const { seq } = await sessions.snapshot(TEST_PROJECT_ID)
    const appended = await storage.events.append(noteEvent('missed-note'))
    // wait until the session has absorbed the append (its own subscription is async)
    for (let i = 0; i < 40 && (await sessions.snapshot(TEST_PROJECT_ID)).seq < appended.seq; i++) await Bun.sleep(50)
    const u = await sessions.since(TEST_PROJECT_ID, seq)
    expect(u?.patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'missed-note')])
    expect(await sessions.since(TEST_PROJECT_ID, u!.seq)).toBeNull()
  })

  it('an empty-patch event (task_status_changed-like) still notifies with a summary', async () => {
    const { storage, sessions } = await setup()
    await sessions.snapshot(TEST_PROJECT_ID)
    const updates: SessionUpdate[] = []
    const unsub = await sessions.subscribe(TEST_PROJECT_ID, u => updates.push(u))
    // memory_accessed changes no graph shape — patch empty, summary present
    await storage.events.append(noteEvent('hit-note'))
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_accessed,
      payload: { id: 'hit-note', scope: 'project', mode: 'read', author: { source: 'cli' } },
    })
    for (let i = 0; i < 40 && updates.length < 2; i++) await Bun.sleep(50)
    expect(updates).toHaveLength(2)
    expect(updates[1]!.summary?.kind).toBe(EVENT_KIND.memory_accessed)
    expect(updates[1]!.summary?.noteRef).toBe(noteNodeId('project', 'hit-note'))
    expect(updates[1]!.patch.addNodes).toEqual([])
    unsub()
  })

  it('transcript, taskPlans, and log read from the cached session', async () => {
    const { storage, taskId, sessions } = await setup()
    await storage.events.append({
      taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call,
      payload: { stepId: 's1', runToken: 'r1', iteration: 1, request: {}, response: { text: 'hello there', toolCalls: [] } },
      usage: { inputTokens: 1, outputTokens: 1, costUSD: null, estimated: false },
    })
    const items = await sessions.transcript(TEST_PROJECT_ID, taskId)
    expect(items).toEqual([{ kind: 'message', iteration: 1, stepId: 's1', text: 'hello there' }])

    expect(await sessions.taskPlans(TEST_PROJECT_ID, taskId)).toBeNull() // no plan proposed
    const rows = await sessions.log(TEST_PROJECT_ID, { taskId })
    expect(rows.at(-1)!.line).toContain('hello there')
    expect(await sessions.log(TEST_PROJECT_ID, { limit: 1 })).toHaveLength(1)
  })

  it('log(taskId) attributes each task its own step rows + its author.taskId memory rows, and no sibling/ownerless memory row', async () => {
    const { storage, taskId: taskA, sessions } = await setup()
    // a second task in the same project — its step rows must never leak into A's log and vice versa
    const k = new Kernel(storage.events)
    const taskB = (await k.createTask({ title: 'task B', spec: '' })).id

    // each task's own step_started (envelope taskId carries the real owner)
    await storage.events.append({ taskId: taskA, stepId: 'sa', runToken: 'ra', kind: EVENT_KIND.step_started, payload: { stepId: 'sa', runToken: 'ra', attempt: 1 } })
    await storage.events.append({ taskId: taskB, stepId: 'sb', runToken: 'rb', kind: EVENT_KIND.step_started, payload: { stepId: 'sb', runToken: 'rb', attempt: 1 } })

    // project-scoped memory rows (envelope taskId null) authored by A, by B, and ownerless (cli)
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'note-by-a', title: 'note-by-a' }, author: { source: 'agent', taskId: taskA } },
    })
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'note-by-b', title: 'note-by-b' }, author: { source: 'agent', taskId: taskB } },
    })
    await storage.events.append(noteEvent('ownerless-note')) // author.source 'cli', no taskId

    const line = (rows: Awaited<ReturnType<typeof sessions.log>>): string[] => rows.map(r => r.line)
    const linesFor = async (t: string): Promise<string[]> => line(await sessions.log(TEST_PROJECT_ID, { taskId: t }))

    const aLines = await linesFor(taskA)
    expect(aLines.some(l => l.includes('sa'))).toBe(true) // A's own step row
    expect(aLines.some(l => l.includes('note-by-a'))).toBe(true) // A-authored memory row
    expect(aLines.some(l => l.includes('sb'))).toBe(false) // NOT B's step row
    expect(aLines.some(l => l.includes('note-by-b'))).toBe(false) // NOT B-authored memory row
    expect(aLines.some(l => l.includes('ownerless-note'))).toBe(false) // NOT the ownerless memory row

    const bLines = await linesFor(taskB)
    expect(bLines.some(l => l.includes('sb'))).toBe(true)
    expect(bLines.some(l => l.includes('note-by-b'))).toBe(true)
    expect(bLines.some(l => l.includes('sa'))).toBe(false)
    expect(bLines.some(l => l.includes('note-by-a'))).toBe(false)
    expect(bLines.some(l => l.includes('ownerless-note'))).toBe(false)
  })

  it('log(sinceSeq/kinds) filters BEFORE the limit slice, keeping the newest matching rows', async () => {
    const { storage, taskId, sessions } = await setup()
    const step = (id: string) => storage.events.append({
      taskId, stepId: id, runToken: 'r1', kind: EVENT_KIND.step_started,
      payload: { stepId: id, runToken: 'r1', attempt: 1 },
    })
    const ask = (topic: string) => storage.events.append({
      taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.feedback_requested,
      payload: { question: `q-${topic}`, topic },
    })
    const s1 = await step('s1')
    const q1 = await ask('one')
    const s2 = await step('s2')
    const q2 = await ask('two')

    // sinceSeq is EXCLUSIVE: the row a poller already saw must not come back
    const since = await sessions.log(TEST_PROJECT_ID, { taskId, sinceSeq: s1.seq })
    expect(since.map(r => r.seq)).toEqual([q1.seq, s2.seq, q2.seq])
    expect(since.every(r => r.seq > s1.seq)).toBe(true)

    const asked = await sessions.log(TEST_PROJECT_ID, { taskId, kinds: [EVENT_KIND.feedback_requested] })
    expect(asked.map(r => r.seq)).toEqual([q1.seq, q2.seq])
    expect(asked.every(r => r.kind === EVENT_KIND.feedback_requested)).toBe(true)

    // composed with limit: the newest MATCHING row, not the newest event (which is q2's neighbour)
    expect((await sessions.log(TEST_PROJECT_ID, { taskId, kinds: [EVENT_KIND.step_started], limit: 1 })).map(r => r.seq))
      .toEqual([s2.seq])
    expect((await sessions.log(TEST_PROJECT_ID, { taskId, sinceSeq: q1.seq, limit: 1 })).map(r => r.seq)).toEqual([q2.seq])
    // whole-project (untargeted) reads take the same filters
    expect((await sessions.log(TEST_PROJECT_ID, { sinceSeq: q2.seq })).map(r => r.seq)).toEqual([])
    expect((await sessions.log(TEST_PROJECT_ID, { kinds: [EVENT_KIND.feedback_requested] })).map(r => r.seq))
      .toEqual([q1.seq, q2.seq])

    // beforeSeq is EXCLUSIVE and pages BACKWARD: the ledger asks for what precedes its oldest
    // row, and with limit it must get the rows nearest the cursor, not the start of the log
    // (the head of the unlimited read is the task's own task_created row, so assert the tail)
    const before = await sessions.log(TEST_PROJECT_ID, { taskId, beforeSeq: q2.seq })
    expect(before.every(r => r.seq < q2.seq)).toBe(true)
    expect(before.map(r => r.seq).slice(-3)).toEqual([s1.seq, q1.seq, s2.seq])
    expect((await sessions.log(TEST_PROJECT_ID, { taskId, beforeSeq: q2.seq, limit: 2 })).map(r => r.seq))
      .toEqual([q1.seq, s2.seq])
    expect((await sessions.log(TEST_PROJECT_ID, { beforeSeq: s1.seq, limit: 5 })).every(r => r.seq < s1.seq)).toBe(true)
  })

  // The 'armed' colouring these three cases used to assert lived only in the mermaid strings
  // planNotes/taskPlans no longer emit. What replaces them is the guard below: the wire must not
  // grow the field back, because a projection nothing renders is paid for on every request.
  it('the plan wire carries waves and notes only — no rendered diagram', async () => {
    const { storage, taskId, sessions } = await setup()
    await storage.events.append(planNoteEvent(taskId, 'sub'))
    await storage.events.append({
      taskId, stepId: null, runToken: null, kind: EVENT_KIND.plan_proposed,
      payload: { plan: { taskId, version: 1, strategyRef: 'split', costEstimateUSD: null, steps: [childStep('own')] } },
    })
    for (let i = 0; i < 40 && (await sessions.snapshot(TEST_PROJECT_ID)).seq < 2; i++) await Bun.sleep(50)

    const tp = await sessions.taskPlans(TEST_PROJECT_ID, taskId)
    expect(tp?.visual?.waves.flatMap(w => w.steps.map(s => s.id))).toEqual(['own'])
    expect(Object.keys(tp?.visual ?? {}).sort()).toEqual(['version', 'waves'])

    expect(Object.keys(await sessions.planNotes(TEST_PROJECT_ID, taskId))).toEqual(['notes'])
  })

  it('note backlinks list notes that link to it', async () => {
    const { storage, sessions } = await setup()
    await storage.events.append(noteEvent('target'))
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'pointer', title: 'pointer', links: [{ id: 'target' }] }, author: { source: 'cli' } },
    })
    const d = BacklinksView.parse(await sessions.nodeDetail(TEST_PROJECT_ID, noteNodeId('project', 'target')))
    expect(d.backlinks.map(b => b.id)).toEqual(['pointer'])
  })

  it('nodeDetail resolves task and note (with access hits); unknown ids are null', async () => {
    const { storage, taskId, sessions } = await setup()
    await storage.events.append(noteEvent('detail-note'))
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_accessed,
      payload: { id: 'detail-note', scope: 'project', mode: 'read', author: { source: 'cli' } },
    })
    const task = TaskDetailView.parse(await sessions.nodeDetail(TEST_PROJECT_ID, taskId))
    expect(task.task.title).toBe('seed task')
    const note = NoteHitsView.parse(await sessions.nodeDetail(TEST_PROJECT_ID, noteNodeId('project', 'detail-note')))
    expect(note.hits).toBe(1)
    expect(await sessions.nodeDetail(TEST_PROJECT_ID, 'nope')).toBeNull()
  })
})
