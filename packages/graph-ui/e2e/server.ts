// E2E fixture server: real Postgres test db, seeded state, scripted copilot, kernel-backed newTask
import { MockLanguageModelV4 } from 'ai/test'
import { AUTHOR_SOURCE, Door, EVENT_KIND, FailureClass, KnowledgeHealthState, NO_CHAT, STEP_ID, SupervisorHealthState, TASK_STATUS, WORKSPACE_KIND } from '@orc/contracts'
import { TEST_WORKSPACE_ID, stepFixture } from '@orc/contracts/fixtures'
import { draftFixture } from '@orc/contracts/fixtures'

/** the one step draftFixture ships with — the monitor keys its ceiling off this id */
const LIVE_STEP_ID = stepFixture().id
import { Kernel, fold, openStorage, workspaceHealth } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import type { OrcActions } from '@orc/ui-core'
import { chatTitleOf, copilotChat } from '../src/copilot-chat'
import { appendCopilotExchange } from '../src/copilot-journal'
import { startGraphUi } from '../src/server'

export const E2E_PORT = 7911

const SEED = NO_CHAT(Door.cli)
const AGENT = NO_CHAT(Door.supervisor)

const db = await createTestDb()
const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
const kernel = new Kernel(storage.events)
const { workspace } = await kernel.ensureWorkspace({ cwd: '/e2e', branch: 'main', kind: WORKSPACE_KIND.checkout, onTrunk: true }, SEED)
const seeded = await kernel.createTask({ workspaceId: workspace.id, title: 'hello world request', spec: 'write hello.txt' }, SEED)
await kernel.proposePlan(seeded.id, draftFixture(), SEED)
await kernel.approvePlan(seeded.id, undefined, undefined, SEED)

const GATE_RUN_TOKEN = 'e2e-gate-run'
const gated = await kernel.createTask({ workspaceId: workspace.id, title: 'gated plan request', spec: 'decompose something' }, SEED)
const gateEnvelope = { ...AGENT, taskId: gated.id, stepId: STEP_ID.plan, runToken: GATE_RUN_TOKEN }
await storage.events.append({
  ...gateEnvelope, kind: EVENT_KIND.feedback_requested,
  payload: { topic: 'plan-gate', question: 'approve this plan?' },
})

const FINISH_GATE_QUESTION = 'SUMMARY: 2 notes kept, 1 rewritten, no decision. Reply approve to finish.'
const finishing = await kernel.createTask({ workspaceId: workspace.id, title: 'finishing request', spec: 'work that is done and being summarised' }, SEED)
await storage.events.append({
  ...AGENT, taskId: finishing.id, stepId: STEP_ID.finish, runToken: 'e2e-finish-run', kind: EVENT_KIND.feedback_requested,
  payload: { topic: 'finish', question: FINISH_GATE_QUESTION },
})

const MULTI_Q_TOPIC_A = 'grounding-model'
const MULTI_Q_TOPIC_B = 'grounding-cwd'
const MULTI_Q_QUESTION_A = 'which model should analyze this?'
const MULTI_Q_QUESTION_B = 'which checkout should this run in?'
const multiQuestion = await kernel.createTask({ workspaceId: workspace.id, title: 'multi-question request', spec: 'needs two answers before it can start' }, SEED)
await storage.events.append({
  ...AGENT, taskId: multiQuestion.id, stepId: null, runToken: 'e2e-multi-q-run', kind: EVENT_KIND.feedback_requested,
  payload: { topic: MULTI_Q_TOPIC_A, question: MULTI_Q_QUESTION_A },
})
await storage.events.append({
  ...AGENT, taskId: multiQuestion.id, stepId: null, runToken: 'e2e-multi-q-run', kind: EVENT_KIND.feedback_requested,
  payload: { topic: MULTI_Q_TOPIC_B, question: MULTI_Q_QUESTION_B },
})

const BURIED_EXCHANGE_USER = 'what happened while I was away?'
const BURIED_EXCHANGE_ASSISTANT = 'a step failed and was retried; the retry is running now'
const buried = copilotChat({ chatId: null, taskId: null, workspaceId: null, title: chatTitleOf(BURIED_EXCHANGE_USER) }, () => 'e2e-buried-chat')
await appendCopilotExchange(storage.events, {
  chatId: buried.chatId, opened: buried.opened, usage: null,
  payload: { user: BURIED_EXCHANGE_USER, assistant: BURIED_EXCHANGE_ASSISTANT, toolCalls: [], modelRef: 'mock/e2e', taskId: null, workspaceId: null },
}, Door.web)
for (let i = 1; i <= 450; i++) {
  await storage.events.append({
    ...AGENT, taskId: seeded.id, stepId: STEP_ID.analyze, runToken: 'e2e-noise-run', kind: EVENT_KIND.tool_call,
    payload: { stepId: STEP_ID.analyze, runToken: 'e2e-noise-run', iteration: i, toolCallId: `noise-${i}`, toolName: 'noise_tool', input: { i } },
  })
}

// Enough tool calls that the inspector overflows, or pinned-to-bottom is trivially true
for (let i = 1; i <= 60; i++) {
  await storage.events.append({
    ...AGENT, taskId: seeded.id, stepId: STEP_ID.analyze, runToken: 'e2e-log-run', kind: EVENT_KIND.tool_call,
    payload: { stepId: STEP_ID.analyze, runToken: 'e2e-log-run', iteration: i, toolCallId: `log-${i}`, toolName: 'fs_read', input: { seq: i } },
  })
}

const tall = await kernel.createTask({ workspaceId: workspace.id, title: 'tall gate request', spec: 'a plan with many waves' }, SEED)
await storage.events.append({
  ...AGENT, taskId: tall.id, stepId: STEP_ID.plan, runToken: 'e2e-tall-run', kind: EVENT_KIND.feedback_requested,
  payload: {
    topic: 'plan-gate',
    question: ['plan ready — approve to start:', ...Array.from({ length: 40 }, (_, i) => `wave ${i + 1} — a subplan line long enough to make this question tall`)].join('\n'),
  },
})

const shaped = await kernel.createTask({ workspaceId: workspace.id, title: 'shaped plan request', spec: 'a diamond plan' }, SEED)
await kernel.proposePlan(shaped.id, draftFixture([
  stepFixture({ id: 'analyze', title: 'analyze', dependsOn: [] }),
  stepFixture({ id: 'left', title: 'left', dependsOn: ['analyze'] }),
  stepFixture({ id: 'right', title: 'right', dependsOn: ['analyze'] }),
  stepFixture({ id: 'join', title: 'join', dependsOn: ['left', 'right'] }),
]), SEED)
await kernel.approvePlan(shaped.id, undefined, undefined, SEED)

const LIVE_RUN_TOKEN = 'e2e-live-run'
const live = await kernel.createTask({ workspaceId: workspace.id, title: 'live run request', spec: 'work that is still going' }, SEED)
await kernel.proposePlan(live.id, draftFixture(), SEED)
await kernel.approvePlan(live.id, undefined, undefined, SEED)
await storage.events.append({
  ...AGENT, taskId: live.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
  payload: { taskId: live.id, from: TASK_STATUS.approved, to: TASK_STATUS.running },
})
const liveEnvelope = { ...AGENT, taskId: live.id, stepId: LIVE_STEP_ID, runToken: LIVE_RUN_TOKEN }
await storage.events.append({
  ...liveEnvelope, kind: EVENT_KIND.step_started,
  payload: { stepId: LIVE_STEP_ID, runToken: LIVE_RUN_TOKEN, attempt: 1 },
})
await storage.events.append({
  ...liveEnvelope, kind: EVENT_KIND.agent_call,
  payload: { stepId: LIVE_STEP_ID, runToken: LIVE_RUN_TOKEN, iteration: 4, request: {}, response: {} },
})

const REJECT_RUN_TOKEN = 'e2e-reject-run'
const REJECT_STEP_ID = stepFixture().id
const rejected = await kernel.createTask({ workspaceId: workspace.id, title: 'rejected plan request', spec: 'work an auditor judged unacceptable' }, SEED)
await kernel.proposePlan(rejected.id, draftFixture(), SEED)
await kernel.approvePlan(rejected.id, undefined, undefined, SEED)
const rejectEnvelope = { ...AGENT, taskId: rejected.id, stepId: REJECT_STEP_ID, runToken: REJECT_RUN_TOKEN }
await storage.events.append({
  ...rejectEnvelope, kind: EVENT_KIND.step_started,
  payload: { stepId: REJECT_STEP_ID, runToken: REJECT_RUN_TOKEN, attempt: 1 },
})
await storage.events.append({
  ...rejectEnvelope, kind: EVENT_KIND.step_failed,
  payload: { stepId: REJECT_STEP_ID, runToken: REJECT_RUN_TOKEN, class: FailureClass.rejected, message: 'three placement defects; content sound' },
})
await storage.events.append({
  ...AGENT, taskId: rejected.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
  payload: { taskId: rejected.id, from: TASK_STATUS.approved, to: TASK_STATUS.blocked },
})

// the artifact pins its detail shape; the identity and knowledge events draw no node
await storage.events.append({ ...SEED, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.project_identified, payload: { name: 'e2e-project', dir: '/e2e' } })
await storage.events.append({
  ...SEED, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.knowledge_written,
  payload: {
    added: [{ id: 'e2eclaim', location: 'knowledge/README.md' }], changed: [], retired: [], files: ['knowledge/README.md'],
    why: 'the console reads knowledge from files', decision: null, decisionsRecorded: [], decisionsSuperseded: [], asserted: [],
    author: { source: AUTHOR_SOURCE.cli, workspaceId: workspace.id, origin: SEED },
  },
})
await storage.events.append({
  ...AGENT, taskId: seeded.id, stepId: STEP_ID.analyze, runToken: 'e2e-artifact-run', kind: EVENT_KIND.artifact_produced,
  payload: { path: 'hello.txt', size: 12, sha256: 'a'.repeat(64) },
})

const copilotModel = new MockLanguageModelV4({
  doStream: async () => ({
    stream: new ReadableStream({
      start(c) {
        c.enqueue({ type: 'stream-start', warnings: [] })
        c.enqueue({ type: 'text-start', id: '1' })
        c.enqueue({ type: 'text-delta', id: '1', delta: 'e2e copilot reply' })
        c.enqueue({ type: 'text-end', id: '1' })
        c.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 3, text: undefined, reasoning: undefined },
          },
        })
        c.close()
      },
    }),
  }),
})

const unsupported = (name: string) => async (): Promise<never> => { throw new Error(`${name} not available in e2e fixture`) }
const actions: OrcActions = {
  newTask: async (input, origin) => ({ taskId: (await kernel.createTask({ workspaceId: workspace.id, title: input.title, spec: input.spec ?? '' }, origin)).id }),
  propose: unsupported('propose'),
  // kernel-backed so the reopen button is exercised; template edits need a supervisor
  edit: async (taskId, draft, origin) => {
    if ('template' in draft) throw new Error('template edit not available in e2e fixture')
    return { version: (await kernel.editPlan(taskId, draft.draft, origin)).version }
  },
  approve: async (taskId, opts, origin) => ({
    version: (await kernel.approvePlan(taskId, opts.version, opts.approvedBy ? { approvedBy: opts.approvedBy } : undefined, origin)).version,
  }),
  run: unsupported('run'),
  listModels: unsupported('listModels'),
  reply: async (taskId, text, _projectId, origin) => {
    await storage.events.append({
      ...gateEnvelope, ...origin, taskId, kind: EVENT_KIND.feedback_provided,
      payload: { topic: 'plan-gate', text, author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin } },
    })
    await storage.events.append({
      ...gateEnvelope, ...origin, taskId, kind: EVENT_KIND.tool_result,
      payload: {
        stepId: STEP_ID.plan, runToken: GATE_RUN_TOKEN, iteration: 1, toolCallId: 'e2e-call-1',
        toolName: 'finalize_plan', isError: true,
        output: 'not approved: the plan graph changed since the approval',
      },
    })
    return { answered: true, supervised: true }
  },
  retry: unsupported('retry'),
  cancel: unsupported('cancel'),
  annotate: unsupported('annotate'),
  revise: unsupported('revise'),
  recordDecision: unsupported('recordDecision'),
  listDecisions: unsupported('listDecisions'),
  readDecision: unsupported('readDecision'),
  renameProject: unsupported('renameProject'),
  newProject: unsupported('newProject'),
  // the CLI's own pure derivation; /e2e is no checkout, so dirExists is false and git is unasked
  listWorkspaces: async () => {
    const events = await storage.events.all()
    const state = fold(events)
    return [...state.workspaces.values()].map(w => ({
      workspace: w,
      health: workspaceHealth(state, events, w, { dirExists: false, clean: null }),
    }))
  },
  // git-backed (a worktree + branch per request) — out of reach of a fixture that owns no checkout
  newWorkspace: unsupported('newWorkspace'),
  purgeProject: unsupported('purgeProject'),
  deleteProject: unsupported('deleteProject'),
}

startGraphUi({
  url: db.url,
  port: E2E_PORT,
  cwdProject: { id: TEST_PROJECT_ID, name: 'e2e-project' },
  actions,
  copilot: { resolveModel: () => copilotModel, defaultModelRef: 'mock/e2e', price: () => 0.0001 },
  defaultCwd: '/tmp',
  // no supervisor runs behind the fixture, and the console must SAY that rather than look idle
  health: async () => ({ knowledge: { state: KnowledgeHealthState.ok, claims: 1, suspect: 0 }, supervisor: { state: SupervisorHealthState.none } }),
  appendExchange: async x => appendCopilotExchange(storage.events, x, Door.web),
})
console.log(`e2e server on http://127.0.0.1:${E2E_PORT}`)
