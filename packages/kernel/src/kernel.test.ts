import { afterAll, describe, expect, it } from 'bun:test'
import { APPROVAL_ANSWER, ApprovalPolicy, EVENT_KIND, GROUNDED_APPROVAL_DOOR, LINK_KIND, NOTE_TIER, PAYLOAD_SCHEMAS, STEP_ROLE, TASK_STATUS, TaskStatus, type Analyzer, type PlanDraft, type PlanStep } from '@orc/contracts'
import { draftFixture, stepFixture } from '@orc/contracts/fixtures'
import { openStorage, type EventLogOps } from './storage'
import { KERNEL_ERROR_CODE, KernelError } from './errors'
import { Kernel, SPLIT_ORIGIN } from './kernel'
import { instantiateFrozenPlan, planGraphHash, planScope } from './execution/strategies/grounded-plan'
import { createTestDb, TEST_PROJECT_ID } from './test-helpers'

const dbs: Array<{ drop: () => Promise<void> }> = []
// Teardown drops one DB per test (every test goes through freshKernelAndLog), each a pg_database
// scan + DROP DATABASE on its own admin connection. Each handle closes its registered pool first
// (createTestDb.onClose), so DROP no longer has to terminate live backends — but the DBs are still
// distinct, so drop them concurrently with headroom for a loaded box.
afterAll(async () => {
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

async function freshKernel(): Promise<Kernel> {
  return (await freshKernelAndLog()).k
}

// proposeSplit only ever fires from a LIVE step, so its parent is running — expose the log so the
// split fixtures can model that precondition (the guard rejects splits from a non-running parent).
type TestLog = Awaited<ReturnType<typeof openStorage>>['events']
async function freshKernelAndLog(): Promise<{ k: Kernel; log: TestLog }> {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  return { k: new Kernel(storage.events), log: storage.events }
}
const toRunning = (log: TestLog, taskId: string): Promise<unknown> =>
  log.append({ taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from: TASK_STATUS.draft, to: TASK_STATUS.running } })
// Same trick for an arbitrary status: the from-status matrix below needs a task parked in each one,
// and only the fold's view of status gates editPlan.
const toStatus = (log: TestLog, taskId: string, to: TaskStatus): Promise<unknown> =>
  log.append({ taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from: TASK_STATUS.draft, to } })

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

  it('approvePlan records who approved: default human, mcp when an agent drove (P7)', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'attributed' })
    await k.proposePlan(t.id, draft())
    await k.approvePlan(t.id, undefined, { approvedBy: 'mcp' })
    const evt = (await k.eventsFor(t.id)).find(e => e.kind === 'plan_approved')!
    expect(PAYLOAD_SCHEMAS.plan_approved.parse(evt.payload).approvedBy).toBe('mcp')
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

  // A frozen plan whose zone entry could match no path bricked its own steps: two steps could not
  // write the files they were spawned to write, the task settled blocked, and the operator had no
  // door to CORRECT the plan — editPlan refused every from-status but awaiting_approval, so the only
  // exit was cancelling the task and losing the work already completed. `blocked` is admitted now.
  // The matrix is asserted as an exact set on purpose: a new TaskStatus must be classified here
  // deliberately, never inherit "editable" by default.
  it("a blocked task's plan can be edited, and editPlan stays refused from every other non-awaiting status", async () => {
    const { k, log } = await freshKernelAndLog()
    const editable: ReadonlySet<TaskStatus> = new Set([TASK_STATUS.awaiting_approval, TASK_STATUS.blocked])
    const outcomes: Record<string, string> = {}
    for (const status of TaskStatus.options) {
      // one task per status on a shared log — status is per-task, so a DB per case buys nothing
      const t = await k.createTask({ title: `edit from ${status}` })
      await k.proposePlan(t.id, draft()) // a plan must exist before editing is even meaningful
      if (status !== TASK_STATUS.awaiting_approval) await toStatus(log, t.id, status)
      outcomes[status] = await codeOf(k.editPlan(t.id, draft()))
      if (editable.has(status)) expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.awaiting_approval)
    }
    expect(outcomes).toEqual(Object.fromEntries(TaskStatus.options.map(s =>
      [s, editable.has(s) ? 'no_error' : KERNEL_ERROR_CODE.invalid_transition])))
  }, 20_000)

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
    const { log } = await freshKernelAndLog()
    const k = new Kernel(log, async () => [`unknown executor 'nope'`])
    const t = await k.createTask({ title: 'x' })
    await expect(k.proposePlan(t.id, draft())).rejects.toThrow(/unknown executor 'nope'/)
  })

  it('propose succeeds when the refValidator returns no errors', async () => {
    const { log } = await freshKernelAndLog()
    const k = new Kernel(log, async () => [])
    const t = await k.createTask({ title: 'x' })
    await expect(k.proposePlan(t.id, draft())).resolves.toBeDefined()
  })

  it('subscribe delivers appended events by seq', async () => {
    const kernel = await freshKernel()
    const seen: number[] = []
    const unsub = await kernel.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    const t = await kernel.createTask({ title: 'x' })
    await kernel.proposePlan(t.id, draft()) // more than one event, so ORDER is observable at all
    // deadline poll, not a fixed sleep: a contended Postgres can exceed any constant, and every
    // other subscription test in the repo already polls
    const deadline = Date.now() + 15_000
    while (seen.length < 2 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    // the actual claim in the test's name. `seen.length > 0` would pass even if the pump handed
    // back every record with seq 0, or duplicated them, or delivered them out of order.
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen[0]).toBeGreaterThan(0)
    await unsub()
  })

  it('createGroundedTask seeds an auto-approved [analyze, plan] template', async () => {
    const { log } = await freshKernelAndLog()
    // fake analyzer stub: analysisStep returns the scout analyze step (agent-analyzer's real shape)
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout', skillRefs: ['codebase-analysis'] })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel(log, undefined, analyzers)
    const t = await k.createGroundedTask({ title: 'build web', spec: 's', modelRef: 'anthropic/claude-sonnet-5', analyzerRef: 'agent-analyzer' })
    const plan = (await k.getPlan(t.id))!
    expect(plan.strategyRef).toBe('grounded-plan')
    expect(plan.analyzerRef).toBe('agent-analyzer')
    expect(plan.steps.map(s => s.id)).toEqual(['analyze', 'plan'])
    expect(plan.steps[1]!.dependsOn).toEqual(['analyze'])
    expect(plan.steps[1]!.skillRefs).toEqual(['plan-authoring'])
    expect((await k.getTask(t.id))!.status).toBe(TASK_STATUS.approved)
  })

  it('createGroundedTask applies the project iteration budget to BOTH steps — subplans inherit the plan step', async () => {
    const { log } = await freshKernelAndLog()
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout', maxIterations: 30 })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel(log, undefined, analyzers)
    const t = await k.createGroundedTask({ title: 'x', spec: 's', modelRef: 'fake/m', analyzerRef: 'agent-analyzer', maxIterations: 60 })
    expect((await k.getPlan(t.id))!.steps.map(s => s.maxIterations)).toEqual([60, 60])
  })

  it('createGroundedTask forwards parentId — a grounded task can be a child, not only a root', async () => {
    const { log } = await freshKernelAndLog()
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout' })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel(log, undefined, analyzers)
    const parent = await k.createTask({ title: 'parent' })
    const t = await k.createGroundedTask({ title: 'child', spec: 's', modelRef: 'fake/m', analyzerRef: 'agent-analyzer', parentId: parent.id })
    const stored = (await k.getTask(t.id))!
    expect(stored.parentId).toBe(parent.id)
    expect(stored.depth).toBe(1)
  })

  it('createGroundedTask stores the spec verbatim and hands it to the analyzer — the title never substitutes', async () => {
    const { log } = await freshKernelAndLog()
    let analyzedSpec = ''
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', {
      id: 'agent-analyzer',
      analysisStep: ({ taskSpec }) => {
        analyzedSpec = taskSpec
        return stepFixture({ id: 'analyze', role: 'scout', skillRefs: ['codebase-analysis'] })
      },
    }]])
    const k = new Kernel(log, undefined, analyzers)

    const task = await k.createGroundedTask({
      title: 'release notes', spec: 'Summarize changes since v1.2 into notes.md', modelRef: 'fake/m', analyzerRef: 'agent-analyzer',
    })

    expect((await k.getTask(task.id))?.spec).toBe('Summarize changes since v1.2 into notes.md')
    expect(analyzedSpec).toBe('Summarize changes since v1.2 into notes.md')
  })

  it('createGroundedTask rolls back the task when plan reference validation fails', async () => {
    const { log } = await freshKernelAndLog()
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout', skillRefs: ['codebase-analysis'] })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel(log, async () => [`unknown skill 'codebase-analysis'`], analyzers)

    await expect(k.createGroundedTask({
      title: 'build web', spec: 'ground it', modelRef: 'fake/m', analyzerRef: 'agent-analyzer',
    })).rejects.toThrow("unknown skill 'codebase-analysis'")

    expect(await log.all()).toHaveLength(0)
    expect(await k.listTasks()).toEqual([])
  })

  it('createGroundedTask rejects an unknown analyzerRef', async () => {
    const { log } = await freshKernelAndLog()
    const k = new Kernel(log, undefined, new Map())
    expect(await codeOf(k.createGroundedTask({ title: 'x', spec: '', modelRef: 'fake/m', analyzerRef: 'ghost' }))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })

  it('createGroundedTask rejects an empty spec — the title is a label, never the goal', async () => {
    const k = await freshKernel()
    await expect(k.createGroundedTask({ title: 'test', spec: '  ', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' }))
      .rejects.toThrow(/grounded tasks need a spec/)
    expect(await k.listTasks()).toEqual([]) // nothing committed, no analyze run wasted
  })

  it('proposeSplit: deterministic ids, inherited refs, clamped budget, manual gate parks the child', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: 'parent', budgetUSD: 10 })
    await toRunning(log, parent.id)
    const args = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: 'child work', budgetUSD: 99,
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [], zone: ['docs/**'] }] },
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
    expect(plan?.steps[0]).toMatchObject({ id: 'w1', executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5, isolation: 'local', zone: ['docs/**'] })
    // idempotent: same (runToken, toolCallId) → same ids, no second child
    const again = await k.proposeSplit(args)
    expect(again.childTaskId).toBe(r.childTaskId)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toHaveLength(1)
  })

  it('proposeSplit: refuses a model-authored committer step — the role is kernel-set only', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: 'parent' })
    await toRunning(log, parent.id)
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      // an auto-approved child whose only step claims the committer role would arm git_commit
      // with no verify step anywhere — the exact bypass the reserved-role refusal closes
      plan: { steps: [{ id: 'commit', role: STEP_ROLE.committer, title: 'sneak', instructions: 'commit it', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }
    expect(await codeOf(k.proposeSplit(base))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toEqual([]) // no child minted
    // the kernel's own freeze stays open: the same draft with origin 'freeze' is accepted
    const ok = await k.proposeSplit({ ...base, toolCallId: 'call_2', origin: SPLIT_ORIGIN.freeze })
    expect((await k.getPlan(ok.childTaskId))?.steps[0]?.role).toBe(STEP_ROLE.committer)
  })

  it('openFeedbackInSubtree finds a question parked on a DESCENDANT, not only on the root', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: 'parent' })
    await toRunning(log, parent.id)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    })
    expect(await k.openFeedbackInSubtree(parent.id)).toBeNull()
    await log.append({
      taskId: child.childTaskId, stepId: 'w1', runToken: `step:${child.childTaskId}:w1:a1`,
      kind: EVENT_KIND.feedback_requested, payload: { question: 'may I overwrite it?', topic: 'confirm' },
    })
    expect(await k.openFeedbackInSubtree(parent.id))
      .toMatchObject({ taskId: child.childTaskId, question: 'may I overwrite it?', topic: 'confirm' })
  })

  it('gatedChildren names the descendants a manual policy parked, and only those', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: 'parent' })
    await toRunning(log, parent.id)
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      maxDepth: 3,
    }
    const gated = await k.proposeSplit({ ...base, toolCallId: 'call_1', title: 'needs approval', policy: ApprovalPolicy.parse({}) })
    await k.proposeSplit({ ...base, toolCallId: 'call_2', title: 'auto', policy: ApprovalPolicy.parse({ default: 'auto' }) })
    expect(await k.gatedChildren(parent.id)).toEqual([{ id: gated.childTaskId, title: 'needs approval' }])
  })

  it('proposeSplit: rejects a cross-attempt childTaskId collision (same toolCallId, new runToken)', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: '', budgetUSD: 10 })
    await toRunning(log, parent.id)
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
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: '' })
    await toRunning(log, parent.id)
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

  it('proposeSplit: refuses a split from a non-running (cancelled) parent — closes the cancel race', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: '' })
    await log.append({ taskId: parent.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: parent.id, from: TASK_STATUS.draft, to: TASK_STATUS.cancelled } })
    const args = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_9',
      title: 'C', spec: '', plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }
    expect(await codeOf(k.proposeSplit(args))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toHaveLength(0)
  })

  it('annotatePlan appends plan_annotated; replyFeedback resolves and answers the open feedback topic', async () => {
    const { log } = await freshKernelAndLog()
    const sent: Array<{ runToken: string; message: string; topic: string; key?: string }> = []
    const k = new Kernel(log, undefined, undefined, async (runToken, message, topic, key) => { sent.push({ runToken, message, topic, key }) })
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
    const provided = (await log.byTask(t.id)).find(e => e.kind === 'feedback_provided')!
    expect(provided).toMatchObject({
      taskId: t.id, stepId: 'plan', runToken,
      idempotencyKey: expect.stringMatching(/^feedback:\d+:provided$/),
    })
    expect(sent).toEqual([{ runToken, message: 'approve', topic: 'feedback:db-1', key: `feedback:${provided.seq}` }])

    // the gate is now answered — a second reply finds no open question
    expect(await k.replyFeedback(t.id, 'again')).toBeNull()
  })

  it('replyFeedback binds exact grounded plan approval to the current graph hash', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ title: 'grounded', type: 'grounded' })
    const scope = planScope(t.id)
    const author = { source: 'agent' as const }
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'masterplan', scope, tier: 'plan', title: 'Plan', links: [{ id: 'db', kind: 'decomposes_into' }] }, author } })
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'db', scope, tier: 'plan', title: 'DB', body: 'schema' }, author } })
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'approve?', topic: 'plan-1' } })

    await k.replyFeedback(t.id, '  ApPrOvE  ')

    const provided = (await log.byTask(t.id)).find(e => e.kind === EVENT_KIND.feedback_provided)!
    expect(provided.payload.planHash).toBe(planGraphHash(await k.listPlanNotes(t.id)))
  })

  // A human answered "agree" and the gate silently read it as ordinary feedback: the plan never
  // froze and the agent re-asked. The gate is the vocabulary now, not one magic word.
  it('replyFeedback stamps for any word in APPROVAL_ANSWERS, not just the canonical one', async () => {
    const { k, log } = await freshKernelAndLog()
    for (const text of ['agree', 'Agreed', ' LGTM ', 'yes', APPROVAL_ANSWER]) {
      const task = await k.createTask({ title: text, type: 'grounded' })
      await log.append({
        taskId: task.id, stepId: 'plan', runToken: `step:${task.id}:plan:a1`,
        kind: EVENT_KIND.feedback_requested, payload: { question: 'approve?', topic: 'plan-1' },
      })
      await k.replyFeedback(task.id, text)
      const provided = (await log.byTask(task.id)).find(e => e.kind === EVENT_KIND.feedback_provided)!
      expect(provided.payload).toHaveProperty('planHash')
    }
  })

  it('replyFeedback does not stamp ordinary or non-approve replies', async () => {
    const { k, log } = await freshKernelAndLog()
    // 'not yet' / 'approve later' are the near-misses that matter: whole-string only, so an answer
    // that merely CONTAINS an approval word is still ordinary feedback.
    for (const [type, text] of [['generic', 'approve'], ['grounded', 'not yet'], ['grounded', 'approve later']] as const) {
      const task = await k.createTask({ title: type, type })
      await log.append({
        taskId: task.id, stepId: 'plan', runToken: `step:${task.id}:plan:a1`,
        kind: EVENT_KIND.feedback_requested, payload: { question: 'continue?', topic: `${type}-1` },
      })
      await k.replyFeedback(task.id, text)
      const provided = (await log.byTask(task.id)).find(e => e.kind === EVENT_KIND.feedback_provided)!
      expect(provided.payload).not.toHaveProperty('planHash')
    }
  })

  it('approvedPlanHash is scoped to the exact run attempt', async () => {
    const { k, log } = await freshKernelAndLog()
    const task = await k.createTask({ title: 'grounded', type: 'grounded' })
    const runA = `step:${task.id}:plan:a1`
    const runB = `step:${task.id}:plan:a2`
    await log.append({ taskId: task.id, stepId: 'plan', runToken: runA, kind: EVENT_KIND.feedback_provided, payload: { topic: 'a', text: 'approve', author: { source: 'cli' }, planHash: 'a'.repeat(64) } })
    await log.append({ taskId: task.id, stepId: 'plan', runToken: runB, kind: EVENT_KIND.feedback_provided, payload: { topic: 'b', text: 'approve', author: { source: 'cli' }, planHash: 'b'.repeat(64) } })

    expect(await k.approvedPlanHash(task.id, runA)).toMatchObject({ hash: 'a'.repeat(64) })
    expect(await k.approvedPlanHash(task.id, runB)).toMatchObject({ hash: 'b'.repeat(64) })
    expect(await k.approvedPlanHash(task.id, `step:${task.id}:plan:a3`)).toBeNull()
  })

  // The approval approvedPlanHash THROWS AWAY, kept readable so finalize_plan can tell a human who
  // never approved from an agent that approved through the MCP door — the log records those two
  // identically apart from author.source. This is a read only: the last two assertions pin that
  // what SATISFIES the gate did not move.
  it('nonHumanPlanApproval surfaces a non-cli approve for this run, and nothing else', async () => {
    const { k, log } = await freshKernelAndLog()
    const task = await k.createTask({ title: 'grounded', type: 'grounded' })
    const runA = `step:${task.id}:plan:a1`
    const runB = `step:${task.id}:plan:a2`
    const provided = (runToken: string, topic: string, source: 'cli' | 'mcp' | 'agent') => log.append({
      taskId: task.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_provided,
      payload: { topic, text: 'approve', author: { source }, planHash: 'a'.repeat(64) },
    })
    await provided(runA, 'a', 'mcp')
    await provided(runB, 'b', 'cli')

    expect(await k.nonHumanPlanApproval(task.id, runA)).toEqual({ source: 'mcp' })
    expect(await k.nonHumanPlanApproval(task.id, runB)).toBeNull()                        // a human approve is not one
    expect(await k.nonHumanPlanApproval(task.id, `step:${task.id}:plan:a3`)).toBeNull()   // nor another attempt's
    expect(await k.approvedPlanHash(task.id, runA)).toBeNull()                            // the gate is unchanged:
    expect(await k.approvedPlanHash(task.id, runB)).toMatchObject({ hash: 'a'.repeat(64) }) // mcp still fails, cli still passes
  })

  // The gate's accepted-door set is OPERATOR-owned, and its default is today's exact behaviour.
  // This pair is the pin-then-widen: the first test states what a default kernel refuses, the
  // second states what an operator who edited .orc/config.json buys — over the SAME event, so a
  // regression in either direction shows up as one of these two flipping.
  const mcpApproval = async (log: TestLog, taskId: string, runToken: string): Promise<unknown> =>
    log.append({
      taskId, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_provided,
      payload: { topic: 'a', text: 'approve', author: { source: 'mcp' }, planHash: 'a'.repeat(64) },
    })

  it('by default only the cli door satisfies the plan gate — an mcp approve is refused and reported', async () => {
    const { k, log } = await freshKernelAndLog()
    const task = await k.createTask({ title: 'grounded', type: 'grounded' })
    const runToken = `step:${task.id}:plan:a1`
    await mcpApproval(log, task.id, runToken)

    expect(await k.approvedPlanHash(task.id, runToken)).toBeNull()
    expect(await k.nonHumanPlanApproval(task.id, runToken)).toEqual({ source: 'mcp' })
  })

  it('a kernel configured with the mcp door accepts that same approve, and stops calling it non-human', async () => {
    const { k, log } = await freshKernelAndLog()
    const task = await k.createTask({ title: 'grounded', type: 'grounded' })
    const runToken = `step:${task.id}:plan:a1`
    await mcpApproval(log, task.id, runToken)
    const widened = new Kernel(log, undefined, undefined, undefined, [GROUNDED_APPROVAL_DOOR.cli, GROUNDED_APPROVAL_DOOR.mcp])

    expect(await widened.approvedPlanHash(task.id, runToken)).toMatchObject({ hash: 'a'.repeat(64) })
    // the inverted sibling reads the SAME list, so an accepted door is never also reported as the
    // door that failed — the refusal message and the gate cannot disagree
    expect(await widened.nonHumanPlanApproval(task.id, runToken)).toBeNull()
    // attribution is never rewritten: the event still records the door it came through
    const provided = (await log.byTask(task.id)).find(e => e.kind === EVENT_KIND.feedback_provided)!
    expect((provided.payload as { author: { source: string } }).author.source).toBe('mcp')
  })

  it('replyFeedback appends feedback_provided and returns the topic even without an injected send', async () => {
    const { k, log } = await freshKernelAndLog() // no send wired — matches read-only CLI / most-tests construction
    const t = await k.createTask({ title: 'x' })
    const runToken = `step:${t.id}:s1:a1`
    await log.append({ taskId: t.id, stepId: 's1', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'q', topic: 'topic-1' } })

    const topic = await k.replyFeedback(t.id, 'yes')
    expect(topic).toBe('topic-1')
    expect((await log.byTask(t.id)).some(e => e.kind === 'feedback_provided')).toBe(true)
  })

  it('replyFeedback targets the later still-open topic when an earlier one is already answered', async () => {
    const { log } = await freshKernelAndLog()
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

  it('openFeedback surfaces the latest unanswered feedback_requested, then null once answered', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ title: 'x' })
    expect(await k.openFeedback(t.id)).toBeNull() // nothing pending
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes or approve?', topic: 'plan-1' } })
    expect(await k.openFeedback(t.id)).toMatchObject({ topic: 'plan-1', question: 'changes or approve?' })
    await k.replyFeedback(t.id, 'approve')
    expect(await k.openFeedback(t.id)).toBeNull() // answered → nothing to reply to
  })

  it('reportCoverage appends analysis_completed carrying the parsed CoverageReport (defaults + provenance)', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ title: 'x' })
    const runToken = `step:${t.id}:analyze:a1`
    await k.reportCoverage({ taskId: t.id, stepId: 'analyze', runToken }, { analyzed: true, gaps: ['no tests read'] })
    const ev = (await log.byTask(t.id)).find(e => e.kind === EVENT_KIND.analysis_completed)!
    expect(ev.runToken).toBe(runToken) // emitted from within the analyze step
    const p = PAYLOAD_SCHEMAS.analysis_completed.parse(ev.payload)
    expect(p.analyzed).toBe(true)
    expect(p.gaps).toEqual(['no tests read'])
    expect(p.confidence).toBe('none') // default
    expect(p.notesWritten).toBe(0) // default
  })

  it('latestCoverage returns the most recent analysis_completed, or null before any', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'x' })
    expect(await k.latestCoverage(t.id)).toBeNull()
    const ctx = { taskId: t.id, stepId: 'analyze', runToken: `step:${t.id}:analyze:a1` }
    await k.reportCoverage(ctx, { analyzed: false })
    await k.reportCoverage(ctx, { analyzed: true, scope: ['pkgs'], gaps: ['no tests'], confidence: 'low', notesWritten: 2 })
    const cov = await k.latestCoverage(t.id)
    expect(cov).toMatchObject({ analyzed: true, notesWritten: 2, gaps: ['no tests'] }) // the latest, not the first
  })

  it('annotatePlan rejects once the task is done, cancelled, or failed', async () => {
    const { k, log } = await freshKernelAndLog()
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

  it('listAnnotations returns the appended plan_annotated events, in chronological order', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'x' })
    await k.proposePlan(t.id, draft())
    await k.approvePlan(t.id)
    expect(await k.listAnnotations(t.id)).toEqual([])

    await k.annotatePlan(t.id, { targetNote: 'db', refs: ['api'], text: 'use bcrypt' })
    await k.annotatePlan(t.id, { targetNote: 'api', refs: [], text: 'add rate limiting' })

    const annotations = await k.listAnnotations(t.id)
    expect(annotations).toHaveLength(2)
    expect(annotations[0]).toMatchObject({ targetNote: 'db', refs: ['api'], text: 'use bcrypt', planVersion: 1 })
    expect(annotations[1]).toMatchObject({ targetNote: 'api', refs: [], text: 'add rate limiting', planVersion: 1 })
    expect(annotations[0]!.seq).toBeLessThan(annotations[1]!.seq)
  })

  // FixE: the freeze reads plan-notes from the LOG, never the async SurrealDB projection. Here NO
  // memory projector runs, so the read model is empty — pre-fix finalize (store.list/get) would see
  // "no masterplan"; listPlanNotes folds the memory_written events straight off the log and succeeds.
  it('listPlanNotes reconstructs the plan-note graph from the log with no projection running', async () => {
    const { k, log } = await freshKernelAndLog()
    const taskId = 'grounded-1'
    const scope = planScope(taskId)
    const author = { source: 'agent' as const }
    // memory_written events carry taskId:null (scoped by note.scope) — exactly what store.write appends
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'masterplan', scope, tier: 'plan', title: 'Web app', links: [{ id: 'db', kind: 'decomposes_into' }] }, author } })
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'db', scope, tier: 'plan', title: 'DB', body: 'schema' }, author } })
    // a note in ANOTHER task's scope must not bleed into this task's freeze
    await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'masterplan', scope: planScope('other'), tier: 'plan', title: 'Theirs' }, author } })

    const notes = await k.listPlanNotes(taskId)
    expect(notes.map(n => n.id).sort()).toEqual(['db', 'masterplan'])
    expect(notes.find(n => n.id === 'masterplan')!.title).toBe('Web app')
    expect(instantiateFrozenPlan('masterplan', notes).steps.map(s => s.id)).toEqual(['db'])
  })

  it('freezes a subplan-declared modelRef, and omits the key when the planner left it empty', async () => {
    const { k, log } = await freshKernelAndLog()
    const scope = planScope('grounded-models')
    const author = { source: 'agent' as const }
    const note = (id: string, over: Record<string, unknown> = {}) => log.append({
      taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id, scope, tier: NOTE_TIER.plan, title: id, ...over }, author },
    })
    await note('masterplan', { links: [{ id: 'cheap', kind: LINK_KIND.decomposes_into }, { id: 'hard', kind: LINK_KIND.decomposes_into }] })
    await note('cheap')
    await note('hard', { modelRef: 'anthropic/claude-opus-5' })

    const steps = instantiateFrozenPlan('masterplan', await k.listPlanNotes('grounded-models')).steps
    // absent, not '': the expansion inherits via `?? parentStep.modelRef`, which '' would defeat
    expect(steps.find(s => s.id === 'cheap')).not.toHaveProperty('modelRef')
    expect(steps.find(s => s.id === 'hard')!.modelRef).toBe('anthropic/claude-opus-5')
  })

  it('requestRun records the ask, with the cwd override the supervisor cannot derive', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ title: 'x', spec: 's' })
    await k.proposePlan(t.id, draft())
    await k.approvePlan(t.id)
    await k.requestRun(t.id, { cwd: '/tree' })
    const e = (await k.eventsFor(t.id)).find(x => x.kind === EVENT_KIND.run_requested)!
    expect(PAYLOAD_SCHEMAS.run_requested.parse(e.payload)).toEqual({ taskId: t.id, cwd: '/tree', retry: false })
  })

  it('requestRun refuses a task that does not exist, so the event can never name a ghost', async () => {
    const k = await freshKernel()
    await expect(k.requestRun('ghost')).rejects.toThrow(/no task/)
  })

  it('cancelSubtree stamps the whole subtree cancelled, so a client can cancel without a port', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: '' })
    await toRunning(log, parent.id)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    })
    expect((await k.cancelSubtree(parent.id)).sort()).toEqual([parent.id, child.childTaskId].sort())
    expect((await k.getTask(parent.id))?.status).toBe(TASK_STATUS.cancelled)
    expect((await k.getTask(child.childTaskId))?.status).toBe(TASK_STATUS.cancelled)
  })

  // A task_split committed between cancel's subtree snapshot and its stamp sweep used to create a
  // child the sweep never saw — auto-approved, so the router admitted the orphan's run AFTER the
  // cancel finished. The proxied log commits a split at the latest instant before the sweep's own
  // transaction takes the project lock: the closest deterministic seam to that race.
  // The audit scoped change set: paths THIS task's steps wrote, folded from the log. It must cover
  // the task AND its descendant split tasks (a sibling step may delegate its writes to a child), and
  // must NOT bleed an unrelated sibling task's writes in.
  it('listTaskChangedPaths covers a descendant split task and excludes an unrelated sibling', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: '' })
    await toRunning(log, parent.id)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    })
    // an unrelated sibling task with its OWN write — must never appear in the parent's set
    const sibling = await k.createTask({ title: 'unrelated', spec: '' })

    // helper: a confirmed write (tool_call + isError:false tool_result on the same toolCallId)
    const write = async (taskId: string, stepId: string, toolCallId: string, path: string) => {
      const runToken = `step:${taskId}:${stepId}:a1`
      await log.append({ taskId, stepId, runToken, kind: EVENT_KIND.tool_call, payload: { stepId, runToken, iteration: 1, toolCallId, toolName: 'fs_write', input: { path } } })
      await log.append({ taskId, stepId, runToken, kind: EVENT_KIND.tool_result, payload: { stepId, runToken, iteration: 1, toolCallId, toolName: 'fs_write', output: {}, isError: false } })
    }
    await write(parent.id, 's1', 'p1', 'src/parent.ts')
    await write(child.childTaskId, 'w1', 'w1c', './src/child.ts') // delegated write, normalizes to src/child.ts
    await write(sibling.id, 's1', 's1x', 'src/sibling.ts')

    const rows = await k.listTaskChangedPaths(parent.id)
    const paths = rows.map(r => r.path).sort()
    expect(paths).toEqual(['src/child.ts', 'src/parent.ts']) // descendant included, sibling excluded
    // each path is attributed to its OWNING task id
    expect(rows.find(r => r.path === 'src/child.ts')!.taskId).toBe(child.childTaskId)
    expect(rows.find(r => r.path === 'src/parent.ts')!.taskId).toBe(parent.id)
    expect(rows.find(r => r.path === 'src/child.ts')!.steps).toEqual([{ stepId: 'w1', tool: 'fs_write', seq: expect.any(Number) }])

    // the sibling's own set sees only its write, never the parent/child ones
    expect((await k.listTaskChangedPaths(sibling.id)).map(r => r.path)).toEqual(['src/sibling.ts'])
  })

  it('cancelSubtree stamps a child whose split commits after the snapshot, before the sweep', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ title: 'P', spec: '' })
    await toRunning(log, parent.id)
    let injected = false
    const inject = () => k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'late child', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    })
    const racingLog = new Proxy(log, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver)
        return async (fn: (tx: EventLogOps) => Promise<unknown>) => {
          if (!injected) { injected = true; await inject() }
          return target.transaction(fn)
        }
      },
    })
    const stamped = await new Kernel(racingLog).cancelSubtree(parent.id)
    const childId = `${parent.id}.s1.call_1`
    expect(stamped.sort()).toEqual([parent.id, childId].sort())
    expect((await k.getTask(childId))?.status).toBe(TASK_STATUS.cancelled)
  })
})
