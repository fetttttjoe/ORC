import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { APPROVAL_ANSWER, ApprovedBy, AUTHOR_SOURCE, ApprovalPolicy, CHECKS_STEP_ID, Confidence, Door, EVENT_KIND, FINISH_STEP_ID, GroundedApprovalDoor, LINK_KIND, NO_CHAT, NOTE_TIER, PAYLOAD_SCHEMAS, RunRequestedPayload, STEP_ID, STEP_ROLE, STRATEGY, TASK_STATUS, TaskStatus, WORKSPACE_KIND, WORKSPACE_TITLE_MAX, authorSourceOf, type Analyzer, type AuthorSource, type Origin, type PlanDraft, type PlanStep, type TaskNode, type Workspace } from '@orc/contracts'
import { authorFixture, draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { openStorage, type EventLogOps } from './storage'
import { KERNEL_ERROR_CODE, KernelError } from './errors'
import { Kernel, SPLIT_ORIGIN } from './kernel'
import type { KernelMutationVerb } from './kernel-verbs'
import { instantiateFrozenPlan, planGraphHash, planScope } from './execution/strategies/grounded-plan'
import { createTestDb, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE, TEST_WORKSPACE_ID } from './test-helpers'

// Every call below spells its own envelope. WEB is one chat entered through the web door; SEED is
// the arrangement door, so an append a verb forgot to stamp reads back as SEED and fails.
const WEB: Origin = { chatId: 'chat-1', door: Door.web }
const SEED: Origin = NO_CHAT(Door.cli)

const dbs: Array<{ drop: () => Promise<void> }> = []
// Teardown drops one DB per test (every test goes through freshKernelAndLog), each a pg_database
// scan + DROP DATABASE on its own admin connection. Each handle closes its registered pool first
// (createTestDb.onClose), so DROP no longer has to terminate live backends — but the DBs are still
// distinct, so drop them concurrently with headroom for a loaded box.
afterAll(async () => {
  await Promise.all(dbs.map(d => d.drop()))
}, 30_000)

// Each test opens its own database, and its pool would stay open until afterAll — seventy-odd live
// pools exhaust Postgres and the last tests die with 'sorry, too many clients already'.
const openPools: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(openPools.splice(0).map(close => close()))
})

// A workspace directory that really exists on disk, holding one directory the zone rule can see.
const tmpDirs: string[] = []
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })
function tmpWorkspaceDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'orc-zone-')))
  tmpDirs.push(dir)
  mkdirSync(path.join(dir, 'src'))
  return dir
}

async function freshKernel(): Promise<Kernel> {
  return (await freshKernelAndLog()).k
}

// proposeSplit only ever fires from a LIVE step, so its parent is running — expose the log so the
// split fixtures can model that precondition (the guard rejects splits from a non-running parent).
type TestLog = Awaited<ReturnType<typeof openStorage>>['events']
async function freshKernelAndLog(cwd: string = TEST_WORKSPACE.cwd): Promise<{ k: Kernel; log: TestLog }> {
  const db = await createTestDb()
  dbs.push(db)
  const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
  db.onClose(() => storage.close())
  openPools.push(() => storage.close())
  // createTask refuses a workspace the fold has never seen, so every kernel a test opens starts
  // with the one TEST_WORKSPACE_ID names — the tests below are about tasks, not about adoption.
  await seedTestWorkspace(storage.events, SEED, cwd)
  return { k: new Kernel(storage.events), log: storage.events }
}
const toRunning = (log: TestLog, taskId: string, origin: Origin): Promise<unknown> =>
  log.append({ ...origin, taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from: TASK_STATUS.draft, to: TASK_STATUS.running } })
// Same trick for an arbitrary status: the from-status matrix below needs a task parked in each one,
// and only the fold's view of status gates editPlan.
const toStatus = (log: TestLog, taskId: string, to: TaskStatus, origin: Origin): Promise<unknown> =>
  log.append({ ...origin, taskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId, from: TASK_STATUS.draft, to } })

const draft = (): PlanDraft => draftFixture()

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'no_error'
  } catch (e) {
    return e instanceof KernelError ? e.code : `unexpected:${String(e)}`
  }
}

// What a VERBS row arranges before it calls its verb. Arrangement goes through SEED and re-marks
// the log, so the window a row is judged on holds the verb's OWN appends only.
interface VerbFixtures {
  readonly log: TestLog
  readonly tag: string
  mark: number
  draftTask(): Promise<TaskNode>
  awaitingTask(): Promise<TaskNode>
  approvedTask(): Promise<TaskNode>
  runningTask(): Promise<TaskNode>
  askedTask(): Promise<TaskNode>
  liveWorkspace(): Promise<Workspace>
}
async function verbFixtures(k: Kernel, log: TestLog, tag: string): Promise<VerbFixtures> {
  const len = async (): Promise<number> => (await log.all()).length
  const f: VerbFixtures = {
    log, tag, mark: await len(),
    draftTask: async () => {
      const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: tag }, SEED)
      f.mark = await len()
      return t
    },
    awaitingTask: async () => {
      const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: tag }, SEED)
      await k.proposePlan(t.id, draft(), SEED)
      f.mark = await len()
      return t
    },
    approvedTask: async () => {
      const t = await f.awaitingTask()
      await k.approvePlan(t.id, undefined, undefined, SEED)
      f.mark = await len()
      return t
    },
    runningTask: async () => {
      const t = await f.draftTask()
      await toRunning(log, t.id, SEED)
      f.mark = await len()
      return t
    },
    askedTask: async () => {
      const t = await f.draftTask()
      // asked INSIDE chat-1, so the reply — which inherits the QUESTION's chat — is judged on its
      // door here; the two-chat case is its own test below.
      await log.append({ ...WEB, taskId: t.id, stepId: 's1', runToken: 'step:' + t.id + ':s1:a1', kind: EVENT_KIND.feedback_requested, payload: { question: 'q', topic: 'topic-1' } })
      f.mark = await len()
      return t
    },
    liveWorkspace: async () => {
      const w = await k.createWorkspace({ title: tag, cwd: '/tmp/orc-verbs/live-' + tag, branch: 'orc/live-' + tag, baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }, SEED)
      f.mark = await len()
      return w
    },
  }
  return f
}
const VERB_SPLIT_STEP = { id: 'w1', role: STEP_ROLE.worker, title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }
const VERB_PARENT_STEP = { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 }
const VERB_ANALYZER_REF = 'agent-analyzer'
// a record no log has seen: restoreWorkspace re-seats one, it never mints
const VERB_RESTORED_WS_ID = '99999999-9999-4999-8999-999999999901'

// A Record over the union, never an array: a new appending verb with no row here fails to compile,
// which is what stops an append that names no chat and no door from reaching the log unnoticed.
const VERBS: Record<KernelMutationVerb, (k: Kernel, f: VerbFixtures) => Promise<unknown>> = {
  createTask: (k, f) => k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: f.tag }, WEB),
  createGroundedTask: (k, f) => k.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: f.tag, spec: 's', modelRef: 'fake/m', analyzerRef: VERB_ANALYZER_REF }, WEB),
  proposePlan: async (k, f) => k.proposePlan((await f.draftTask()).id, draft(), WEB),
  editPlan: async (k, f) => k.editPlan((await f.awaitingTask()).id, draft(), WEB),
  approvePlan: async (k, f) => k.approvePlan((await f.awaitingTask()).id, undefined, undefined, WEB),
  proposeSplit: async (k, f) => {
    const parent = await f.runningTask()
    return k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: 'step:' + parent.id + ':s1:a1', toolCallId: 'call_1',
      title: 'C', spec: '', plan: { steps: [VERB_SPLIT_STEP] }, parentStep: VERB_PARENT_STEP,
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }, WEB)
  },
  annotatePlan: async (k, f) => k.annotatePlan((await f.approvedTask()).id, { targetNote: 'db', refs: [], text: 'x' }, WEB),
  replyFeedback: async (k, f) => k.replyFeedback((await f.askedTask()).id, 'yes', WEB),
  reportCoverage: async (k, f) => {
    const t = await f.draftTask()
    return k.reportCoverage({ taskId: t.id, stepId: 'analyze', runToken: 'step:' + t.id + ':analyze:a1' }, { analyzed: true }, WEB)
  },
  requestRun: async (k, f) => k.requestRun((await f.approvedTask()).id, { cwd: '/tree' }, WEB),
  cancelSubtree: async (k, f) => k.cancelSubtree((await f.approvedTask()).id, WEB),
  ensureWorkspace: (k, f) => k.ensureWorkspace({ cwd: '/tmp/orc-verbs/' + f.tag, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: false }, WEB),
  createWorkspace: (k, f) => k.createWorkspace({ title: f.tag, cwd: '/tmp/orc-verbs/' + f.tag, branch: 'orc/' + f.tag, baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }, WEB),
  restoreWorkspace: (k, f) => k.restoreWorkspace({ ...TEST_WORKSPACE, id: VERB_RESTORED_WS_ID, cwd: '/tmp/orc-verbs/' + f.tag }, WEB),
  retitleWorkspace: async (k, f) => k.retitleWorkspace((await f.liveWorkspace()).id, 'renamed', WEB),
  setWorkspaceArchived: async (k, f) => k.setWorkspaceArchived((await f.liveWorkspace()).id, true, WEB),
  mergeWorkspace: async (k, f) => k.mergeWorkspace((await f.liveWorkspace()).id, { mergeCommit: 'abc123', trunk: 'main' }, WEB),
}
describe('origin on every mutation verb', () => {
  it('stamps the caller\'s chat and door on every event the verb appends', async () => {
    const { log } = await freshKernelAndLog()
    const analyzers = new Map<string, Analyzer>([[VERB_ANALYZER_REF, { id: VERB_ANALYZER_REF, analysisStep: () => stepFixture({ id: STEP_ID.analyze, role: STEP_ROLE.scout }) }]])
    const k = new Kernel(log, undefined, analyzers)
    const envelopes: Record<string, string[]> = {}
    for (const [verb, row] of Object.entries(VERBS)) {
      const f = await verbFixtures(k, log, verb)
      await row(k, f)
      // an empty window fails too: a verb that appended nothing cannot have stamped anything
      envelopes[verb] = [...new Set((await log.all()).slice(f.mark).map(e => e.chatId + '/' + e.door))]
    }
    expect(envelopes).toEqual(Object.fromEntries(Object.keys(VERBS).map(v => [v, [WEB.chatId + '/' + WEB.door]])))
  }, 120_000)
  // A reply threaded into the ANSWERER's chat would leave the gate's own transcript holding a
  // question nobody ever answered.
  it('replyFeedback records the QUESTION\'s chat with the ANSWERER\'s door', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'gate' }, SEED)
    const runToken = 'step:' + t.id + ':plan:a1'
    await log.append({ chatId: 'chat-question', door: Door.cli, taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'db?', topic: 'db-1' } })
    const answerer: Origin = { chatId: 'chat-answer', door: Door.mcp }

    expect(await k.replyFeedback(t.id, 'bcrypt', answerer)).toBe('db-1')

    const provided = must((await log.byTask(t.id)).find(e => e.kind === EVENT_KIND.feedback_provided), 'feedback_provided event')
    expect(provided.chatId).toBe('chat-question')
    expect(provided.door).toBe(Door.mcp)
    expect(PAYLOAD_SCHEMAS.feedback_provided.parse(provided.payload).author.source).toBe(authorSourceOf(answerer.door))
  })

  // A running task's end is read back from the RUN's transcript, so that one status change belongs
  // to the run's chat — with the canceller's door, who is not the supervisor.
  it('cancelSubtree stamps a RUNNING task into the run\'s chat and everything else into the caller\'s', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P' }, SEED)
    const child = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'C', parentId: parent.id }, SEED)
    await toRunning(log, parent.id, SEED)
    const workflowId = 'run:' + parent.id + ':v1'
    await log.append({ ...SEED, taskId: parent.id, stepId: null, runToken: null, kind: EVENT_KIND.run_started, payload: { taskId: parent.id, planVersion: 1, retryIndex: 0, workflowId, cwd: null } })
    const canceller: Origin = { chatId: 'chat-cli', door: Door.cli }

    expect((await k.cancelSubtree(parent.id, canceller)).sort()).toEqual([parent.id, child.id].sort())

    const cancelled = async (taskId: string): Promise<{ chatId: string | null; door: Door }> => must(
      (await log.byTask(taskId)).find(e => e.kind === EVENT_KIND.task_status_changed
        && PAYLOAD_SCHEMAS.task_status_changed.parse(e.payload).to === TASK_STATUS.cancelled),
      'cancelled status for ' + taskId)
    expect(await cancelled(parent.id)).toMatchObject({ chatId: workflowId, door: Door.cli })
    expect(await cancelled(child.id)).toMatchObject({ chatId: canceller.chatId, door: Door.cli })
  })
})
describe('Kernel lifecycle', () => {
  it('create → propose → edit → approve happy path', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'hello', spec: 'world' }, WEB)
    expect(t.status).toBe(TASK_STATUS.draft)

    const v1 = await k.proposePlan(t.id, draft(), WEB)
    expect(v1.version).toBe(1)
    expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.awaiting_approval)

    const v2 = await k.editPlan(t.id, draft(), WEB)
    expect(v2.version).toBe(2)

    const approved = await k.approvePlan(t.id, undefined, undefined, WEB)
    expect(approved.version).toBe(2)
    expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.approved)
    expect((await k.state()).plans.get(t.id)?.approvedVersion).toBe(2)
  })

  it('approvePlan records who approved: default human, mcp when an agent drove (P7)', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'attributed' }, WEB)
    await k.proposePlan(t.id, draft(), WEB)
    await k.approvePlan(t.id, undefined, { approvedBy: ApprovedBy.mcp }, WEB)
    const evt = must((await k.eventsFor(t.id)).find(e => e.kind === 'plan_approved'), 'plan_approved event')
    expect(PAYLOAD_SCHEMAS.plan_approved.parse(evt.payload).approvedBy).toBe(ApprovedBy.mcp)
  })

  it('child tasks inherit budget and increment depth', async () => {
    const k = await freshKernel()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'p', budgetUSD: 5 }, WEB)
    const child = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'c', parentId: parent.id }, WEB)
    expect(child.depth).toBe(1)
    expect(child.parentId).toBe(parent.id)
    expect(parent.budgetUSD).toBe(5)
    expect(child.budgetUSD).toBe(5)
  })

  it('rejects proposing twice', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await k.proposePlan(t.id, draft(), WEB)
    expect(await codeOf(k.proposePlan(t.id, draft(), WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })

  it('serializes concurrent proposes: exactly one v1 wins', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'race' }, WEB)
    const results = await Promise.allSettled([k.proposePlan(t.id, draft(), WEB), k.proposePlan(t.id, draft(), WEB)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect((await k.getPlan(t.id))?.version).toBe(1)
    expect((await k.state()).plans.get(t.id)?.versions).toHaveLength(1)
  })

  it('rejects editing before a proposal exists', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    expect(await codeOf(k.editPlan(t.id, draft(), WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
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
    for (const status of Object.values(TaskStatus)) {
      // one task per status on a shared log — status is per-task, so a DB per case buys nothing
      const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: `edit from ${status}` }, WEB)
      await k.proposePlan(t.id, draft(), WEB) // a plan must exist before editing is even meaningful
      if (status !== TASK_STATUS.awaiting_approval) await toStatus(log, t.id, status, WEB)
      outcomes[status] = await codeOf(k.editPlan(t.id, draft(), WEB))
      if (editable.has(status)) expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.awaiting_approval)
    }
    expect(outcomes).toEqual(Object.fromEntries(Object.values(TaskStatus).map(s =>
      [s, editable.has(s) ? 'no_error' : KERNEL_ERROR_CODE.invalid_transition])))
  }, 20_000)

  it('rejects approving a stale version', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await k.proposePlan(t.id, draft(), WEB)
    await k.editPlan(t.id, draft(), WEB)
    expect(await codeOf(k.approvePlan(t.id, 1, undefined, WEB))).toBe(KERNEL_ERROR_CODE.version_conflict)
  })

  it('rejects unknown tasks', async () => {
    const k = await freshKernel()
    expect(await codeOf(k.proposePlan('ghost', draft(), WEB))).toBe(KERNEL_ERROR_CODE.task_not_found)
  })

  it('rejects invalid plan drafts (cycle)', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    const bad = draftFixture([stepFixture({ id: 'a', dependsOn: ['b'] }), stepFixture({ id: 'b', dependsOn: ['a'] })])
    expect(await codeOf(k.proposePlan(t.id, bad, WEB))).toBe(KERNEL_ERROR_CODE.plan_validation_failed)
    expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.draft)
  })

  it('refuses a zone entry that names a directory, and appends no plan event', async () => {
    const dir = tmpWorkspaceDir()
    const { k, log } = await freshKernelAndLog(dir)
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    const before = (await log.all()).length
    const bad = draftFixture([stepFixture({ zone: ['src'] })])
    await expect(k.proposePlan(t.id, bad, WEB)).rejects.toThrow(/step 's1' zone entry 'src' names a directory.*'src\/\*\*'/)
    expect(await codeOf(k.proposePlan(t.id, bad, WEB))).toBe(KERNEL_ERROR_CODE.plan_validation_failed)
    expect((await log.all()).length).toBe(before)
    expect((await k.getTask(t.id))?.status).toBe(TASK_STATUS.draft)
  })

  it('accepts the same zone written as a glob under that directory', async () => {
    const dir = tmpWorkspaceDir()
    const { k } = await freshKernelAndLog(dir)
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await expect(k.proposePlan(t.id, draftFixture([stepFixture({ zone: ['src/**'] })]), WEB)).resolves.toBeDefined()
  })

  it('refuses an EDIT of a blocked task that introduces a directory zone entry', async () => {
    const dir = tmpWorkspaceDir()
    const { k, log } = await freshKernelAndLog(dir)
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await k.proposePlan(t.id, draftFixture([stepFixture({ zone: ['src/**'] })]), WEB)
    await toStatus(log, t.id, TASK_STATUS.blocked, WEB)
    expect(await codeOf(k.editPlan(t.id, draftFixture([stepFixture({ zone: ['src'] })]), WEB))).toBe(KERNEL_ERROR_CODE.plan_validation_failed)
  })

  it('propose fails with plan_validation_failed when the refValidator reports errors', async () => {
    const { log } = await freshKernelAndLog()
    const k = new Kernel(log, async () => [`unknown executor 'nope'`])
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await expect(k.proposePlan(t.id, draft(), WEB)).rejects.toThrow(/unknown executor 'nope'/)
  })

  it('propose succeeds when the refValidator returns no errors', async () => {
    const { log } = await freshKernelAndLog()
    const k = new Kernel(log, async () => [])
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await expect(k.proposePlan(t.id, draft(), WEB)).resolves.toBeDefined()
  })

  it('subscribe delivers appended events by seq', async () => {
    const kernel = await freshKernel()
    const seen: number[] = []
    const unsub = await kernel.subscribe({ fromSeq: 0 }, e => { seen.push(e.seq) })
    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await kernel.proposePlan(t.id, draft(), WEB) // more than one event, so ORDER is observable at all
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
    const t = await k.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'build web', spec: 's', modelRef: 'anthropic/claude-sonnet-5', analyzerRef: 'agent-analyzer' }, WEB)
    const plan = must(await k.getPlan(t.id), 'plan for task')
    expect(plan.strategyRef).toBe('grounded-plan')
    expect(plan.analyzerRef).toBe('agent-analyzer')
    expect(plan.steps.map(s => s.id)).toEqual(['analyze', 'plan'])
    expect(must(plan.steps[1], 'second step in plan').dependsOn).toEqual(['analyze'])
    expect(must(plan.steps[1], 'second step in plan').skillRefs).toEqual(['plan-authoring'])
    expect(must(await k.getTask(t.id), 'task').status).toBe(TASK_STATUS.approved)
  })

  // The plan-approval door showed 'cost estimate: none provided' for every plan ever proposed,
  // because both draft literals hardcoded null. The estimate is now MEASURED: what comparable
  // past tasks actually cost (projections.estimateCostUSD).
  it('createGroundedTask carries a measured cost estimate once a comparable grounded task has settled', async () => {
    const { log } = await freshKernelAndLog()
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout' })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const kg = new Kernel(log, undefined, analyzers)

    const first = await kg.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'first', spec: 's', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' }, WEB)
    // nothing comparable has settled yet — no history means no number, never a fabricated $0
    expect(must(await kg.getPlan(first.id), 'plan for first task').costEstimateUSD).toBeNull()

    const runToken = `step:${first.id}:analyze:a1`
    await log.append({
      ...WEB, taskId: first.id, stepId: 'analyze', runToken, kind: EVENT_KIND.agent_call,
      payload: { stepId: 'analyze', runToken, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 500, outputTokens: 100, costUSD: 0.42, estimated: false },
    })
    await log.append({
      ...WEB, taskId: first.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: first.id, from: TASK_STATUS.approved, to: TASK_STATUS.done },
    })

    const second = await kg.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'second', spec: 's', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' }, WEB)
    expect(must(await kg.getPlan(second.id), 'plan for second task').costEstimateUSD).toBeCloseTo(0.42, 10)
  })

  it('proposeSplit carries a measured cost estimate from prior split history', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: 'parent' }, WEB)
    await toRunning(log, parent.id, WEB)
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, spec: '', title: 'C',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }
    const one = await k.proposeSplit({ ...base, toolCallId: 'call_1' }, WEB)
    expect(must(await k.getPlan(one.childTaskId), 'plan for child task').costEstimateUSD).toBeNull() // no split has settled yet

    const runToken = `step:${one.childTaskId}:w1:a1`
    await log.append({
      ...WEB, taskId: one.childTaskId, stepId: 'w1', runToken, kind: EVENT_KIND.agent_call,
      payload: { stepId: 'w1', runToken, iteration: 1, request: {}, response: {} },
      usage: { inputTokens: 200, outputTokens: 40, costUSD: 0.25, estimated: false },
    })
    await log.append({
      ...WEB, taskId: one.childTaskId, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
      payload: { taskId: one.childTaskId, from: TASK_STATUS.approved, to: TASK_STATUS.done },
    })

    const two = await k.proposeSplit({ ...base, toolCallId: 'call_2' }, WEB)
    expect(must(await k.getPlan(two.childTaskId), 'plan for child task').costEstimateUSD).toBeCloseTo(0.25, 10)
  })

  it('createGroundedTask applies the project iteration budget to BOTH steps — subplans inherit the plan step', async () => {
    const { log } = await freshKernelAndLog()
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout', maxIterations: 30 })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel(log, undefined, analyzers)
    const t = await k.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x', spec: 's', modelRef: 'fake/m', analyzerRef: 'agent-analyzer', maxIterations: 60 }, WEB)
    expect(must(await k.getPlan(t.id), 'plan for task').steps.map(s => s.maxIterations)).toEqual([60, 60])
  })

  it('createGroundedTask forwards parentId — a grounded task can be a child, not only a root', async () => {
    const { log } = await freshKernelAndLog()
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout' })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel(log, undefined, analyzers)
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'parent' }, WEB)
    const t = await k.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'child', spec: 's', modelRef: 'fake/m', analyzerRef: 'agent-analyzer', parentId: parent.id }, WEB)
    const stored = must(await k.getTask(t.id), 'task')
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
      workspaceId: TEST_WORKSPACE_ID, title: 'release notes', spec: 'Summarize changes since v1.2 into notes.md', modelRef: 'fake/m', analyzerRef: 'agent-analyzer',
    }, WEB)

    expect((await k.getTask(task.id))?.spec).toBe('Summarize changes since v1.2 into notes.md')
    expect(analyzedSpec).toBe('Summarize changes since v1.2 into notes.md')
  })

  it('createGroundedTask rolls back the task when plan reference validation fails', async () => {
    const { log } = await freshKernelAndLog()
    const analyze: PlanStep = stepFixture({ id: 'analyze', role: 'scout', skillRefs: ['codebase-analysis'] })
    const analyzers = new Map<string, Analyzer>([['agent-analyzer', { id: 'agent-analyzer', analysisStep: () => analyze }]])
    const k = new Kernel(log, async () => [`unknown skill 'codebase-analysis'`], analyzers)

    await expect(k.createGroundedTask({
      workspaceId: TEST_WORKSPACE_ID, title: 'build web', spec: 'ground it', modelRef: 'fake/m', analyzerRef: 'agent-analyzer',
    }, WEB)).rejects.toThrow("unknown skill 'codebase-analysis'")

    expect((await log.all()).map(e => e.kind)).toEqual([EVENT_KIND.workspace_created]) // the seed alone: the whole creation rolled back
    expect(await k.listTasks()).toEqual([])
  })

  it('createGroundedTask rejects an unknown analyzerRef', async () => {
    const { log } = await freshKernelAndLog()
    const k = new Kernel(log, undefined, new Map())
    expect(await codeOf(k.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x', spec: '', modelRef: 'fake/m', analyzerRef: 'ghost' }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })

  it('createGroundedTask rejects an empty spec — the title is a label, never the goal', async () => {
    const k = await freshKernel()
    await expect(k.createGroundedTask({ workspaceId: TEST_WORKSPACE_ID, title: 'test', spec: '  ', modelRef: 'fake/m', analyzerRef: 'agent-analyzer' }, WEB))
      .rejects.toThrow(/grounded tasks need a spec/)
    expect(await k.listTasks()).toEqual([]) // nothing committed, no analyze run wasted
  })

  it('proposeSplit: deterministic ids, inherited refs, clamped budget, manual gate parks the child', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: 'parent', budgetUSD: 10 }, WEB)
    await toRunning(log, parent.id, WEB)
    const args = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: 'child work', budgetUSD: 99,
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [], zone: ['docs/**'] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }
    const r = await k.proposeSplit(args, WEB)
    expect(r).toEqual({ splitId: `split:step:${parent.id}:s1:a1:call_1`, childTaskId: `${parent.id}.s1.call_1`, gated: true })
    const child = await k.getTask(r.childTaskId)
    expect(child?.parentId).toBe(parent.id)
    expect(child?.depth).toBe(1)
    expect(child?.budgetUSD).toBe(10)             // clamped to subtree-remaining, not the requested 99
    expect(child?.status).toBe(TASK_STATUS.awaiting_approval) // manual default parks it
    const plan = await k.getPlan(r.childTaskId)
    expect(plan?.steps[0]).toMatchObject({ id: 'w1', executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5, isolation: 'local', zone: ['docs/**'] })
    // idempotent: same (runToken, toolCallId) → same ids, no second child
    const again = await k.proposeSplit(args, WEB)
    expect(again.childTaskId).toBe(r.childTaskId)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toHaveLength(1)
  })

  it('proposeSplit: refuses a model-authored committer step — the role is kernel-set only', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: 'parent' }, WEB)
    await toRunning(log, parent.id, WEB)
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      // an auto-approved child whose only step claims the committer role would arm git_commit
      // with no verify step anywhere — the exact bypass the reserved-role refusal closes
      plan: { steps: [{ id: 'commit', role: STEP_ROLE.committer, title: 'sneak', instructions: 'commit it', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }
    expect(await codeOf(k.proposeSplit(base, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toEqual([]) // no child minted
    // the kernel's own freeze stays open: the same draft authored by the freeze is accepted
    const ok = await k.proposeSplit({ ...base, toolCallId: 'call_2', authoredBy: SPLIT_ORIGIN.freeze }, WEB)
    expect((await k.getPlan(ok.childTaskId))?.steps[0]?.role).toBe(STEP_ROLE.committer)
  })

  it('proposeSplit: refuses a model-authored finisher step or a step named finish — kernel-set only', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: 'parent' }, WEB)
    await toRunning(log, parent.id, WEB)
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      // an auto-approved child claiming the finisher role would arm task_claims/record_decision on a
      // step the human never sees — the knowledge-authoring twin of the git_commit bypass above
      plan: { steps: [{ id: FINISH_STEP_ID, role: STEP_ROLE.finisher, title: 'sneak', instructions: 'reconcile it', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }
    expect(await codeOf(k.proposeSplit(base, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toEqual([]) // no child minted
    // either term alone is refused: the reserved ID under an ordinary role, and the role under
    // another id — the same both-terms shape stepMayReconcile gates on
    expect(await codeOf(k.proposeSplit({
      ...base, toolCallId: 'call_2',
      plan: { steps: [{ id: FINISH_STEP_ID, role: STEP_ROLE.worker, title: 'shadow', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
    }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect(await codeOf(k.proposeSplit({
      ...base, toolCallId: 'call_3',
      plan: { steps: [{ id: 'wrap-up', role: STEP_ROLE.finisher, title: 'shadow', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
    }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect(await codeOf(k.proposeSplit({
      ...base, toolCallId: 'call_5',
      plan: { steps: [{ id: CHECKS_STEP_ID, role: STEP_ROLE.worker, title: 'shadow', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
    }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    // the kernel's own freeze stays open: the same draft authored by the freeze is accepted
    const ok = await k.proposeSplit({ ...base, toolCallId: 'call_4', authoredBy: SPLIT_ORIGIN.freeze }, WEB)
    expect((await k.getPlan(ok.childTaskId))?.steps[0]?.role).toBe(STEP_ROLE.finisher)
  })

  it('proposePlan appends the finish step to a ROOT plan (single template or --file draft) but not to the grounded bootstrap', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'quick', spec: 'do' }, WEB)
    const plan = await k.proposePlan(t.id, draftFixture([stepFixture({ id: 's1' })]), WEB)
    expect(plan.steps.map(s => s.id)).toEqual(['s1', FINISH_STEP_ID])
    expect(plan.steps[1]?.role).toBe(STEP_ROLE.finisher)
    // an operator-authored multi-step draft (orc propose --file) is a root plan too — measured:
    // docs/kb-build-parallel.plan.json carries strategyRef 'file:…', not template:single
    const t2 = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'file', spec: 'do' }, WEB)
    const filePlan = await k.proposePlan(t2.id, { ...draftFixture([stepFixture({ id: 'a' }), stepFixture({ id: 'b', dependsOn: ['a'] })]), strategyRef: 'file:kb-build' }, WEB)
    expect(filePlan.steps.map(s => s.id)).toEqual(['a', 'b', FINISH_STEP_ID])
    // The grounded strategy is exempt at BOTH doors — asserted through the doors themselves, on a
    // draft that claims it. (createGroundedTask builds its [analyze, plan] scaffold inside its own
    // transaction and never calls proposePlan, so asserting on it here could not fail no matter
    // what this rule did; the scaffold's own shape is pinned by the createGroundedTask test above.)
    const t3 = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded-ish', spec: 'do' }, WEB)
    const grounded = { ...draftFixture([stepFixture({ id: STEP_ID.analyze, role: STEP_ROLE.scout })]), strategyRef: STRATEGY.groundedPlan }
    expect((await k.proposePlan(t3.id, grounded, WEB)).steps.map(s => s.id)).toEqual([STEP_ID.analyze])
    expect((await k.editPlan(t3.id, grounded, WEB)).steps.map(s => s.id)).toEqual([STEP_ID.analyze])
  })

  it('proposePlan leaves the auto-heal sweep draft alone — machine-drafted maintenance never parks on a human', async () => {
    const { k } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'sweep', spec: 'heal 9 notes' }, WEB)
    const plan = await k.proposePlan(t.id, { ...draftFixture([stepFixture({ id: 's1' })]), strategyRef: STRATEGY.sweep }, WEB)
    expect(plan.steps.map(s => s.id)).toEqual(['s1'])
  })

  it('editPlan applies the same rule: it appends to a root plan that lacks the step, and never doubles the rendered one', async () => {
    const { k } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'quick', spec: 'do' }, WEB)
    // (a) an edited draft the operator wrote from scratch, with no finish step in it
    const proposed = await k.proposePlan(t.id, draftFixture([stepFixture({ id: 's1' })]), WEB)
    const edited = await k.editPlan(t.id, draftFixture([stepFixture({ id: 's1' }), stepFixture({ id: 's2', dependsOn: ['s1'] })]), WEB)
    expect(edited.steps.map(s => s.id)).toEqual(['s1', 's2', FINISH_STEP_ID])
    // (b) the RENDERED plan edited and handed straight back — exactly one finish step, still last
    const again = await k.editPlan(t.id, { ...proposed, steps: edited.steps }, WEB)
    expect(again.steps.map(s => s.id)).toEqual(['s1', 's2', FINISH_STEP_ID])
    expect(again.steps.filter(s => s.role === STEP_ROLE.finisher)).toHaveLength(1)
  })

  it('editPlan refuses a draft whose finish step is not the kernel\'s — the id stays reserved', async () => {
    const { k } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'quick', spec: 'do' }, WEB)
    await k.proposePlan(t.id, draftFixture([stepFixture({ id: 's1' })]), WEB)
    await expect(k.editPlan(t.id, draftFixture([
      stepFixture({ id: 's1' }), stepFixture({ id: FINISH_STEP_ID, role: STEP_ROLE.worker, dependsOn: ['s1'] }),
    ]), WEB)).rejects.toThrow(/finish/)
  })

  it('proposePlan leaves a SPLIT child alone — a child\'s finish is its parent\'s job', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: 'parent' }, WEB)
    await toRunning(log, parent.id, WEB)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: STEP_ROLE.worker, title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }, WEB)
    expect((await k.getPlan(child.childTaskId))?.steps.map(s => s.id)).toEqual(['w1'])
  })

  it('openFeedbackInSubtree finds a question parked on a DESCENDANT, not only on the root', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: 'parent' }, WEB)
    await toRunning(log, parent.id, WEB)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }, WEB)
    expect(await k.openFeedbackInSubtree(parent.id)).toBeNull()
    await log.append({
      ...WEB, taskId: child.childTaskId, stepId: 'w1', runToken: `step:${child.childTaskId}:w1:a1`,
      kind: EVENT_KIND.feedback_requested, payload: { question: 'may I overwrite it?', topic: 'confirm' },
    })
    expect(await k.openFeedbackInSubtree(parent.id))
      .toMatchObject({ taskId: child.childTaskId, question: 'may I overwrite it?', topic: 'confirm' })
  })

  it('gatedChildren names the descendants a manual policy parked, and only those', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: 'parent' }, WEB)
    await toRunning(log, parent.id, WEB)
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      maxDepth: 3,
    }
    const gated = await k.proposeSplit({ ...base, toolCallId: 'call_1', title: 'needs approval', policy: ApprovalPolicy.parse({}) }, WEB)
    await k.proposeSplit({ ...base, toolCallId: 'call_2', title: 'auto', policy: ApprovalPolicy.parse({ default: 'auto' }) }, WEB)
    expect(await k.gatedChildren(parent.id)).toEqual([{ id: gated.childTaskId, title: 'needs approval' }])
  })

  it('proposeSplit: rejects a cross-attempt childTaskId collision (same toolCallId, new runToken)', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: '', budgetUSD: 10 }, WEB)
    await toRunning(log, parent.id, WEB)
    const base = {
      parentTaskId: parent.id, stepId: 's1', toolCallId: 'call_1',
      title: 'C', spec: 'child work',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }
    await k.proposeSplit({ ...base, runToken: `step:${parent.id}:s1:a1` }, WEB)
    // a2 mints a NEW splitId (runToken differs) but the SAME attempt-independent childTaskId —
    // slips past the `existing` check, so the collision guard must reject it (poisoned fold otherwise)
    expect(await codeOf(k.proposeSplit({ ...base, runToken: `step:${parent.id}:s1:a2` }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toHaveLength(1)
  })

  it('proposeSplit: auto policy approves with provenance; depth cap rejects', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: '' }, WEB)
    await toRunning(log, parent.id, WEB)
    const auto = ApprovalPolicy.parse({ default: 'auto' })
    const base = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_2',
      title: 'C', spec: '', plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: auto, maxDepth: 3,
    }
    const r = await k.proposeSplit(base, WEB)
    expect(r.gated).toBe(false)
    expect((await k.getTask(r.childTaskId))?.status).toBe(TASK_STATUS.approved)
    const approvedEvt = (await k.eventsFor(r.childTaskId)).find(e => e.kind === 'plan_approved')
    expect(approvedEvt?.payload).toMatchObject({ approvedBy: ApprovedBy.policy })
    await expect(k.proposeSplit({ ...base, toolCallId: 'call_3', maxDepth: 0 }, WEB)).rejects.toThrow(/depth/)
  })

  it('proposeSplit: refuses a split from a non-running (cancelled) parent — closes the cancel race', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: '' }, WEB)
    await log.append({ ...WEB, taskId: parent.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: parent.id, from: TASK_STATUS.draft, to: TASK_STATUS.cancelled } })
    const args = {
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_9',
      title: 'C', spec: '', plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({}), maxDepth: 3,
    }
    expect(await codeOf(k.proposeSplit(args, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect((await k.listTasks()).filter(t => t.parentId === parent.id)).toHaveLength(0)
  })

  it('annotatePlan appends plan_annotated; replyFeedback resolves and answers the open feedback topic', async () => {
    const { log } = await freshKernelAndLog()
    const sent: Array<{ runToken: string; message: string; topic: string; key?: string }> = []
    const k = new Kernel(log, undefined, undefined, async (runToken, message, topic, key) => { sent.push({ runToken, message, topic, key }) })
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded task' }, WEB)
    await k.proposePlan(t.id, draft(), WEB)
    await k.approvePlan(t.id, undefined, undefined, WEB)
    // simulate the port raising a feedback gate from inside the running plan step (this test
    // adds only the human-facing reply/annotate surface — the gate is added in dbos-port)
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ ...WEB, taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'db choice?', topic: 'db-1' } })

    await k.annotatePlan(t.id, { targetNote: 'db', refs: ['api'], text: 'use bcrypt' }, WEB)
    expect((await log.byTask(t.id)).some(e => e.kind === 'plan_annotated')).toBe(true)

    const topic = await k.replyFeedback(t.id, 'approve', WEB)
    expect(topic).toBe('db-1')
    const provided = must((await log.byTask(t.id)).find(e => e.kind === 'feedback_provided'), 'feedback_provided event')
    expect(provided).toMatchObject({
      taskId: t.id, stepId: 'plan', runToken,
      idempotencyKey: expect.stringMatching(/^feedback:\d+:provided$/),
    })
    expect(sent).toEqual([{ runToken, message: 'approve', topic: 'feedback:db-1', key: `feedback:${provided.seq}` }])

    // the gate is now answered — a second reply finds no open question
    expect(await k.replyFeedback(t.id, 'again', WEB)).toBeNull()
  })

  it('replyFeedback binds exact grounded plan approval to the current graph hash', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded', type: 'grounded' }, WEB)
    const scope = planScope(t.id)
    const author = authorFixture({ source: AUTHOR_SOURCE.agent })
    await log.append({ ...WEB, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'masterplan', scope, tier: 'plan', title: 'Plan', links: [{ id: 'db', kind: LINK_KIND.decomposes_into }] }, author } })
    await log.append({ ...WEB, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'db', scope, tier: 'plan', title: 'DB', body: 'schema' }, author } })
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ ...WEB, taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'approve?', topic: 'plan-1' } })

    await k.replyFeedback(t.id, '  ApPrOvE  ', WEB)

    const provided = must((await log.byTask(t.id)).find(e => e.kind === EVENT_KIND.feedback_provided), 'feedback_provided event')
    expect(provided.payload.planHash).toBe(planGraphHash(await k.listPlanNotes(t.id)))
  })

  // A human answered "agree" and the gate silently read it as ordinary feedback: the plan never
  // froze and the agent re-asked. The gate is the vocabulary now, not one magic word.
  it('replyFeedback stamps for any word in ApprovalAnswer, not just the canonical one', async () => {
    const { k, log } = await freshKernelAndLog()
    for (const text of ['agree', 'Agreed', ' LGTM ', 'yes', APPROVAL_ANSWER]) {
      const task = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: text, type: 'grounded' }, WEB)
      await log.append({
        ...WEB, taskId: task.id, stepId: 'plan', runToken: `step:${task.id}:plan:a1`,
        kind: EVENT_KIND.feedback_requested, payload: { question: 'approve?', topic: 'plan-1' },
      })
      await k.replyFeedback(task.id, text, WEB)
      const provided = must((await log.byTask(task.id)).find(e => e.kind === EVENT_KIND.feedback_provided), 'feedback_provided event')
      expect(provided.payload).toHaveProperty('planHash')
    }
  })

  it('replyFeedback does not stamp ordinary or non-approve replies', async () => {
    const { k, log } = await freshKernelAndLog()
    // 'not yet' / 'approve later' are the near-misses that matter: whole-string only, so an answer
    // that merely CONTAINS an approval word is still ordinary feedback.
    for (const [type, text] of [['generic', 'approve'], ['grounded', 'not yet'], ['grounded', 'approve later']] as const) {
      const task = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: type, type }, WEB)
      await log.append({
        ...WEB, taskId: task.id, stepId: 'plan', runToken: `step:${task.id}:plan:a1`,
        kind: EVENT_KIND.feedback_requested, payload: { question: 'continue?', topic: `${type}-1` },
      })
      await k.replyFeedback(task.id, text, WEB)
      const provided = must((await log.byTask(task.id)).find(e => e.kind === EVENT_KIND.feedback_provided), 'feedback_provided event')
      expect(provided.payload).not.toHaveProperty('planHash')
    }
  })

  it('approvedPlanHash is scoped to the exact run attempt', async () => {
    const { k, log } = await freshKernelAndLog()
    const task = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded', type: 'grounded' }, WEB)
    const runA = `step:${task.id}:plan:a1`
    const runB = `step:${task.id}:plan:a2`
    await log.append({ ...WEB, taskId: task.id, stepId: 'plan', runToken: runA, kind: EVENT_KIND.feedback_provided, payload: { topic: 'a', text: 'approve', author: authorFixture(), planHash: 'a'.repeat(64) } })
    await log.append({ ...WEB, taskId: task.id, stepId: 'plan', runToken: runB, kind: EVENT_KIND.feedback_provided, payload: { topic: 'b', text: 'approve', author: authorFixture(), planHash: 'b'.repeat(64) } })

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
    const task = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded', type: 'grounded' }, WEB)
    const runA = `step:${task.id}:plan:a1`
    const runB = `step:${task.id}:plan:a2`
    const provided = (runToken: string, topic: string, source: AuthorSource) => log.append({
      ...WEB, taskId: task.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_provided,
      payload: { topic, text: 'approve', author: authorFixture({ source }), planHash: 'a'.repeat(64) },
    })
    await provided(runA, 'a', AUTHOR_SOURCE.mcp)
    await provided(runB, 'b', AUTHOR_SOURCE.cli)

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
      ...WEB, taskId, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_provided,
      payload: { topic: 'a', text: 'approve', author: authorFixture({ source: AUTHOR_SOURCE.mcp }), planHash: 'a'.repeat(64) },
    })

  it('by default only the cli door satisfies the plan gate — an mcp approve is refused and reported', async () => {
    const { k, log } = await freshKernelAndLog()
    const task = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded', type: 'grounded' }, WEB)
    const runToken = `step:${task.id}:plan:a1`
    await mcpApproval(log, task.id, runToken)

    expect(await k.approvedPlanHash(task.id, runToken)).toBeNull()
    expect(await k.nonHumanPlanApproval(task.id, runToken)).toEqual({ source: 'mcp' })
  })

  it('a kernel configured with the mcp door accepts that same approve, and stops calling it non-human', async () => {
    const { k, log } = await freshKernelAndLog()
    const task = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'grounded', type: 'grounded' }, WEB)
    const runToken = `step:${task.id}:plan:a1`
    await mcpApproval(log, task.id, runToken)
    const widened = new Kernel(log, undefined, undefined, undefined, [GroundedApprovalDoor.cli, GroundedApprovalDoor.mcp])

    expect(await widened.approvedPlanHash(task.id, runToken)).toMatchObject({ hash: 'a'.repeat(64) })
    // the inverted sibling reads the SAME list, so an accepted door is never also reported as the
    // door that failed — the refusal message and the gate cannot disagree
    expect(await widened.nonHumanPlanApproval(task.id, runToken)).toBeNull()
    // attribution is never rewritten: the event still records the door it came through
    const provided = must((await log.byTask(task.id)).find(e => e.kind === EVENT_KIND.feedback_provided), 'feedback_provided event')
    expect((provided.payload as { author: { source: string } }).author.source).toBe('mcp')
  })

  it('replyFeedback appends feedback_provided and returns the topic even without an injected send', async () => {
    const { k, log } = await freshKernelAndLog() // no send wired — matches read-only CLI / most-tests construction
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    const runToken = `step:${t.id}:s1:a1`
    await log.append({ ...WEB, taskId: t.id, stepId: 's1', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'q', topic: 'topic-1' } })

    const topic = await k.replyFeedback(t.id, 'yes', WEB)
    expect(topic).toBe('topic-1')
    expect((await log.byTask(t.id)).some(e => e.kind === 'feedback_provided')).toBe(true)
  })

  it('replyFeedback targets the later still-open topic when an earlier one is already answered', async () => {
    const { log } = await freshKernelAndLog()
    const sent: Array<{ runToken: string; topic: string }> = []
    const k = new Kernel(log, undefined, undefined, async (runToken, _message, topic) => { sent.push({ runToken, topic }) })
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    const runTokenA = `step:${t.id}:s1:a1`
    const runTokenB = `step:${t.id}:s2:a1`
    await log.append({ ...WEB, taskId: t.id, stepId: 's1', runToken: runTokenA, kind: EVENT_KIND.feedback_requested, payload: { question: 'q1', topic: 'topic-a' } })
    await log.append({ ...WEB, taskId: t.id, stepId: 's1', runToken: null, kind: EVENT_KIND.feedback_provided, payload: { topic: 'topic-a', text: 'ok', author: authorFixture() } })
    await log.append({ ...WEB, taskId: t.id, stepId: 's2', runToken: runTokenB, kind: EVENT_KIND.feedback_requested, payload: { question: 'q2', topic: 'topic-b' } })

    const topic = await k.replyFeedback(t.id, 'approve', WEB)
    expect(topic).toBe('topic-b') // the later, still-open topic — not the answered 'topic-a', not null
    expect(sent).toEqual([{ runToken: runTokenB, topic: 'feedback:topic-b' }])
  })

  it('openFeedback surfaces the latest unanswered feedback_requested, then null once answered', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    expect(await k.openFeedback(t.id)).toBeNull() // nothing pending
    const runToken = `step:${t.id}:plan:a1`
    await log.append({ ...WEB, taskId: t.id, stepId: 'plan', runToken, kind: EVENT_KIND.feedback_requested, payload: { question: 'changes or approve?', topic: 'plan-1' } })
    expect(await k.openFeedback(t.id)).toMatchObject({ topic: 'plan-1', question: 'changes or approve?' })
    await k.replyFeedback(t.id, 'approve', WEB)
    expect(await k.openFeedback(t.id)).toBeNull() // answered → nothing to reply to
  })

  it('reportCoverage appends analysis_completed carrying the parsed CoverageReport (defaults + provenance)', async () => {
    const { k, log } = await freshKernelAndLog()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    const runToken = `step:${t.id}:analyze:a1`
    await k.reportCoverage({ taskId: t.id, stepId: 'analyze', runToken }, { analyzed: true, gaps: ['no tests read'] }, WEB)
    const ev = must((await log.byTask(t.id)).find(e => e.kind === EVENT_KIND.analysis_completed), 'analysis_completed event')
    expect(ev.runToken).toBe(runToken) // emitted from within the analyze step
    const p = PAYLOAD_SCHEMAS.analysis_completed.parse(ev.payload)
    expect(p.analyzed).toBe(true)
    expect(p.gaps).toEqual(['no tests read'])
    expect(p.confidence).toBe(Confidence.none) // default
    expect(p.claimsWritten).toBe(0) // default
  })

  it('latestCoverage returns the most recent analysis_completed, or null before any', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    expect(await k.latestCoverage(t.id)).toBeNull()
    const ctx = { taskId: t.id, stepId: 'analyze', runToken: `step:${t.id}:analyze:a1` }
    await k.reportCoverage(ctx, { analyzed: false }, WEB)
    await k.reportCoverage(ctx, { analyzed: true, scope: ['pkgs'], gaps: ['no tests'], confidence: Confidence.low, claimsWritten: 2 }, WEB)
    const cov = await k.latestCoverage(t.id)
    expect(cov).toMatchObject({ analyzed: true, claimsWritten: 2, gaps: ['no tests'] }) // the latest, not the first
  })

  it('annotatePlan rejects once the task is done, cancelled, or failed', async () => {
    const { k, log } = await freshKernelAndLog()
    // Kernel has no public "mark done"/"mark failed" mutator (that's the execution port's job,
    // out of scope here) — append the status change directly, the way the port's run-finish
    // checkpoint does.
    for (const to of [TASK_STATUS.done, TASK_STATUS.cancelled, TASK_STATUS.failed] as const) {
      const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
      await k.proposePlan(t.id, draft(), WEB)
      await k.approvePlan(t.id, undefined, undefined, WEB)
      await log.append({ ...WEB, taskId: t.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed, payload: { taskId: t.id, from: TASK_STATUS.approved, to } })
      expect(await codeOf(k.annotatePlan(t.id, { targetNote: 'db', refs: [], text: 'x' }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
    }
  })

  it('listAnnotations returns the appended plan_annotated events, in chronological order', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x' }, WEB)
    await k.proposePlan(t.id, draft(), WEB)
    await k.approvePlan(t.id, undefined, undefined, WEB)
    expect(await k.listAnnotations(t.id)).toEqual([])

    await k.annotatePlan(t.id, { targetNote: 'db', refs: ['api'], text: 'use bcrypt' }, WEB)
    await k.annotatePlan(t.id, { targetNote: 'api', refs: [], text: 'add rate limiting' }, WEB)

    const annotations = await k.listAnnotations(t.id)
    expect(annotations).toHaveLength(2)
    expect(annotations[0]).toMatchObject({ targetNote: 'db', refs: ['api'], text: 'use bcrypt', planVersion: 1 })
    expect(annotations[1]).toMatchObject({ targetNote: 'api', refs: [], text: 'add rate limiting', planVersion: 1 })
    expect(must(annotations[0], 'first annotation').seq).toBeLessThan(must(annotations[1], 'second annotation').seq)
  })

  // the freeze reads plan-notes from the LOG, never the async SurrealDB projection. Here NO
  // memory projector runs, so the read model is empty — pre-fix finalize (store.list/get) would see
  // "no masterplan"; listPlanNotes folds the memory_written events straight off the log and succeeds.
  it('listPlanNotes reconstructs the plan-note graph from the log with no projection running', async () => {
    const { k, log } = await freshKernelAndLog()
    const taskId = 'grounded-1'
    const scope = planScope(taskId)
    const author = authorFixture({ source: AUTHOR_SOURCE.agent })
    // memory_written events carry taskId:null (scoped by note.scope) — exactly what store.write appends
    await log.append({ ...WEB, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'masterplan', scope, tier: 'plan', title: 'Web app', links: [{ id: 'db', kind: LINK_KIND.decomposes_into }] }, author } })
    await log.append({ ...WEB, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'db', scope, tier: 'plan', title: 'DB', body: 'schema' }, author } })
    // a note in ANOTHER task's scope must not bleed into this task's freeze
    await log.append({ ...WEB, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note: { id: 'masterplan', scope: planScope('other'), tier: 'plan', title: 'Theirs' }, author } })

    const notes = await k.listPlanNotes(taskId)
    expect(notes.map(n => n.id).sort()).toEqual(['db', 'masterplan'])
    expect(must(notes.find(n => n.id === 'masterplan'), 'masterplan note').title).toBe('Web app')
    expect(instantiateFrozenPlan('masterplan', notes).steps.map(s => s.id)).toEqual(['db'])
  })

  it('freezes a subplan-declared modelRef, and omits the key when the planner left it empty', async () => {
    const { k, log } = await freshKernelAndLog()
    const scope = planScope('grounded-models')
    const author = authorFixture({ source: AUTHOR_SOURCE.agent })
    const note = (id: string, over: Record<string, unknown> = {}) => log.append({
      ...WEB, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
      payload: { note: { id, scope, tier: NOTE_TIER.plan, title: id, ...over }, author },
    })
    await note('masterplan', { links: [{ id: 'cheap', kind: LINK_KIND.decomposes_into }, { id: 'hard', kind: LINK_KIND.decomposes_into }] })
    await note('cheap')
    await note('hard', { modelRef: 'anthropic/claude-opus-5' })

    const steps = instantiateFrozenPlan('masterplan', await k.listPlanNotes('grounded-models')).steps
    // absent, not '': the expansion inherits via `?? parentStep.modelRef`, which '' would defeat
    expect(steps.find(s => s.id === 'cheap')).not.toHaveProperty('modelRef')
    expect(must(steps.find(s => s.id === 'hard'), 'hard step').modelRef).toBe('anthropic/claude-opus-5')
  })

  it('requestRun records the ask, with the cwd override the supervisor cannot derive', async () => {
    const k = await freshKernel()
    const t = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'x', spec: 's' }, WEB)
    await k.proposePlan(t.id, draft(), WEB)
    await k.approvePlan(t.id, undefined, undefined, WEB)
    await k.requestRun(t.id, { cwd: '/tree' }, WEB)
    const e = must((await k.eventsFor(t.id)).find(x => x.kind === EVENT_KIND.run_requested), 'run_requested event')
    expect(PAYLOAD_SCHEMAS.run_requested.parse(e.payload)).toEqual({ taskId: t.id, cwd: '/tree', retry: false })
  })

  it('requestRun refuses a task that does not exist, so the event can never name a ghost', async () => {
    const k = await freshKernel()
    await expect(k.requestRun('ghost', {}, WEB)).rejects.toThrow(/no task/)
  })

  it('cancelSubtree stamps the whole subtree cancelled, so a client can cancel without a port', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: '' }, WEB)
    await toRunning(log, parent.id, WEB)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }, WEB)
    expect((await k.cancelSubtree(parent.id, WEB)).sort()).toEqual([parent.id, child.childTaskId].sort())
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
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: '' }, WEB)
    await toRunning(log, parent.id, WEB)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }, WEB)
    // an unrelated sibling task with its OWN write — must never appear in the parent's set
    const sibling = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'unrelated', spec: '' }, WEB)

    // helper: a confirmed write (tool_call + isError:false tool_result on the same toolCallId)
    const write = async (taskId: string, stepId: string, toolCallId: string, path: string) => {
      const runToken = `step:${taskId}:${stepId}:a1`
      await log.append({ ...WEB, taskId, stepId, runToken, kind: EVENT_KIND.tool_call, payload: { stepId, runToken, iteration: 1, toolCallId, toolName: 'fs_write', input: { path } } })
      await log.append({ ...WEB, taskId, stepId, runToken, kind: EVENT_KIND.tool_result, payload: { stepId, runToken, iteration: 1, toolCallId, toolName: 'fs_write', output: {}, isError: false } })
    }
    await write(parent.id, 's1', 'p1', 'src/parent.ts')
    await write(child.childTaskId, 'w1', 'w1c', './src/child.ts') // delegated write, normalizes to src/child.ts
    await write(sibling.id, 's1', 's1x', 'src/sibling.ts')

    const rows = await k.listTaskChangedPaths(parent.id)
    const paths = rows.map(r => r.path).sort()
    expect(paths).toEqual(['src/child.ts', 'src/parent.ts']) // descendant included, sibling excluded
    // each path is attributed to its OWNING task id
    expect(must(rows.find(r => r.path === 'src/child.ts'), 'child file row').taskId).toBe(child.childTaskId)
    expect(must(rows.find(r => r.path === 'src/parent.ts'), 'parent file row').taskId).toBe(parent.id)
    expect(must(rows.find(r => r.path === 'src/child.ts'), 'child file row').steps).toEqual([{ stepId: 'w1', tool: 'fs_write', seq: expect.any(Number) }])

    // the sibling's own set sees only its write, never the parent/child ones
    expect((await k.listTaskChangedPaths(sibling.id)).map(r => r.path)).toEqual(['src/sibling.ts'])
  })

  it('listTaskKnowledgeWrites folds the task and its descendants\' knowledge writes in log order, and no sibling\'s', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: '' }, WEB)
    await toRunning(log, parent.id, WEB)
    const child = await k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'C', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }, WEB)
    const sibling = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'unrelated', spec: '' }, WEB)
    const written = async (taskId: string, over: { added?: string[]; retired?: string[]; files: string[] }) =>
      log.append({
        ...WEB, taskId, stepId: 's1', runToken: null, kind: EVENT_KIND.knowledge_written,
        payload: {
          added: (over.added ?? []).map(id => ({ id, location: `knowledge/${id}.md` })), changed: [],
          retired: (over.retired ?? []).map(id => ({ id, location: `knowledge/${id}.md` })),
          files: over.files, why: 'w', decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [], author: authorFixture({ taskId }),
        },
      })
    await written(parent.id, { added: ['aaaaaaaa'], files: ['knowledge/aaaaaaaa.md'] })
    await written(child.childTaskId, { added: ['bbbbbbbb'], files: ['knowledge/bbbbbbbb.md'] })
    await written(sibling.id, { added: ['cccccccc'], files: ['knowledge/cccccccc.md'] })
    await written(child.childTaskId, { retired: ['aaaaaaaa'], files: ['knowledge/aaaaaaaa.md'] })

    expect(await k.listTaskKnowledgeWrites(parent.id)).toEqual({
      live: [{ id: 'bbbbbbbb', location: 'knowledge/bbbbbbbb.md' }],
      retired: [{ id: 'aaaaaaaa', location: 'knowledge/aaaaaaaa.md' }],
      files: ['knowledge/aaaaaaaa.md', 'knowledge/bbbbbbbb.md'],
    })
    expect((await k.listTaskKnowledgeWrites(sibling.id)).live.map(r => r.id)).toEqual(['cccccccc'])
  })

  it('cancelSubtree stamps a child whose split commits after the snapshot, before the sweep', async () => {
    const { k, log } = await freshKernelAndLog()
    const parent = await k.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'P', spec: '' }, WEB)
    await toRunning(log, parent.id, WEB)
    let injected = false
    const inject = () => k.proposeSplit({
      parentTaskId: parent.id, stepId: 's1', runToken: `step:${parent.id}:s1:a1`, toolCallId: 'call_1',
      title: 'late child', spec: '',
      plan: { steps: [{ id: 'w1', role: 'worker', title: 'w', instructions: 'do', dependsOn: [], skillRefs: [], toolRefs: [] }] },
      parentStep: { executorRef: 'api-loop', modelRef: 'fake/m', maxIterations: 5 },
      policy: ApprovalPolicy.parse({ default: 'auto' }), maxDepth: 3,
    }, WEB)
    const racingLog = new Proxy(log, {
      get(target, prop, receiver) {
        if (prop !== 'transaction') return Reflect.get(target, prop, receiver)
        return async (fn: (tx: EventLogOps) => Promise<unknown>) => {
          if (!injected) { injected = true; await inject() }
          return target.transaction(fn)
        }
      },
    })
    const stamped = await new Kernel(racingLog).cancelSubtree(parent.id, WEB)
    const childId = `${parent.id}.s1.call_1`
    expect(stamped.sort()).toEqual([parent.id, childId].sort())
    expect((await k.getTask(childId))?.status).toBe(TASK_STATUS.cancelled)
  })
})

describe('workspaces', () => {
  const cwd = '/tmp/orc-ws-test/repo'
  it('ensureWorkspace is idempotent on cwd and titles from the branch', async () => {
    const k = await freshKernel()
    const first = await k.ensureWorkspace({ cwd, branch: 'feat/x', kind: WORKSPACE_KIND.checkout, onTrunk: false }, WEB)
    const again = await k.ensureWorkspace({ cwd, branch: 'feat/x', kind: WORKSPACE_KIND.checkout, onTrunk: false }, WEB)
    expect(first.created).toBe(true)
    expect(again).toEqual({ workspace: first.workspace, created: false })
    expect(first.workspace).toMatchObject({ title: 'feat/x', managed: false, kind: 'checkout', archivedAt: null })
  })
  // cwd is the NATURAL KEY: '/repo' and '/repo/' are one directory, and two live records for one
  // directory make workspaceByCwd answer whichever was minted first.
  it('two spellings of one directory are one workspace', async () => {
    const k = await freshKernel()
    const first = await k.ensureWorkspace({ cwd, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB)
    const again = await k.ensureWorkspace({ cwd: `${cwd}/`, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB)
    expect(again).toEqual({ workspace: first.workspace, created: false })
    expect(again.workspace.cwd).toBe(cwd) // the record stores the normalized spelling
    const dotted = await k.ensureWorkspace({ cwd: `${cwd}/./`, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB)
    expect(dotted.created).toBe(false)
    expect(await codeOf(k.createWorkspace({ title: 'dup', cwd: `${cwd}/`, branch: 'orc/dup', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }, WEB)))
      .toBe(KERNEL_ERROR_CODE.invalid_transition)
    // an empty cwd resolves to the PROCESS's directory, which would mint a record for a directory
    // nobody named — refused by code rather than silently adopted
    expect(await codeOf(k.ensureWorkspace({ cwd: '', branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })
  it('ensureWorkspace titles from the directory name on a detached HEAD', async () => {
    const k = await freshKernel()
    expect((await k.ensureWorkspace({ cwd: '/x/y/my-checkout', branch: null, kind: WORKSPACE_KIND.checkout, onTrunk: false }, WEB)).workspace.title).toBe('my-checkout')
  })
  it('an archived workspace does not satisfy ensureWorkspace — a fresh record is created', async () => {
    const k = await freshKernel()
    const { workspace } = await k.ensureWorkspace({ cwd, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB)
    await k.setWorkspaceArchived(workspace.id, true, WEB)
    const next = await k.ensureWorkspace({ cwd, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB)
    expect(next.created).toBe(true)
    expect(next.workspace.id).not.toBe(workspace.id)
    // TEST_WORKSPACE_ID is the helper's seed, minted before either of these — named here rather
    // than filtered out, so the listing stays an exact set and a stray record still fails.
    expect((await k.listWorkspaces()).map(w => w.id)).toEqual([TEST_WORKSPACE_ID, next.workspace.id])
    expect((await k.listWorkspaces({ includeArchived: true })).map(w => w.id)).toEqual([TEST_WORKSPACE_ID, workspace.id, next.workspace.id])
  })
  it('retitle and archive/restore fold back; unknown ids are refused by name', async () => {
    const k = await freshKernel()
    const w = await k.createWorkspace({ title: 'Req', cwd: '/r/.orc/worktrees/req', branch: 'orc/req', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }, WEB)
    expect((await k.retitleWorkspace(w.id, 'Request', WEB)).title).toBe('Request')
    expect((await k.setWorkspaceArchived(w.id, true, WEB)).archivedAt).not.toBeNull()
    expect((await k.setWorkspaceArchived(w.id, false, WEB)).archivedAt).toBeNull()
    expect(await codeOf(k.retitleWorkspace('nope', 'x', WEB))).toBe(KERNEL_ERROR_CODE.workspace_not_found)
  })
  it('createWorkspace refuses a second record at a live cwd', async () => {
    const k = await freshKernel()
    const input = { title: 'Req', cwd: '/r/.orc/worktrees/req', branch: 'orc/req', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }
    await k.createWorkspace(input, WEB)
    expect(await codeOf(k.createWorkspace(input, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })
  // The one door that re-seats an EXISTING record rather than minting one. `orc purge` wipes the
  // whole log, workspace_created included, and then re-seeds the project's identity notes — whose
  // author has to name a workspace the log still carries, under the SAME id the notes were written
  // against. Going through the kernel (not a raw append at the call site) is what keeps the
  // "one active record per cwd" rule enforced inside a transaction against a concurrent adoption.
  it('restoreWorkspace re-seats a record on an empty log, keeping its id verbatim', async () => {
    const k = await freshKernel()
    const original = await k.createWorkspace({ title: 'Req', cwd: '/r/.orc/worktrees/req', branch: 'orc/req', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }, WEB)
    const fresh = await freshKernel() // a log that has never seen THIS record — the post-purge state
    const restored = await fresh.restoreWorkspace(original, WEB)
    expect(restored).toEqual(original) // id, createdAt, branch — the record verbatim, nothing re-minted
    // exactly one live record at that directory, and it is the original: a re-mint would show a new id
    expect((await fresh.listWorkspaces()).filter(w => w.cwd === original.cwd)).toEqual([original])
  })
  it('restoreWorkspace refuses when an ACTIVE record already holds that cwd', async () => {
    const k = await freshKernel()
    const original = await k.createWorkspace({ title: 'Req', cwd: '/r/.orc/worktrees/req', branch: 'orc/req', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }, WEB)
    // a concurrent boot adoption got there first, under its own id — re-seating would be the second
    // live record for one directory, exactly what workspaceByCwd cannot answer
    expect(await codeOf(k.restoreWorkspace({ ...original, id: '99999999-9999-4999-8999-999999999999' }, WEB)))
      .toBe(KERNEL_ERROR_CODE.invalid_transition)
    expect((await k.listWorkspaces()).filter(w => w.cwd === original.cwd)).toEqual([original]) // nothing appended
  })
  it('mergeWorkspace records the commit once; a second merge is refused', async () => {
    const k = await freshKernel()
    const w = await k.createWorkspace({ title: 'R', cwd: '/r/.orc/worktrees/r', branch: 'orc/r', baseBranch: 'main', kind: WORKSPACE_KIND.worktree, managed: true, onTrunk: false }, WEB)
    const m = await k.mergeWorkspace(w.id, { mergeCommit: 'abc123', trunk: 'main' }, WEB)
    expect(m).toMatchObject({ workspaceId: w.id, mergeCommit: 'abc123', trunk: 'main' })
    expect((await k.state()).workspaceMerges.get(w.id)?.mergeCommit).toBe('abc123')
    expect(await codeOf(k.mergeWorkspace(w.id, { mergeCommit: 'def', trunk: 'main' }, WEB))).toBe(KERNEL_ERROR_CODE.invalid_transition)
  })
  // Adoption runs at BOOT, so a Workspace.parse that throws on the derived title fails every orc
  // command in that checkout — a long branch name would lock the operator out of their own repo.
  it('a branch longer than the title limit is truncated, not refused', async () => {
    const k = await freshKernel()
    const branch = `feat/${'x'.repeat(125)}` // 130 chars — past WORKSPACE_TITLE_MAX
    const { workspace } = await k.ensureWorkspace({ cwd: `${cwd}-long`, branch, kind: WORKSPACE_KIND.checkout, onTrunk: false }, WEB)
    expect(branch.length).toBe(130)
    expect(workspace.title.length).toBe(WORKSPACE_TITLE_MAX)
    expect(branch.startsWith(workspace.title)).toBe(true) // the head of the branch, so it stays recognisable
  })
  it('createTask binds a workspace and refuses an unknown one', async () => {
    const k = await freshKernel()
    const { workspace } = await k.ensureWorkspace({ cwd, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB)
    expect((await k.createTask({ title: 't', workspaceId: workspace.id }, WEB)).workspaceId).toBe(workspace.id)
    expect(await codeOf(k.createTask({ title: 't', workspaceId: 'ghost' }, WEB))).toBe(KERNEL_ERROR_CODE.workspace_not_found)
    // a root task with nothing to inherit from is refused by name, never bound to a made-up id
    expect(await codeOf(k.createTask({ title: 't' }, WEB))).toBe(KERNEL_ERROR_CODE.workspace_not_found)
    // a child inherits: createTask({ parentId }) is the one path that may omit the id
    const parent = await k.createTask({ title: 'p', workspaceId: workspace.id }, WEB)
    expect((await k.createTask({ title: 'c', parentId: parent.id, workspaceId: undefined }, WEB)).workspaceId).toBe(workspace.id)
  })
  it('requestRun without a cwd records the task\'s workspace cwd; an explicit cwd still wins', async () => {
    const { k, log } = await freshKernelAndLog()
    const { workspace } = await k.ensureWorkspace({ cwd, branch: 'a', kind: WORKSPACE_KIND.checkout, onTrunk: true }, WEB)
    const t = await k.createTask({ title: 't', workspaceId: workspace.id }, WEB)
    const seq1 = await k.requestRun(t.id, {}, WEB)
    const seq2 = await k.requestRun(t.id, { cwd: '/elsewhere' }, WEB)
    const rows = await log.byTask(t.id)
    const cwdAt = (seq: number) => RunRequestedPayload.parse(rows.find(r => r.seq === seq)?.payload).cwd
    expect(cwdAt(seq1)).toBe(cwd)
    expect(cwdAt(seq2)).toBe('/elsewhere')
  })
  // The ORPHAN: a task naming a workspace the fold never saw. createTask cannot produce one (it
  // refuses an unknown id above), so it is reached the only way it is reachable in the wild — a
  // `task_created` already in the log whose workspace record is not, after a purge or a partial
  // restore. The cwd then resolves to null, and recording THAT would send the run to the project
  // directory as though nothing were wrong: the step would execute in the wrong checkout and the
  // operator would never learn that the workspace record is missing.
  it('requestRun refuses an orphaned task rather than silently running it somewhere else', async () => {
    const { k, log } = await freshKernelAndLog()
    const orphan: TaskNode = {
      id: 'orphan-1', parentId: null, workspaceId: 'workspace-the-fold-never-saw', type: 'generic',
      title: 'ghost task', spec: '', status: TASK_STATUS.draft, zone: [], budgetUSD: null,
      depth: 0, createdAt: '2026-09-14T00:00:00.000Z',
    }
    await log.append({ ...WEB, taskId: orphan.id, stepId: null, runToken: null, kind: EVENT_KIND.task_created, payload: { task: orphan } })
    expect(await codeOf(k.requestRun(orphan.id, {}, WEB))).toBe(KERNEL_ERROR_CODE.workspace_not_found)
    // and NOTHING was appended: a run_requested naming a fabricated cwd is the failure this refusal
    // exists to prevent, so the refusal must not leave one behind
    expect((await log.byTask(orphan.id)).some(e => e.kind === EVENT_KIND.run_requested)).toBe(false)
    // the override is the documented way out, and it still works — the task is not unrunnable, it
    // just cannot answer "where" on its own
    await k.requestRun(orphan.id, { cwd: '/elsewhere' }, WEB)
    const requested = (await log.byTask(orphan.id)).filter(e => e.kind === EVENT_KIND.run_requested)
    expect(requested.length).toBe(1)
    expect(RunRequestedPayload.parse(requested[0]?.payload).cwd).toBe('/elsewhere')
  })
})
