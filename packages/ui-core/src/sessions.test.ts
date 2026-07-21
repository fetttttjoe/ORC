import { afterAll, describe, expect, it } from 'bun:test'
import { EVENT_KIND } from '@orc/contracts'
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { noteNodeId } from './graph'
import { createProjectSessions, type SessionUpdate } from './sessions'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

async function setup() {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  const k = new Kernel(storage.events)
  const t = await k.createTask({ title: 'seed task', spec: '' })
  const sessions = createProjectSessions({ url: db.url, cwdProject: { id: TEST_PROJECT_ID, name: 'test-proj' } })
  return { storage, taskId: t.id, sessions }
}

const noteEvent = (id: string) => ({
  taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: { note: { id, title: id }, author: { source: 'cli' as const } },
})

describe('ProjectSessions', () => {
  it('projects() names the cwd project; snapshot holds the seeded task', async () => {
    const { storage, taskId, sessions } = await setup()
    expect(await sessions.projects()).toEqual([{ id: TEST_PROJECT_ID, name: 'test-proj', dir: null }])
    const snap = await sessions.snapshot(TEST_PROJECT_ID)
    expect(snap.seq).toBeGreaterThan(0)
    expect(snap.graph.nodes.map(n => n.id)).toContain(taskId)
    await sessions.close(); await storage.close()
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
    await sessions.close(); await storage.close()
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
    await sessions.close(); await storage.close()
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
    await sessions.close(); await storage.close()
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
    await sessions.close(); await storage.close()
  })

  it('note backlinks list notes that link to it', async () => {
    const { storage, sessions } = await setup()
    await storage.events.append(noteEvent('target'))
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id: 'pointer', title: 'pointer', links: [{ id: 'target' }] }, author: { source: 'cli' } },
    })
    const d = await sessions.nodeDetail(TEST_PROJECT_ID, noteNodeId('project', 'target')) as { backlinks: Array<{ id: string }> }
    expect(d.backlinks.map(b => b.id)).toEqual(['pointer'])
    await sessions.close(); await storage.close()
  })

  it('nodeDetail resolves task and note (with access hits); unknown ids are null', async () => {
    const { storage, taskId, sessions } = await setup()
    await storage.events.append(noteEvent('detail-note'))
    await storage.events.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_accessed,
      payload: { id: 'detail-note', scope: 'project', mode: 'read', author: { source: 'cli' } },
    })
    const task = await sessions.nodeDetail(TEST_PROJECT_ID, taskId) as { task: { title: string } }
    expect(task.task.title).toBe('seed task')
    const note = await sessions.nodeDetail(TEST_PROJECT_ID, noteNodeId('project', 'detail-note')) as { hits: number }
    expect(note.hits).toBe(1)
    expect(await sessions.nodeDetail(TEST_PROJECT_ID, 'nope')).toBeNull()
    await sessions.close(); await storage.close()
  })
})
