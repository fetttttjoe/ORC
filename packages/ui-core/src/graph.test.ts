import { afterAll, describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, TASK_STATUS, TaskType, type EventRecord, NO_CHAT } from '@orc/contracts'
import { authorFixture, draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { Kernel, emptyFold, fold, openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { artifactNodeId, buildGraph, diffGraphs, EDGE, stepNodeId } from './graph'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

const SHA = 'a'.repeat(64)

async function freshLog(): Promise<EventLog> {
  const db = await createTestDb()
  dbs.push(db)
  return (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
}

// these histories are arranged through the terminal door; the run halves are the supervisor's
const CLI = NO_CHAT(Door.cli)
const SUPERVISOR = NO_CHAT(Door.supervisor)

// one realistic history: task → approved 2-step plan → step s1 runs and produces an artifact
async function seed(log: EventLog): Promise<{ taskId: string }> {
  const k = new Kernel(log)
  // a task must name a workspace the fold has seen — one seeded record, then tasks as before
  await seedTestWorkspace(log, CLI)
  const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'build the thing', spec: 'spec' }, CLI)
  await k.proposePlan(t.id, draftFixture([stepFixture(), stepFixture({ id: 's2', title: 's2', dependsOn: ['s1'] })]), CLI)
  await k.approvePlan(t.id, undefined, undefined, CLI)
  await log.append({ ...SUPERVISOR, taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_started, payload: { stepId: 's1', runToken: 'r1', attempt: 1 } })
  await log.append({ ...SUPERVISOR, taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.artifact_produced, payload: { path: 'out.txt', sha256: SHA, size: 3 } })
  await log.append({ ...SUPERVISOR, taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_completed, payload: { stepId: 's1', runToken: 'r1', summary: 'done' } })
  return { taskId: t.id }
}

// a path written twice (a retried step) must yield one node, or diffGraphs updates it forever
describe('artifact node identity', () => {
  it('emits one node per path, and diffing a graph against itself is empty', () => {
    const st = emptyFold().state
    st.tasks.set('t1', { id: 't1', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: TaskType.generic, title: 'T', spec: '', status: TASK_STATUS.running, zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-27T00:00:00.000Z' })
    st.artifacts.set('t1', [
      { path: 'out.md', sha256: 'a'.repeat(64), size: 10, stepId: null, runToken: null, seq: 1 },
      { path: 'out.md', sha256: 'b'.repeat(64), size: 20, stepId: null, runToken: null, seq: 2 },
    ])
    const g = buildGraph(st)
    const artifactNodes = g.nodes.filter(n => n.type === 'artifact')
    expect(artifactNodes).toHaveLength(1)
    expect(artifactNodes[0]?.detail).toBe('20B') // newest write wins
    // the invariant that actually broke: a graph diffed against itself must produce no updates
    expect(diffGraphs(g, buildGraph(st)).updateNodes ?? []).toEqual([])
  })
})

describe('buildGraph', () => {
  it('projects tasks, steps, artifacts and their edges', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const g = buildGraph(fold(await log.all()))

    const byId = new Map(g.nodes.map(n => [n.id, n]))
    expect(byId.get(taskId)?.detail).toBe('approved')
    // the task's checkout rides on the node: project_status groups the task list by it
    expect(byId.get(taskId)?.workspaceId).toBe(TEST_WORKSPACE_ID)
    expect(byId.get(stepNodeId(taskId, 's1'))?.workspaceId).toBeUndefined() // tasks only
    expect(byId.get(stepNodeId(taskId, 's1'))?.detail).toBe('completed')
    expect(byId.get(stepNodeId(taskId, 's2'))?.detail).toBe('pending')
    expect(byId.get(artifactNodeId(taskId, 'out.txt'))?.detail).toBe('3B')
    expect(g.links).toContainEqual({ source: stepNodeId(taskId, 's1'), target: stepNodeId(taskId, 's2'), type: EDGE.depends })
    expect(g.links).toContainEqual({ source: stepNodeId(taskId, 's1'), target: artifactNodeId(taskId, 'out.txt'), type: EDGE.out })
    await log.close()
  })

  it('a log of knowledge and identity events draws no node of its own', async () => {
    const log = await freshLog()
    const k = new Kernel(log)
    await seedTestWorkspace(log, CLI)
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'build the thing', spec: 'spec' }, CLI)
    await k.proposePlan(t.id, draftFixture(), CLI)
    await k.approvePlan(t.id, undefined, undefined, CLI)
    const projectWide = { ...CLI, taskId: null, stepId: null, runToken: null }
    await log.append({ ...projectWide, kind: EVENT_KIND.project_identified, payload: { name: 'p', dir: '/p' } })
    await log.append({
      ...projectWide, kind: EVENT_KIND.knowledge_written,
      payload: { added: [{ id: 'abcd1234', location: 'knowledge/src/a.ts.md' }], changed: [], retired: [], files: ['knowledge/src/a.ts.md'], why: null, decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture() },
    })
    const g = buildGraph(fold(await log.all()))
    expect([...new Set(g.nodes.map(n => n.type))].sort()).toEqual(['model', 'step', 'task'])
    await log.close()
  })

  it('step labels: twin-title steps name themselves; running steps carry live iteration', async () => {
    const log = await freshLog()
    const k = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log, CLI)
    // single-step template shape: step title === task title → two same-named nodes otherwise
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'build the thing', spec: 'spec' }, CLI)
    await k.proposePlan(t.id, draftFixture([stepFixture({ title: 'build the thing' })]), CLI)
    await k.approvePlan(t.id, undefined, undefined, CLI)
    const pending = buildGraph(fold(await log.all()))
    expect(pending.nodes.find(n => n.id === stepNodeId(t.id, 's1'))?.label).toBe('build the thing · s1')
    await log.append({ ...SUPERVISOR, taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_started, payload: { stepId: 's1', runToken: 'r1', attempt: 1 } })
    await log.append({ ...SUPERVISOR, taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call, payload: { stepId: 's1', runToken: 'r1', iteration: 3, request: null, response: null } })
    const running = buildGraph(fold(await log.all()))
    expect(running.nodes.find(n => n.id === stepNodeId(t.id, 's1'))?.label).toBe('build the thing · s1 · 3/5')
    await log.close()
  })

  it('never links to a node that does not exist', async () => {
    const log = await freshLog()
    await seed(log)
    const g = buildGraph(fold(await log.all()))
    const ids = new Set(g.nodes.map(n => n.id))
    for (const l of g.links) {
      expect(ids.has(l.source)).toBe(true)
      expect(ids.has(l.target)).toBe(true)
    }
    await log.close()
  })
})

describe('diffGraphs', () => {
  const at = (events: EventRecord[]) => buildGraph(fold(events))
  const produce = (log: EventLog, taskId: string, path: string) =>
    log.append({ ...SUPERVISOR, taskId, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.artifact_produced, payload: { path, sha256: SHA, size: 5 } })

  it('one artifact_produced yields exactly that artifact node + its edge', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const before = await log.all()
    await produce(log, taskId, 'fresh.txt')
    const after = await log.all()

    const patch = diffGraphs(at(before), at(after))
    expect(patch.addNodes.map(n => n.id)).toEqual([artifactNodeId(taskId, 'fresh.txt')])
    expect(patch.updateNodes).toEqual([])
    expect(patch.removeNodeIds).toEqual([])
    expect(patch.addLinks).toEqual([{ source: stepNodeId(taskId, 's1'), target: artifactNodeId(taskId, 'fresh.txt'), type: EDGE.out }])
    await log.close()
  })

  it('a step status flip is an update; a node the next graph lacks is removed with its links', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const before = await log.all()
    // distinct runToken per step, as production issues them (crashDedupKey folds duplicates per token)
    await log.append({ ...SUPERVISOR, taskId, stepId: 's2', runToken: 'r2', kind: EVENT_KIND.step_started, payload: { stepId: 's2', runToken: 'r2', attempt: 1 } })
    await produce(log, taskId, 'later.txt')
    const after = await log.all()

    const forward = diffGraphs(at(before), at(after))
    expect(forward.updateNodes.map(n => [n.id, n.detail])).toEqual([[stepNodeId(taskId, 's2'), 'running']])
    const back = diffGraphs(at(after), at(before))
    expect(back.removeNodeIds).toEqual([artifactNodeId(taskId, 'later.txt')])
    expect(back.removeLinks.map(l => l.type)).toEqual([EDGE.out])
    expect(back.addNodes).toEqual([])
    await log.close()
  })
})
