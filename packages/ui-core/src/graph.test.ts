import { afterAll, describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { Kernel, fold, openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { planScope } from '@orc/kernel'
import { buildGraph, diffGraphs, noteNodeId, planScopeName, stepNodeId } from './graph'

// planScopeName is the browser-safe duplicate of kernel's planScope (kernel cannot enter the
// page bundle) — this pins them together
it('planScopeName matches the kernel planScope format', () => {
  expect(planScopeName('t-1')).toBe(planScope('t-1'))
})

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

const SHA = 'a'.repeat(64)

async function freshLog(): Promise<EventLog> {
  const db = await createTestDb()
  dbs.push(db)
  return (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
}

const writeNote = (log: EventLog, id: string, extra: Record<string, unknown> = {}, author: Record<string, unknown> = { source: 'cli' }) =>
  log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id, title: id, ...extra }, author } })

// one realistic history: task → approved 2-step plan → step s1 runs and produces an artifact,
// plus two linked notes (one written by the task)
async function seed(log: EventLog): Promise<{ taskId: string }> {
  const k = new Kernel(log)
  const t = await k.createTask({ title: 'build the thing', spec: 'spec' })
  await k.proposePlan(t.id, draftFixture([stepFixture(), stepFixture({ id: 's2', title: 's2', dependsOn: ['s1'] })]))
  await k.approvePlan(t.id)
  await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_started, payload: { stepId: 's1', runToken: 'r1', attempt: 1 } })
  await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.artifact_produced, payload: { path: 'out.txt', sha256: SHA, size: 3 } })
  await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_completed, payload: { stepId: 's1', runToken: 'r1', summary: 'done' } })
  await writeNote(log, 'base-note')
  await writeNote(log, 'task-note', { links: [{ id: 'base-note' }] }, { source: 'agent', taskId: t.id })
  return { taskId: t.id }
}

describe('buildGraph', () => {
  it('projects tasks, steps, artifacts, notes and their edges', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const events = await log.all()
    const g = buildGraph(fold(events), events)

    const byId = new Map(g.nodes.map(n => [n.id, n]))
    expect(byId.get(taskId)?.detail).toBe('approved')
    expect(byId.get(stepNodeId(taskId, 's1'))?.detail).toBe('completed')
    expect(byId.get(stepNodeId(taskId, 's2'))?.detail).toBe('pending')
    expect(byId.get(`artifact:${taskId}:out.txt`)?.detail).toBe('3B')
    expect(byId.get(noteNodeId('project', 'task-note'))?.type).toBe('note')
    expect(g.links).toContainEqual({ source: stepNodeId(taskId, 's1'), target: stepNodeId(taskId, 's2'), type: 'depends' })
    expect(g.links).toContainEqual({ source: stepNodeId(taskId, 's1'), target: `artifact:${taskId}:out.txt`, type: 'out' })
    expect(g.links).toContainEqual({ source: taskId, target: noteNodeId('project', 'task-note'), type: 'wrote' })
    expect(g.links).toContainEqual({ source: noteNodeId('project', 'task-note'), target: noteNodeId('project', 'base-note'), type: 'relates_to' })
    await log.close()
  })

  it('never links to a node that does not exist (dangling note link, deleted target)', async () => {
    const log = await freshLog()
    await seed(log)
    await writeNote(log, 'dangler', { links: [{ id: 'base-note' }, { id: 'never-written' }] })
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id: 'base-note', scope: 'project', author: { source: 'cli' } } })
    const events = await log.all()
    const g = buildGraph(fold(events), events)
    const ids = new Set(g.nodes.map(n => n.id))
    for (const l of g.links) {
      expect(ids.has(l.source)).toBe(true)
      expect(ids.has(l.target)).toBe(true)
    }
    await log.close()
  })
})

describe('diffGraphs', () => {
  const at = (events: EventRecord[]) => buildGraph(fold(events), events)

  it('one memory_written yields exactly that note node + its edge', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const before = await log.all()
    await writeNote(log, 'fresh-note', { links: [{ id: 'base-note' }] }, { source: 'agent', taskId })
    const after = await log.all()

    const patch = diffGraphs(at(before), at(after))
    expect(patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'fresh-note')])
    expect(patch.updateNodes).toEqual([])
    expect(patch.removeNodeIds).toEqual([])
    expect(patch.addLinks.map(l => l.type).sort()).toEqual(['relates_to', 'wrote'])
    await log.close()
  })

  it('a step status flip is an update; a memory_deleted removes the node and its links', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const before = await log.all()
    // distinct runToken per step, as production issues them (crashDedupKey folds duplicates per token)
    await log.append({ taskId, stepId: 's2', runToken: 'r2', kind: EVENT_KIND.step_started, payload: { stepId: 's2', runToken: 'r2', attempt: 1 } })
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id: 'task-note', scope: 'project', author: { source: 'cli' } } })
    const after = await log.all()

    const patch = diffGraphs(at(before), at(after))
    expect(patch.updateNodes.map(n => [n.id, n.detail])).toEqual([[stepNodeId(taskId, 's2'), 'running']])
    expect(patch.removeNodeIds).toEqual([noteNodeId('project', 'task-note')])
    expect(patch.removeLinks.map(l => l.type).sort()).toEqual(['relates_to', 'wrote'])
    expect(patch.addNodes).toEqual([])
    await log.close()
  })
})
