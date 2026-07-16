import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TASK_STATUS, type PlanDraft } from '@orc/contracts'
import { EventLog } from './eventlog'
import { KERNEL_ERROR_CODE, KernelError } from './errors'
import { Kernel } from './kernel'

const freshKernel = () =>
  new Kernel(new EventLog(path.join(mkdtempSync(path.join(tmpdir(), 'orc-')), 'state.db')))

const draft = (): PlanDraft => ({
  strategyRef: 'template:single', costEstimateUSD: null,
  steps: [{
    id: 's1', role: 'worker', title: 't', instructions: 'do',
    executorRef: 'api-loop', modelRef: 'm', skillRefs: [],
    isolation: 'local', zone: [], maxIterations: 5, dependsOn: [],
  }],
})

// bun:test-friendly error-code matcher: returns the KernelError code a call throws
const codeOf = (fn: () => unknown): string => {
  try {
    fn()
    return 'no_error'
  } catch (e) {
    return e instanceof KernelError ? e.code : `unexpected:${String(e)}`
  }
}

describe('Kernel lifecycle', () => {
  it('create → propose → edit → approve happy path', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'hello', spec: 'world' })
    expect(t.status).toBe(TASK_STATUS.draft)

    const v1 = k.proposePlan(t.id, draft())
    expect(v1.version).toBe(1)
    expect(k.getTask(t.id)?.status).toBe(TASK_STATUS.awaiting_approval)

    const v2 = k.editPlan(t.id, draft())
    expect(v2.version).toBe(2)

    const approved = k.approvePlan(t.id)
    expect(approved.version).toBe(2)
    expect(k.getTask(t.id)?.status).toBe(TASK_STATUS.approved)
    expect(k.state().plans.get(t.id)?.approvedVersion).toBe(2)
  })

  it('child tasks inherit budget and increment depth', () => {
    const k = freshKernel()
    const parent = k.createTask({ title: 'p' })
    const child = k.createTask({ title: 'c', parentId: parent.id })
    expect(child.depth).toBe(1)
    expect(child.parentId).toBe(parent.id)
  })

  it('rejects proposing twice', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    expect(codeOf(() => k.proposePlan(t.id, draft()))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })

  it('rejects editing before a proposal exists', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    expect(codeOf(() => k.editPlan(t.id, draft()))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })

  it('rejects approving a stale version', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    k.proposePlan(t.id, draft())
    k.editPlan(t.id, draft())
    expect(codeOf(() => k.approvePlan(t.id, 1))).toBe(KERNEL_ERROR_CODE.version_conflict)
  })

  it('rejects unknown tasks', () => {
    const k = freshKernel()
    expect(codeOf(() => k.proposePlan('ghost', draft()))).toBe(KERNEL_ERROR_CODE.task_not_found)
  })

  it('rejects invalid plan drafts (cycle)', () => {
    const k = freshKernel()
    const t = k.createTask({ title: 'x' })
    const bad = draft()
    bad.steps = [
      { ...bad.steps[0], id: 'a', dependsOn: ['b'] },
      { ...bad.steps[0], id: 'b', dependsOn: ['a'] },
    ]
    expect(codeOf(() => k.proposePlan(t.id, bad))).toBe(KERNEL_ERROR_CODE.plan_validation_failed)
    expect(k.getTask(t.id)?.status).toBe(TASK_STATUS.draft)
  })
})
