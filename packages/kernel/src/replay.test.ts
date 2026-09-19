import { describe, expect, it } from 'bun:test'
import { Door, EVENT_KIND, NO_CHAT, type OperationSpec, type Origin, type PlanDraft } from '@orc/contracts'
import { draftFixture, must } from '@orc/contracts/fixtures'
import { openStorage } from './storage'
import { Kernel } from './kernel'
import { fold } from './projections'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID } from './test-helpers'

const draft = (): PlanDraft => draftFixture()

// Replay is about the log, not about a conversation: every call here comes through the cli door
// with no chat, spelled at each call site rather than defaulted in by a helper.
const CLI: Origin = NO_CHAT(Door.cli)

describe('replay guarantee', () => {
  it('a reopened kernel folds to the identical state ("kill -9" scenario)', async () => {
    const db = await createTestDb()
    try {
      const log1 = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
      const k1 = new Kernel(log1)
      // a task must name a workspace the fold has seen — one seeded record, then tasks as before
      await seedTestWorkspace(log1, CLI)
      const t = await k1.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'parent', spec: 'root task' }, CLI)
      const child = await k1.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'child', parentId: t.id }, CLI)
      await k1.proposePlan(t.id, draft(), CLI)
      await k1.editPlan(t.id, draft(), CLI)
      await k1.approvePlan(t.id, undefined, undefined, CLI)
      const before = await k1.state()
      await log1.close() // simulated process death — nothing held in memory matters

      const k2 = new Kernel((await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events)
      expect(await k2.state()).toEqual(before)
      expect((await k2.getTask(t.id))?.status).toBe('approved')
      expect((await k2.getTask(child.id))?.status).toBe('draft')
    } finally {
      await db.drop()
    }
  })

  it('the event trail is the complete story, in order', async () => {
    const db = await createTestDb()
    try {
      const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
      const log = storage.events
      const k = new Kernel(log)
      // a task must name a workspace the fold has seen — one seeded record, then tasks as before
      await seedTestWorkspace(log, CLI)
      const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, CLI)
      await k.proposePlan(t.id, draft(), CLI)
      await k.approvePlan(t.id, undefined, undefined, CLI)
      expect((await log.byTask(t.id)).map(e => e.kind)).toEqual([
        EVENT_KIND.task_created,
        EVENT_KIND.plan_proposed,
        EVENT_KIND.task_status_changed,
        EVENT_KIND.plan_approved,
        EVENT_KIND.task_status_changed,
      ])
    } finally {
      await db.drop()
    }
  })

  it('journal rows, folded state, replay-at-sequence, and reopen all agree on one history', async () => {
    const db = await createTestDb()
    try {
      const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
      const log = storage.events
      const k = new Kernel(log)
      // a task must name a workspace the fold has seen — one seeded record, then tasks as before
      await seedTestWorkspace(log, CLI)
      const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'audited', spec: 'traced work' }, CLI)
      await k.proposePlan(t.id, draft(), CLI)
      await k.approvePlan(t.id, undefined, undefined, CLI)

      const opContext = { taskId: t.id, stepId: 's1', runToken: `step:${t.id}:s1:a1`, origin: CLI }
      const spec: OperationSpec = { operationId: `${opContext.runToken}:model:1`, kind: 'model', name: 'fake/m', before: { q: 1 } }
      await storage.operations.beginOperation(opContext, spec)
      const startedSeq = must((await log.byTask(t.id)).at(-1), 'last event from task').seq
      await storage.operations.completeOperation(opContext, spec, 1, { text: 'result' })
      await log.append({
        ...CLI, taskId: t.id, stepId: 's1', runToken: opContext.runToken, kind: EVENT_KIND.artifact_produced,
        payload: { path: 'report.md', sha256: 'a'.repeat(64), size: 8 },
      })

      const events = await log.byTask(t.id)
      const state = fold(events)

      // fold vs. durable journal row
      const foldedOp = state.operations.get(spec.operationId)
      const [journalOp] = await storage.operations.operationsFor(t.id)
      expect(foldedOp).toEqual(journalOp)
      expect(foldedOp?.status).toBe('completed')

      // replay-at-sequence: at the start transition the node is honestly unresolved
      const atStart = fold(events.filter(e => e.seq <= startedSeq))
      expect(atStart.operations.get(spec.operationId)?.status).toBe('started')

      // artifact receipt visible in state and in the rendered lineage input
      expect(state.artifacts.get(t.id)?.map(a => a.path)).toEqual(['report.md'])

      // reopening loses nothing
      await log.close()
      const reopenedStorage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
      const reopened = reopenedStorage.events
      expect(fold(await reopened.byTask(t.id))).toEqual(state)
      expect(await reopenedStorage.operations.operationsFor(t.id)).toEqual([must(journalOp, 'journalOp')])
      await reopened.close()
    } finally {
      await db.drop()
    }
  })
})
