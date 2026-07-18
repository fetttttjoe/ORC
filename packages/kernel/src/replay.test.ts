import { describe, expect, it } from 'bun:test'
import { EVENT_KIND, type PlanDraft } from '@orc/contracts'
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
})
