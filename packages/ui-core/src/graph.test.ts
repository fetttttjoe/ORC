import { afterAll, describe, expect, it } from 'bun:test'
import { EVENT_KIND, type EventRecord } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { Kernel, fold, openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import { buildGraph, diffGraphs, noteNodeId, stepNodeId } from './graph'

// the planScopeName↔planScope drift-guard test is gone WITH the duplication it guarded:
// contracts' planScope is now the single definition, imported everywhere

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

  it('step labels: twin-title steps name themselves; running steps carry live iteration', async () => {
    const log = await freshLog()
    const k = new Kernel(log)
    // single-step template shape: step title === task title → two same-named nodes otherwise
    const t = await k.createTask({ title: 'build the thing', spec: 'spec' })
    await k.proposePlan(t.id, draftFixture([stepFixture({ title: 'build the thing' })]))
    await k.approvePlan(t.id)
    const pending = buildGraph(fold(await log.all()), await log.all())
    expect(pending.nodes.find(n => n.id === stepNodeId(t.id, 's1'))?.label).toBe('build the thing · s1')
    await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_started, payload: { stepId: 's1', runToken: 'r1', attempt: 1 } })
    await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call, payload: { stepId: 's1', runToken: 'r1', iteration: 3, request: null, response: null } })
    const running = buildGraph(fold(await log.all()), await log.all())
    expect(running.nodes.find(n => n.id === stepNodeId(t.id, 's1'))?.label).toBe('build the thing · s1 · 3/5')
    await log.close()
  })

  it('plan-scope notes wire into project-scope knowledge (cross-scope view fallback)', async () => {
    const log = await freshLog()
    await writeNote(log, 'arch-overview') // project scope only: the knowledge hub
    await writeNote(log, 'shared') // exists in BOTH scopes — precedence probe
    await writeNote(log, 'shared', { scope: 'plan-t1' })
    await writeNote(log, 'sub-a', {
      scope: 'plan-t1',
      links: [{ id: 'arch-overview', kind: 'derived_from' }, { id: 'sub-b', kind: 'depends_on' }, { id: 'shared', kind: 'relates_to' }],
    })
    await writeNote(log, 'sub-b', { scope: 'plan-t1' })
    const events = await log.all()
    const g = buildGraph(fold(events), events)
    // project-only target → falls back into the knowledge map
    expect(g.links).toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('project', 'arch-overview'), type: 'derived_from' })
    // same-scope target resolves normally
    expect(g.links).toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('plan-t1', 'sub-b'), type: 'depends_on' })
    // both scopes hold the id → same-scope WINS (fallback never shadows local resolution)
    expect(g.links).toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('plan-t1', 'shared'), type: 'relates_to' })
    expect(g.links).not.toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('project', 'shared'), type: 'relates_to' })
    await log.close()
  })

  it('hides project-chat metadata notes (name/dir) — infrastructure, not knowledge', async () => {
    const log = await freshLog()
    await writeNote(log, 'ui-project-name', { title: 'my chat' })
    await writeNote(log, 'ui-project-dir', { title: '/some/dir' })
    await writeNote(log, 'real-knowledge')
    const events = await log.all()
    const g = buildGraph(fold(events), events)
    const noteIds = g.nodes.filter(n => n.type === 'note').map(n => n.id)
    expect(noteIds).toEqual([noteNodeId('project', 'real-knowledge')])
    await log.close()
  })

  it('derives note heat from access events, and diffGraphs patches on heat change', () => {
    const ts = '2026-07-01T00:00:00.000Z'
    const written = { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'hot', scope: 'project', title: 'hot' }, author: { source: 'cli' } } }
    const access = { kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'hot', scope: 'project', mode: 'read', author: { source: 'cli' } } }
    const empty = fold([]) // no tasks — notes fold straight from the events
    const cold = buildGraph(empty, [written], { now: ts })
    const hot = buildGraph(empty, [written, access, access, access], { now: ts })
    const coldNode = cold.nodes.find(n => n.id === noteNodeId('project', 'hot'))!
    const hotNode = hot.nodes.find(n => n.id === noteNodeId('project', 'hot'))!
    expect(coldNode.heat).toBeUndefined()
    expect(hotNode.heat).toBeGreaterThan(0)
    expect(hotNode.heat).toBeLessThanOrEqual(1)
    const patch = diffGraphs(cold, hot)
    expect(patch.updateNodes.map(n => n.id)).toContain(hotNode.id) // heat alone must patch
  })

  it('derives edge heat from accessed.via events, on note-link edges only', () => {
    const ts = '2026-07-01T00:00:00.000Z'
    const events = [
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'eseed', scope: 'project', title: 'eseed', links: [{ id: 'ewalked', kind: 'relates_to' }] }, author: { source: 'cli' } } },
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'ewalked', scope: 'project', title: 'ewalked' }, author: { source: 'cli' } } },
      // via-provenance access: the connection itself, not just the node, gets credit
      { kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'ewalked', scope: 'project', mode: 'read', author: { source: 'cli' }, via: { seed: 'eseed', kind: 'relates_to', direction: 'out' } } },
    ]
    const g = buildGraph(fold([]), events, { now: ts })
    const edge = g.links.find(l => l.source === noteNodeId('project', 'eseed') && l.target === noteNodeId('project', 'ewalked'))!
    expect(edge.heat).toBeGreaterThan(0)
    expect(edge.heat).toBeLessThanOrEqual(1)
    // non-note-link edges (task→note 'wrote' etc.) never carry heat — only walked-edge kinds do
    for (const l of g.links) if (l.type !== 'relates_to') expect(l.heat).toBeUndefined()
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

  it('emits an updateLinks entry (not remove+add) when only edge heat changes', () => {
    const ts = '2026-07-01T00:00:00.000Z'
    const written = [
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'ueseed', scope: 'project', title: 'ueseed', links: [{ id: 'uewalked', kind: 'relates_to' }] }, author: { source: 'cli' } } },
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'uewalked', scope: 'project', title: 'uewalked' }, author: { source: 'cli' } } },
    ]
    const access = { kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'uewalked', scope: 'project', mode: 'read', author: { source: 'cli' }, via: { seed: 'ueseed', kind: 'relates_to', direction: 'out' } } }
    const empty = fold([])
    const cold = buildGraph(empty, written, { now: ts })
    const hot = buildGraph(empty, [...written, access], { now: ts })
    const patch = diffGraphs(cold, hot)
    const key = `${noteNodeId('project', 'ueseed')} ${noteNodeId('project', 'uewalked')} relates_to`
    expect(patch.updateLinks.some(l => `${l.source} ${l.target} ${l.type}` === key)).toBe(true)
    expect(patch.addLinks).toEqual([])
    expect(patch.removeLinks).toEqual([])
  })
})
