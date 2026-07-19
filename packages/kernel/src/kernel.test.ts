import { afterAll, describe, expect, it } from 'bun:test'
import { ApprovalPolicy, EVENT_KIND, TASK_STATUS, type Analyzer, type PlanDraft, type PlanStep } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage } from './storage'
import { KERNEL_ERROR_CODE, KernelError } from './errors'
import { Kernel } from './kernel'
import { createTestDb, TEST_PROJECT_ID } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
afterAll(async () => {
  for (const d of dbs) await d.drop()
})

async function freshKernel(): Promise<Kernel> {
  const db = await createTestDb()
  dbs.push(db)
  return new Kernel((await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events)
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
    const k = new Kernel((await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events, async () => [`unknown executor 'nope'`])
    const t = await k.createTask({ title: 'x' })
    await expect(k.proposePlan(t.id, draft())).rejects.toThrow(/unknown executor 'nope'/)
  })

  it('propose succeeds when the refValidator returns no errors', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const k = new Kernel((await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events, async () => [])
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

  it('createGroundedTask seeds an auto-approved [analyze, plan] template', async () => {
    const db = await createTestDb()
    dbs.push(db)
    // fake analyzer stub: analysisStep returns the scout analyze step (agent-analyzer's real shape)
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout', skillRefs: ['codebase-analysis'] })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel((await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events, undefined, analyzers)
    const t = await k.createGroundedTask({ title: 'build web', spec: 's', modelRef: 'anthropic/claude-sonnet-5', analyzerRef: 'agent-analyzer' })
    const plan = (await k.getPlan(t.id))!
    expect(plan.strategyRef).toBe('grounded-plan')
    expect(plan.analyzerRef).toBe('agent-analyzer')
    expect(plan.steps.map(s => s.id)).toEqual(['analyze', 'plan'])
    expect(plan.steps[1]!.dependsOn).toEqual(['analyze'])
    expect(plan.steps[1]!.skillRefs).toEqual(['plan-authoring'])
    expect((await k.getTask(t.id))!.status).toBe(TASK_STATUS.approved)
  })

  it('createGroundedTask rejects an unknown analyzerRef', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const k = new Kernel((await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events, undefined, new Map())
    expect(await codeOf(k.createGroundedTask({ title: 'x', spec: '', modelRef: 'fake/m', analyzerRef: 'ghost' }))).toBe(KERNEL_ERROR_CODE.invalid_transition)
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

  it('proposeSplit: rejects a cross-attempt childTaskId collision (same toolCallId, new runToken)', async () => {
    const k = await freshKernel()
    const parent = await k.createTask({ title: 'P', spec: '', budgetUSD: 10 })
    const base = {
      parentTaskId: parent.id, stepId: 's1', toolCallId: 'call_1',
      title: 'C', spec: 'child work',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }
    await k.proposeSplit({ ...base, runToken: `step:${parent.id}:s1:a1` })
    // a2 mints a NEW splitId (runToken differs) but the SAME attempt-independent childTaskId —
    // slips past the `existing` check, so the collision guard must reject it (poisoned fold otherwise)
    expect(await codeOf(k.proposeSplit({ ...base, runToken: `step:${parent.id}:s1:a2` }))).toBe(KERNEL_ERROR_CODE.invalid_transition)
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

  it('annotatePlan appends plan_annotated; replyFeedback resolves and answers the open feedback topic', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const sent: Array<{ runToken: string; message: string; topic: string }> = []
    const k = new Kernel(log, undefined, undefined, async (runToken, message, topic) => { sent.push({ runToken, message, topic }) })
    const t = await k.createTask({ title: 'grounded task' })
    await k.proposePlan(t.id, draft())
    await k.approvePlan(t.id)
    // simulate the port raising a feedback gate from inside the running plan step (Task 5 only
    // adds the human-facing reply/annotate surface — the gate itself is Task 2's dbos-port branch)
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'db choice?', topic: 'db-1' } })

    await k.annotatePlan(t.id, { targetNote: 'db', refs: ['api'], text: 'use bcrypt' })
    expect((await log.byTask(t.id)).some(e => e.kind === 'plan_annotated')).toBe(true)

    const topic = await k.replyFeedback(t.id, 'approve')
    expect(topic).toBe('db-1')
    expect((await log.byTask(t.id)).some(e => e.kind === 'feedback_provided')).toBe(true)
    expect(sent).toEqual([{ runToken, message: 'approve', topic: 'feedback:db-1' }])

    // the gate is now answered — a second reply finds no open question
    expect(await k.replyFeedback(t.id, 'again')).toBeNull()
  })

  it('replyFeedback appends feedback_provided and returns the topic even without an injected send', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const k = new Kernel(log) // no send wired — matches read-only CLI / most-tests construction
    const t = await k.createTask({ title: 'x' })
    const runToken = `step:${t.id}:s1:a1`
    await log.append({ taskId: t.id, stepId: 's1', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'q', topic: 'topic-1' } })

    const topic = await k.replyFeedback(t.id, 'yes')
    expect(topic).toBe('topic-1')
    expect((await log.byTask(t.id)).some(e => e.kind === 'feedback_provided')).toBe(true)
  })

  it('replyFeedback targets the later still-open topic when an earlier one is already answered', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const sent: Array<{ runToken: string; topic: string }> = []
    const k = new Kernel(log, undefined, undefined, async (runToken, _message, topic) => { sent.push({ runToken, topic }) })
    const t = await k.createTask({ title: 'x' })
    const runTokenA = `step:${t.id}:s1:a1`
    const runTokenB = `step:${t.id}:s2:a1`
    await log.append({ taskId: t.id, stepId: 's1', runToken: runTokenA, kind: EVENT_KIND.feedback_requested, payload: { question: 'q1', topic: 'topic-a' } })
    await log.append({ taskId: t.id, stepId: 's1', runToken: null, kind: EVENT_KIND.feedback_provided, payload: { topic: 'topic-a', text: 'ok', author: { source: 'cli' } } })
    await log.append({ taskId: t.id, stepId: 's2', runToken: runTokenB, kind: EVENT_KIND.feedback_requested, payload: { question: 'q2', topic: 'topic-b' } })

    const topic = await k.replyFeedback(t.id, 'approve')
    expect(topic).toBe('topic-b') // the later, still-open topic — not the answered 'topic-a', not null
    expect(sent).toEqual([{ runToken: runTokenB, topic: 'feedback:topic-b' }])
  })

  it('annotatePlan rejects once the task is done, cancelled, or failed', async () => {
    const db = await createTestDb()
    dbs.push(db)
    const log = (await openStorage(db.url, { projectId: TEST_PROJECT_ID })).events
    const k = new Kernel(log)
    // Kernel has no public "mark done"/"mark failed" mutator (that's the execution port's job,
    // out of scope here) — append the status change directly, the way the port's run-finish
    // checkpoint does.
    for (const to of [TASK_STATUS.done, TASK_STATUS.cancelled, TASK_STATUS.failed] as const) {
      const t = await k.createTask({ title: 'x' })
      await k.proposePlan(t.id, draft())
      await k.approvePlan(t.id)
      await log.append({ taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: t.id, from: TASK_STATUS.approved, to } })
      expect(await codeOf(k.annotatePlan(t.id, { targetNote: 'db', refs: [], text: 'x' }))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    }
  })
})
