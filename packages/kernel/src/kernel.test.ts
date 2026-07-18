import { afterAll, describe, expect, it } from 'bun:test'
import { ApprovalPolicy, TASK_STATUS, type PlanDraft } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { EventLog } from './eventlog'
import { KERNEL_ERROR_CODE, KernelError } from './errors'
import { Kernel } from './kernel'
import { createTestDb } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
})

async function freshKernel(): Promise<Kernel> {
  const db = await createTestDb()
  dbs.push(db)
  return new Kernel(await EventLog.open(db.url))
}

const draft = (): PlanDraft => draftFixture()

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'no_error'
  } catch (e) {
    return e instanceof KernelError ? e.code : `unexpected:${String(e)}`
  }
}

describe('Kernel lifecycle', () => {
  it('create → propose → edit → approve happy path', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'hello', spec: 'world' })
    expect(t.status).toBe(TASK_STATUS.draft)

    const v1 = await k.proposePlan(t.id, draft())
    expect(v1.version).toBe(1)
    expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.awaiting_approval)

    const v2 = await k.editPlan(t.id, draft())
    expect(v2.version).toBe(2)

    const approved = await k.approvePlan(t.id)
    expect(approved.version).toBe(2)
    expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.approved)
    expect((await k.state()).plans.get(t.id)?.approvedVersion).toBe(2)
  })

  it('child tasks inherit budget and increment depth', async () => {
    const k = await freshKernel()
    const parent = await k.createTask({ title: 'p', budgetUSD: 5 })
    const child = await k.createTask({ title: 'c', parentId: parent.id })
    expect(child.depth).toBe(1)
    expect(child.parentId).toBe(parent.id)
    expect(parent.budgetUSD).toBe(5)
    expect(child.budgetUSD).toBe(5)
  })

  it('rejects proposing twice', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'x' })
    await k.proposePlan(t.id, draft())
    expect(await codeOf(k.proposePlan(t.id, draft()))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })

  it('serializes concurrent proposes: exactly one v1 wins', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'race' })
    const results = await Promise.allSettled([k.proposePlan(t.id, draft()), k.proposePlan(t.id, draft())])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await k.getPlan(t.id))?.version).toBe(1)
    expect((await k.state()).plans.get(t.id)?.versions).toHaveLength(1)
  })

  it('rejects editing before a proposal exists', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'x' })
    expect(await codeOf(k.editPlan(t.id, draft()))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })

  it('rejects approving a stale version', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'x' })
    await k.proposePlan(t.id, draft())
    await k.editPlan(t.id, draft())
    expect(await codeOf(k.approvePlan(t.id, 1))).toBe(KERNEL_ERROR_CODE.version_conflict)
  })

  it('rejects unknown tasks', async () => {
    const k = await freshKernel()
    expect(await codeOf(k.proposePlan('ghost', draft()))).toBe(KERNEL_ERROR_CODE.task_not_found)
  })

  it('rejects invalid plan drafts (cycle)', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'x' })
    const bad = draftFixture([stepFixture({ id: 'a', dependsOn: ['b'] }), stepFixture({ id: 'b', dependsOn: ['a'] })])
    expect(await codeOf(k.proposePlan(t.id, bad))).toBe(KERNEL_ERROR_CODE.plan_validation_failed)
    expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.draft)
  })

  it('propose fails with plan_validation_failed when the refValidator reports errors', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const k = new Kernel(await EventLog.open(db.url), async () => [`unknown executor 'nope'`])
    const t = await k.createTask({ title: 'x' })
    await expect(k.proposePlan(t.id, draft())).rejects.toThrow(/unknown executor 'nope'/)
  })

  it('propose succeeds when the refValidator returns no errors', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const k = new Kernel(await EventLog.open(db.url), async () => [])
    const t = await k.createTask({ title: 'x' })
    await expect(k.proposePlan(t.id, draft())).resolves.toBeDefined()
  })

  it('subscribe delivers appended events by seq', async () => {
    const kernel = await freshKernel()
    const seen: number[] = []
    const unsub = await kernel.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    await kernel.createTask({ title: 'x' })
    await new Promise(r => setTimeout(r, 100))
    expect(seen.length).toBeGreaterThan(0)
    await unsub()
  })

  it('proposeSplit: deterministic ids, inherited refs, clamped budget, manual gate parks the child', async () => {
    const k = await freshKernel()
    const parent = await k.createTask({ title: 'P', spec: 'parent', budgetUSD: 10 })
    const args = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: 'child work', budgetUSD: 99,
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }
    const r = await k.proposeSplit(args)
    expect(r).toEqual({ splitId: `split:step:${parent.id}:s1:a1:call_1`, childTaskId: `${parent.id}.s1.call_1`, gated: true })
    const child = await k.getTask(r.childTaskId)
    expect(child?.parentId).toBe(parent.id)
    expect(child?.depth).toBe(1)
    expect(child?.budgetUSD).toBe(10)             // clamped to subtree-remaining, not the requested 99
    expect(child?.status).toBe('awaiting_approval') // manual default parks it
    const plan = await k.getPlan(r.childTaskId)
    expect(plan?.steps[0]).toMatchObject({ id: 'w1', executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5, isolation: 'local' })
    // idempotent: same (runToken, toolCallId) → same ids, no second child
    const again = await k.proposeSplit(args)
    expect(again.childTaskId).toBe(r.childTaskId)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toHaveLength(1)
  })

  it('proposeSplit: auto policy approves with provenance; depth cap rejects', async () => {
    const k = await freshKernel()
    const parent = await k.createTask({ title: 'P', spec: '' })
    const auto = ApprovalPolicy.parse({ default: 'auto' })
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_2',
      title: 'C', spec: '', plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: auto, maxDepth: 3,
    }
    const r = await k.proposeSplit(base)
    expect(r.gated).toBe(false)
    expect((await k.getTask(r.childTaskId))?.status).toBe('approved')
    const approvedEvt = (await k.eventsFor(r.childTaskId)).find(e => e.kind === 'plan_approved')
    expect(approvedEvt?.payload).toMatchObject({ approvedBy: 'policy' })
    await expect(k.proposeSplit({ ...base, toolCallId: 'call_3', maxDepth: 0 })).rejects.toThrow(/depth/)
  })
})
