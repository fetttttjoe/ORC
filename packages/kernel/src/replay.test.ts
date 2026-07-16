import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EVENT_KIND, type PlanDraft } from '@orc/contracts'
import { EventLog } from './eventlog'
import { Kernel } from './kernel'
import { fold } from './projections'

const draft = (): PlanDraft => ({
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 't', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'm', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
  }],
})

describe('replay guarantee (spec §10)', () => {
  it('a reopened kernel folds to the identical state ("kill -9" scenario)', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')

    const log1 = new EventLog(dbPath)
    const k1 = new Kernel(log1)
    const t = k1.createTask({ title: 'parent', spec: 'root task' })
    const child = k1.createTask({ title: 'child', parentId: t.id })
    k1.proposePlan(t.id, draft())
    k1.editPlan(t.id, draft())
    k1.approvePlan(t.id)
    const before = k1.state()
    log1.close() // simulated process death — nothing held in memory matters

    const k2 = new Kernel(new EventLog(dbPath))
    expect(k2.state()).toEqual(before)
    expect(k2.getTask(t.id)?.status).toBe('approved')
    expect(k2.getTask(child.id)?.status).toBe('draft')
  })

  it('the event trail is the complete story, in order', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')
    const log = new EventLog(dbPath)
    const k = new Kernel(log)
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    k.approvePlan(t.id)
    expect(log.byTask(t.id).map(e => e.kind)).toEqual([
      EVENT_KIND.task_created,
      EVENT_KIND.plan_proposed,
      EVENT_KIND.task_status_changed,
      EVENT_KIND.plan_approved,
      EVENT_KIND.task_status_changed,
    ])
  })

  it('fold twice over the same log yields equal states (pure replay)', () => {
    const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')
    const log = new EventLog(dbPath)
    const k = new Kernel(log)
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    expect(fold(log.all())).toEqual(fold(log.all()))
  })
})
