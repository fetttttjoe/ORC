import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type OperationSpec, type PlanDraft } from '@orc/contracts'
import { draftFixture } from '@orc/contracts/fixtures'
import { EventLog } from './eventlog'
import { Kernel } from './kernel'
import { fold } from './projections'
import { createTestDb, TEST_PROJECT_ID } from './test-helpers'

const draft = (): PlanDraft => draftFixture()

describe('replay guarantee (spec §10)', () => {
  it('a reopened kernel folds to the identical state ("kill -9" scenario)', async () => {
    const db = await createTestDb()
    try {
      const log1 = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
      const k1 = new Kernel(log1)
      const t = await k1.createTask({ title: 'parent', spec: 'root task' })
      const child = await k1.createTask({ title: 'child', parentId: t.id })
      await k1.proposePlan(t.id, draft())
      await k1.editPlan(t.id, draft())
      await k1.approvePlan(t.id)
      const before = await k1.state()
      await log1.close() // simulated process death — nothing held in memory matters

      const k2 = new Kernel(await EventLog.open(db.url, { projectId: TEST_PROJECT_ID }))
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
      const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
      const k = new Kernel(log)
      const t = await k.createTask({ title: 'x' })
      await k.proposePlan(t.id, draft())
      await k.approvePlan(t.id)
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

  it('fold twice over the same log yields equal states (pure replay)', async () => {
    const db = await createTestDb()
    try {
      const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
      const k = new Kernel(log)
      const t = await k.createTask({ title: 'x' })
      await k.proposePlan(t.id, draft())
      expect(fold(await log.all())).toEqual(fold(await log.all()))
    } finally {
      await db.drop()
    }
  })

  it('journal rows, folded state, replay-at-sequence, and reopen all agree on one history', async () => {
    const db = await createTestDb()
    try {
      const log = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
      const k = new Kernel(log)
      const t = await k.createTask({ title: 'audited', spec: 'traced work' })
      await k.proposePlan(t.id, draft())
      await k.approvePlan(t.id)

      const opContext = { taskId: t.id, stepId: 's1', runToken: `step:${t.id}:s1:a1` }
      const spec: OperationSpec = { operationId: `${opContext.runToken}:model:1`, kind: 'model', name: 'fake/m', before: { q: 1 } }
      await log.beginOperation(opContext, spec)
      const startedSeq = (await log.byTask(t.id)).at(-1)!.seq
      await log.completeOperation(opContext, spec, 1, { text: 'result' })
      await log.append({
        taskId: t.id, stepId: 's1', runToken: opContext.runToken, kind: EVENT_KIND.artifact_produced,
        payload: { path: 'report.md', sha256: 'a'.repeat(64), size: 8 },
      })

      const events = await log.byTask(t.id)
      const state = fold(events)

      // fold vs. durable journal row
      const foldedOp = state.operations.get(spec.operationId)
      const [journalOp] = await log.operationsFor(t.id)
      expect(foldedOp).toEqual(journalOp)
      expect(foldedOp?.status).toBe('completed')

      // replay-at-sequence: at the start transition the node is honestly unresolved
      const atStart = fold(events.filter(e => e.seq <= startedSeq))
      expect(atStart.operations.get(spec.operationId)?.status).toBe('started')

      // artifact receipt visible in state and in the rendered lineage input
      expect(state.artifacts.get(t.id)?.map(a => a.path)).toEqual(['report.md'])

      // reopening loses nothing
      await log.close()
      const reopened = await EventLog.open(db.url, { projectId: TEST_PROJECT_ID })
      expect(fold(await reopened.byTask(t.id))).toEqual(state)
      expect(await reopened.operationsFor(t.id)).toEqual([journalOp!])
      await reopened.close()
    } finally {
      await db.drop()
    }
  })
})
