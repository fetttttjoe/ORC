import { afterAll, describe, expect, it } from 'bun:test'
import { EVENT_KIND, foldMemory, type EventRecord, LINK_KIND } from '@orc/contracts'
import { draftFixture, eventFixture, stepFixture, must } from '@orc/contracts/fixtures'
import { Kernel, emptyFold, fold, openStorage, type EventLog } from '@orc/kernel'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from '@orc/kernel/test-helpers'
import { buildGraph, diffGraphs, EDGE, linkKey, noteNodeId, stepNodeId } from './graph'

// the planScopeName↔planScope drift-guard test is gone WITH the duplication it guarded:
// contracts' planScope is now the single definition, imported everywhere

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => { await Promise.all(dbs.map(d => d.drop())) }, 30_000)

const SHA = 'a'.repeat(64)

// An archived note leaves the READ MODEL entirely (applyEvent deletes its rows) so no query can
// forget to exclude it — but the graph builds from the FOLD, which keeps archived notes because a
// restore depends on them. Measured on the live corpus: 155 archived notes drawn as live nodes
// against 82 live ones.


async function freshLog(): Promise<EventLog> {
  const db = await createTestDb()
  dbs.push(db)
  return (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
}

const writeNote = (log: EventLog, id: string, extra: Record<string, unknown> = {}, author: Record<string, unknown> = { source: 'cli', workspaceId: TEST_WORKSPACE_ID }) =>
  log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id, title: id, ...extra }, author } })

// one realistic history: task → approved 2-step plan → step s1 runs and produces an artifact,
// plus two linked notes (one written by the task)
async function seed(log: EventLog): Promise<{ taskId: string }> {
  const k = new Kernel(log)
  // a task must name a workspace the fold has seen — one seeded record, then tasks as before
  await seedTestWorkspace(log)
  const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'build the thing', spec: 'spec' })
  await k.proposePlan(t.id, draftFixture([stepFixture(), stepFixture({ id: 's2', title: 's2', dependsOn: ['s1'] })]))
  await k.approvePlan(t.id)
  await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_started, payload: { stepId: 's1', runToken: 'r1', attempt: 1 } })
  await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.artifact_produced, payload: { path: 'out.txt', sha256: SHA, size: 3 } })
  await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_completed, payload: { stepId: 's1', runToken: 'r1', summary: 'done' } })
  await writeNote(log, 'base-note')
  await writeNote(log, 'task-note', { links: [{ id: 'base-note' }] }, { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: t.id })
  return { taskId: t.id }
}

// state.artifacts is append-only and artifactNodeId keys on (taskId, path), so a path written twice
// — every retried or re-run step — produced two nodes with the same id. diffGraphs then re-emitted
// an updateNodes entry on EVERY event forever, and the stream never agreed with the snapshot again.
describe('artifact node identity', () => {
  it('emits one node per path, and diffing a graph against itself is empty', () => {
    const st = emptyFold().state
    st.tasks.set('t1', { id: 't1', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title: 'T', spec: '', status: 'running', zone: [], budgetUSD: null, depth: 0, createdAt: '2026-07-27T00:00:00.000Z' })
    st.artifacts.set('t1', [
      { path: 'out.md', sha256: 'a'.repeat(64), size: 10, stepId: null, runToken: null, seq: 1 },
      { path: 'out.md', sha256: 'b'.repeat(64), size: 20, stepId: null, runToken: null, seq: 2 },
    ])
    const g = buildGraph(st, foldMemory([]))
    const artifactNodes = g.nodes.filter(n => n.type === 'artifact')
    expect(artifactNodes).toHaveLength(1)
    expect(artifactNodes[0]?.detail).toBe('20B') // newest write wins
    // the invariant that actually broke: a graph diffed against itself must produce no updates
    expect(diffGraphs(g, buildGraph(st, foldMemory([]))).updateNodes ?? []).toEqual([])
  })
})

describe('buildGraph', () => {
  it('projects tasks, steps, artifacts, notes and their edges', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const events = await log.all()
    const g = buildGraph(fold(events), foldMemory(events))

    const byId = new Map(g.nodes.map(n => [n.id, n]))
    expect(byId.get(taskId)?.detail).toBe('approved')
    // the task's checkout rides on the node: the copilot's project_status groups the task list it
    // already holds by this field, so dropping it here would silently empty every workspace group
    expect(byId.get(taskId)?.workspaceId).toBe(TEST_WORKSPACE_ID)
    expect(byId.get(stepNodeId(taskId, 's1'))?.workspaceId).toBeUndefined() // tasks only
    expect(byId.get(stepNodeId(taskId, 's1'))?.detail).toBe('completed')
    expect(byId.get(stepNodeId(taskId, 's2'))?.detail).toBe('pending')
    expect(byId.get(`artifact:${taskId}:out.txt`)?.detail).toBe('3B')
    expect(byId.get(noteNodeId('project', 'task-note'))?.type).toBe('note')
    expect(g.links).toContainEqual({ source: stepNodeId(taskId, 's1'), target: stepNodeId(taskId, 's2'), type: 'depends' })
    expect(g.links).toContainEqual({ source: stepNodeId(taskId, 's1'), target: `artifact:${taskId}:out.txt`, type: 'out' })
    expect(g.links).toContainEqual({ source: taskId, target: noteNodeId('project', 'task-note'), type: 'wrote' })
    expect(g.links).toContainEqual({ source: noteNodeId('project', 'task-note'), target: noteNodeId('project', 'base-note'), type: LINK_KIND.relates_to })
    await log.close()
  })

  it('step labels: twin-title steps name themselves; running steps carry live iteration', async () => {
    const log = await freshLog()
    const k = new Kernel(log)
    // a task must name a workspace the fold has seen — one seeded record, then tasks as before
    await seedTestWorkspace(log)
    // single-step template shape: step title === task title → two same-named nodes otherwise
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'build the thing', spec: 'spec' })
    await k.proposePlan(t.id, draftFixture([stepFixture({ title: 'build the thing' })]))
    await k.approvePlan(t.id)
    const pending = buildGraph(fold(await log.all()), foldMemory(await log.all()))
    expect(pending.nodes.find(n => n.id === stepNodeId(t.id, 's1'))?.label).toBe('build the thing · s1')
    await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.step_started, payload: { stepId: 's1', runToken: 'r1', attempt: 1 } })
    await log.append({ taskId: t.id, stepId: 's1', runToken: 'r1', kind: EVENT_KIND.agent_call, payload: { stepId: 's1', runToken: 'r1', iteration: 3, request: null, response: null } })
    const running = buildGraph(fold(await log.all()), foldMemory(await log.all()))
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
      links: [{ id: 'arch-overview', kind: LINK_KIND.derived_from }, { id: 'sub-b', kind: LINK_KIND.depends_on }, { id: 'shared', kind: LINK_KIND.relates_to }],
    })
    await writeNote(log, 'sub-b', { scope: 'plan-t1' })
    const events = await log.all()
    const g = buildGraph(fold(events), foldMemory(events))
    // project-only target → falls back into the knowledge map
    expect(g.links).toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('project', 'arch-overview'), type: 'derived_from' })
    // same-scope target resolves normally
    expect(g.links).toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('plan-t1', 'sub-b'), type: 'depends_on' })
    // both scopes hold the id → same-scope WINS (fallback never shadows local resolution)
    expect(g.links).toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('plan-t1', 'shared'), type: LINK_KIND.relates_to })
    expect(g.links).not.toContainEqual({ source: noteNodeId('plan-t1', 'sub-a'), target: noteNodeId('project', 'shared'), type: LINK_KIND.relates_to })
    await log.close()
  })

  it('hides project-chat metadata notes (name/dir) — infrastructure, not knowledge', async () => {
    const log = await freshLog()
    await writeNote(log, 'ui-project-name', { title: 'my chat' })
    await writeNote(log, 'ui-project-dir', { title: '/some/dir' })
    await writeNote(log, 'real-knowledge')
    const events = await log.all()
    const g = buildGraph(fold(events), foldMemory(events))
    const noteIds = g.nodes.filter(n => n.type === 'note').map(n => n.id)
    expect(noteIds).toEqual([noteNodeId('project', 'real-knowledge')])
    await log.close()
  })

  it('derives note heat from access events, and diffGraphs patches on heat change', () => {
    const ts = '2026-07-01T00:00:00.000Z'
    const written = { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'hot', scope: 'project', title: 'hot' }, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } } }
    const access = { kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'hot', scope: 'project', mode: 'read', author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } } }
    const empty = fold([]) // no tasks — notes fold straight from the events
    const cold = buildGraph(empty, foldMemory([written]), { now: ts })
    const hot = buildGraph(empty, foldMemory([written, access, access, access]), { now: ts })
    const coldNode = must(cold.nodes.find(n => n.id === noteNodeId('project', 'hot')), 'cold.nodes.find(n => n.id === noteNodeId(\'project\', \'hot\'))')
    const hotNode = must(hot.nodes.find(n => n.id === noteNodeId('project', 'hot')), 'hot.nodes.find(n => n.id === noteNodeId(\'project\', \'hot\'))')
    expect(coldNode.heat).toBeUndefined()
    expect(hotNode.heat).toBeGreaterThan(0)
    expect(hotNode.heat).toBeLessThanOrEqual(1)
    const patch = diffGraphs(cold, hot)
    expect(patch.updateNodes.map(n => n.id)).toContain(hotNode.id) // heat alone must patch
  })

  it('derives edge heat from accessed.via events, on note-link edges only', () => {
    const ts = '2026-07-01T00:00:00.000Z'
    // a real task, so the task-authored note below produces an actual 'wrote' edge — otherwise
    // the non-note-link assertion below would loop over zero edges and prove nothing
    const state = fold([eventFixture({
      kind: EVENT_KIND.task_created, ts,
      payload: { task: { id: 't1', parentId: null, workspaceId: TEST_WORKSPACE_ID, type: 'generic', title: 'task', spec: '', status: 'draft', zone: [], budgetUSD: null, depth: 0, createdAt: ts } },
    })])
    const events = [
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'eseed', scope: 'project', title: 'eseed', links: [{ id: 'ewalked', kind: LINK_KIND.relates_to }] }, author: { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId: 't1' } } },
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'ewalked', scope: 'project', title: 'ewalked' }, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } } },
      // via-provenance access: the connection itself, not just the node, gets credit
      { kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'ewalked', scope: 'project', mode: 'read', author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID }, via: { seed: 'eseed', kind: LINK_KIND.relates_to, direction: 'out' } } },
    ]
    const g = buildGraph(state, foldMemory(events), { now: ts })
    const edge = must(g.links.find(l => l.source === noteNodeId('project', 'eseed') && l.target === noteNodeId('project', 'ewalked')), 'edge eseed→ewalked')
    expect(edge.heat).toBeGreaterThan(0)
    expect(edge.heat).toBeLessThanOrEqual(1)
    const wroteEdge = must(g.links.find(l => l.type === EDGE.wrote), 'g.links.find(l => l.type === EDGE.wrote)')
    expect(wroteEdge).toBeDefined() // guard: a real non-note-link edge exists in this fixture
    // non-note-link edges (task→note 'wrote' etc.) never carry heat — only walked-edge kinds do
    for (const l of g.links) if (l.type !== LINK_KIND.relates_to) expect(l.heat).toBeUndefined()
  })

  it('never links to a node that does not exist (dangling note link, deleted target)', async () => {
    const log = await freshLog()
    await seed(log)
    await writeNote(log, 'dangler', { links: [{ id: 'base-note' }, { id: 'never-written' }] })
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id: 'base-note', scope: 'project', author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } } })
    const events = await log.all()
    const g = buildGraph(fold(events), foldMemory(events))
    const ids = new Set(g.nodes.map(n => n.id))
    for (const l of g.links) {
      expect(ids.has(l.source)).toBe(true)
      expect(ids.has(l.target)).toBe(true)
    }
    await log.close()
  })
})

describe('diffGraphs', () => {
  const at = (events: EventRecord[]) => buildGraph(fold(events), foldMemory(events))

  it('one memory_written yields exactly that note node + its edge', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const before = await log.all()
    await writeNote(log, 'fresh-note', { links: [{ id: 'base-note' }] }, { source: 'agent', workspaceId: TEST_WORKSPACE_ID, taskId })
    const after = await log.all()

    const patch = diffGraphs(at(before), at(after))
    expect(patch.addNodes.map(n => n.id)).toEqual([noteNodeId('project', 'fresh-note')])
    expect(patch.updateNodes).toEqual([])
    expect(patch.removeNodeIds).toEqual([])
    expect(patch.addLinks.map(l => l.type).sort()).toEqual([LINK_KIND.relates_to, EDGE.wrote])
    await log.close()
  })

  it('a step status flip is an update; a memory_deleted removes the node and its links', async () => {
    const log = await freshLog()
    const { taskId } = await seed(log)
    const before = await log.all()
    // distinct runToken per step, as production issues them (crashDedupKey folds duplicates per token)
    await log.append({ taskId, stepId: 's2', runToken: 'r2', kind: EVENT_KIND.step_started, payload: { stepId: 's2', runToken: 'r2', attempt: 1 } })
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id: 'task-note', scope: 'project', author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } } })
    const after = await log.all()

    const patch = diffGraphs(at(before), at(after))
    expect(patch.updateNodes.map(n => [n.id, n.detail])).toEqual([[stepNodeId(taskId, 's2'), 'running']])
    expect(patch.removeNodeIds).toEqual([noteNodeId('project', 'task-note')])
    expect(patch.removeLinks.map(l => l.type).sort()).toEqual([LINK_KIND.relates_to, EDGE.wrote])
    expect(patch.addNodes).toEqual([])
    await log.close()
  })

  it('emits an updateLinks entry (not remove+add) when only edge heat changes', () => {
    const ts = '2026-07-01T00:00:00.000Z'
    const written = [
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'ueseed', scope: 'project', title: 'ueseed', links: [{ id: 'uewalked', kind: LINK_KIND.relates_to }] }, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } } },
      { kind: EVENT_KIND.memory_written, ts, payload: { note: { id: 'uewalked', scope: 'project', title: 'uewalked' }, author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID } } },
    ]
    const access = { kind: EVENT_KIND.memory_accessed, ts, payload: { id: 'uewalked', scope: 'project', mode: 'read', author: { source: 'cli', workspaceId: TEST_WORKSPACE_ID }, via: { seed: 'ueseed', kind: LINK_KIND.relates_to, direction: 'out' } } }
    const empty = fold([])
    const cold = buildGraph(empty, foldMemory(written), { now: ts })
    const hot = buildGraph(empty, foldMemory([...written, access]), { now: ts })
    const patch = diffGraphs(cold, hot)
    const key = linkKey({ source: noteNodeId('project', 'ueseed'), target: noteNodeId('project', 'uewalked'), type: LINK_KIND.relates_to })
    expect(patch.updateLinks.some(l => linkKey(l) === key)).toBe(true)
    expect(patch.addLinks).toEqual([])
    expect(patch.removeLinks).toEqual([])
  })
})

describe('buildGraph excludes archived notes', () => {
  it('draws the live note and not the retired one', async () => {
    const log = await freshLog()
    await writeNote(log, 'live')
    await writeNote(log, 'gone', { archived: true })
    const g = buildGraph(fold([]), foldMemory(await log.all()), {})
    const noteIds = g.nodes.filter(n => n.type === 'note').map(n => n.id)
    expect(noteIds).toContain(noteNodeId('project', 'live'))
    expect(noteIds).not.toContain(noteNodeId('project', 'gone'))
    await log.close()
  })
})
