// E2E fixture server (run by playwright's webServer): real Postgres test db, seeded state,
// scripted copilot, kernel-backed newTask — everything else read-only-stubbed.
import { MockLanguageModelV4 } from 'ai/test'
import { AUTHOR_SOURCE, Door, EVENT_KIND, FailureClass, NO_CHAT, STEP_ID, TASK_STATUS, WORKSPACE_KIND } from '@orc/contracts'
import { TEST_WORKSPACE_ID, claimFixture, semanticNoteFixture, stepFixture } from '@orc/contracts/fixtures'
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

// The two origins this fixture speaks as: the operator seeding through the terminal, and the
// supervisor stamping what a running step produced.
const SEED = NO_CHAT(Door.cli)
const AGENT = NO_CHAT(Door.supervisor)

const db = await createTestDb()
const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
const kernel = new Kernel(storage.events)
// Every task names a workspace, so the fixture adopts one before it seeds anything — the same
// thing a real boot does for the checkout it runs in.
const { workspace } = await kernel.ensureWorkspace({ cwd: '/e2e', branch: 'main', kind: WORKSPACE_KIND.checkout, onTrunk: true }, SEED)
const seeded = await kernel.createTask({ workspaceId: workspace.id, title: 'hello world request', spec: 'write hello.txt' }, SEED)
await kernel.proposePlan(seeded.id, draftFixture(), SEED)
// approved, so the projection emits STEP nodes: without them the contract test can only ever
// see one node kind, and the step/artifact shapes go unchecked
await kernel.approvePlan(seeded.id, undefined, undefined, SEED)

// The approval-gate scenario, on its own task so the seeded request's journey stays untouched:
// a plan-step question is OPEN, so the pane offers the one-click approve. Answering it drives
// the reply action below, which reproduces the failure this fixture exists to prove is visible.
const GATE_RUN_TOKEN = 'e2e-gate-run'
const gated = await kernel.createTask({ workspaceId: workspace.id, title: 'gated plan request', spec: 'decompose something' }, SEED)
const gateEnvelope = { ...AGENT, taskId: gated.id, stepId: STEP_ID.plan, runToken: GATE_RUN_TOKEN }
await storage.events.append({
  ...gateEnvelope, kind: EVENT_KIND.feedback_requested,
  payload: { topic: 'plan-gate', question: 'approve this plan?' },
})

// The FINISH step's own question, on its own task. The kernel appends a finish step to every root
// plan and it asks once before the task completes, so this is the gate an operator meets most —
// and it reads the same approval word the plan gate does, which is why GateCard offers one-click
// approve for it too. Seeded SEPARATELY from the plan gate above because that affordance is keyed
// on the STEP ID: with only a plan gate in the fixture, "the button is on the plan step" and "the
// button is on every open question" are indistinguishable.
const FINISH_GATE_QUESTION = 'SUMMARY: 2 notes kept, 1 rewritten, no decision. Reply approve to finish.'
const finishing = await kernel.createTask({ workspaceId: workspace.id, title: 'finishing request', spec: 'work that is done and being summarised' }, SEED)
await storage.events.append({
  ...AGENT, taskId: finishing.id, stepId: STEP_ID.finish, runToken: 'e2e-finish-run', kind: EVENT_KIND.feedback_requested,
  payload: { topic: 'finish', question: FINISH_GATE_QUESTION },
})

// TWO open questions on ONE task, different topics, neither answered. operatorState's
// openQuestions is keyed by (taskId, topic) — task-only would collapse this pair into one entry,
// and a `{#each}` keyed on taskId alone would then render one gate card where the operator is
// actually owed two answers.
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

// A copilot exchange, then 450 tool_call events with no exchange among them. The copilot pane
// used to restore history from a fixed-size tail of the WHOLE project log (api.log's `limit`); a
// burst of agent-loop noise after the one exchange it needs to find pushed it out of that window
// entirely — reproduced here, not hypothesised. The view-registry fix filters by KIND before
// slicing (timeline.ts), so the exchange is found regardless of what runs after it.
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

// The log tab's pin-to-bottom is only observable when the inspector actually overflows — a
// handful of seeded lifecycle events all fit the 900px viewport, so "pinned" would be trivially
// true. Enough tool calls that the panel scrolls; tool_call adds no graph nodes and rides the
// conversation's one-line ticker, so no other scenario's assertions see them.
for (let i = 1; i <= 60; i++) {
  await storage.events.append({
    ...AGENT, taskId: seeded.id, stepId: STEP_ID.analyze, runToken: 'e2e-log-run', kind: EVENT_KIND.tool_call,
    payload: { stepId: STEP_ID.analyze, runToken: 'e2e-log-run', iteration: i, toolCallId: `log-${i}`, toolName: 'fs_read', input: { seq: i } },
  })
}

// A gate whose question is a whole plan. Tall on purpose: an unbounded gate block used to grow
// past the pane and paint over the copilot beneath it, and the layout test needs its own task so
// the answer-refusal scenario above cannot retire it first.
const tall = await kernel.createTask({ workspaceId: workspace.id, title: 'tall gate request', spec: 'a plan with many waves' }, SEED)
await storage.events.append({
  ...AGENT, taskId: tall.id, stepId: STEP_ID.plan, runToken: 'e2e-tall-run', kind: EVENT_KIND.feedback_requested,
  payload: {
    topic: 'plan-gate',
    question: ['plan ready — approve to start:', ...Array.from({ length: 40 }, (_, i) => `wave ${i + 1} — a subplan line long enough to make this question tall`)].join('\n'),
  },
})

// A plan with REAL topology: a diamond over three waves (analyze -> left ∥ right -> join). The
// single-step draftFixture cannot exercise the dependency graph's subflows at all — one wave, one
// node, no edges — so multi-wave rendering shipped unproven until this existed.
const shaped = await kernel.createTask({ workspaceId: workspace.id, title: 'shaped plan request', spec: 'a diamond plan' }, SEED)
await kernel.proposePlan(shaped.id, draftFixture([
  stepFixture({ id: 'analyze', title: 'analyze', dependsOn: [] }),
  stepFixture({ id: 'left', title: 'left', dependsOn: ['analyze'] }),
  stepFixture({ id: 'right', title: 'right', dependsOn: ['analyze'] }),
  stepFixture({ id: 'join', title: 'join', dependsOn: ['left', 'right'] }),
]), SEED)
await kernel.approvePlan(shaped.id, undefined, undefined, SEED)

// A task mid-run. The run monitor only exists while something executes, so without a seeded
// running step it would ship unexercised — and a panel that renders nothing is exactly the
// failure mode the wire-shape bugs took four rounds to surface. Iteration 4 of a ceiling of 5
// also puts the bar in its near-ceiling branch.
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

// A run an AUDITOR REJECTED. The pane must offer replan, never retry: retry re-runs only what did
// not complete, so the rejecting step would meet the same completed siblings and reach the same
// verdict. Seeded because nothing else in this fixture produces a `rejected` failure, and the
// affordance shipped once as a button that silently did nothing.
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

// A NOTE and an ARTIFACT, so the contract test can assert their detail shapes against a real
// server. Four wire-vs-server disagreements stayed invisible because the fixture had neither: the
// artifact record arrives bare and was read as if wrapped, and a note's claims, sources and
// nullable sourceRevision each cost the whole note when the schema was wrong about them.
await storage.events.append({
  ...SEED, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
  payload: {
    note: semanticNoteFixture({
      id: 'e2e-note', title: 'a fixture note',
      summary: 'what the console renders in the inspector',
      // the three fields whose absence hid a schema bug: a citation (not a bare string), a claim
      // carrying the revision it was recorded at, and a null sourceRevision
      sources: [{ url: 'https://example.invalid/spec', title: 'the spec', retrievedAt: '2026-09-18T00:00:00.000Z' }],
      // CLAIM_ID_RE: 12 hex characters, so a claim id is the same shape wherever it is quoted
      claims: [claimFixture('the console reads notes through the view registry', { id: 'a1b2c3d4e5f6', sourceRevision: null })],
      sourceRevision: null,
    }),
    author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin: SEED },
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
  // kernel-backed, not stubbed: `edit` is the documented repair path for a BLOCKED task
  // (kernel.editPlan stamps blocked -> awaiting_approval), and the console's reopen button is its
  // only caller. Stubbing it unsupported would let that button be tested without being exercised.
  // A template edit needs the strategy runner this fixture has no supervisor for; only the
  // console's reopen path (a concrete draft) is exercised here.
  edit: async (taskId, draft, origin) => {
    if ('template' in draft) throw new Error('template edit not available in e2e fixture')
    return { version: (await kernel.editPlan(taskId, draft.draft, origin)).version }
  },
  approve: async (taskId, opts, origin) => ({
    version: (await kernel.approvePlan(taskId, opts.version, opts.approvedBy ? { approvedBy: opts.approvedBy } : undefined, origin)).version,
  }),
  run: unsupported('run'),
  listModels: unsupported('listModels'),
  // The measured bug, scripted: the answer lands, and then finalize_plan rejects it. Before this
  // fix the pane rendered the receipt and nothing else, so eight approvals in a row read as the
  // system running in circles.
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
  writeNote: async (note, origin) => {
    await storage.events.append({ ...origin, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note, author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin } } })
    return { id: note.id, scope: 'project' }
  },
  deleteNote: async (id, scope, origin) => {
    await storage.events.append({ ...origin, taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id, scope: scope ?? 'project', author: { source: AUTHOR_SOURCE.cli, workspaceId: TEST_WORKSPACE_ID, origin } } })
    return { id }
  },
  // the lifecycle behind it needs the memory read model this fixture has no Surreal for, and a
  // fabricated receipt would let the copilot's decision tool be tested without being exercised
  recordDecision: unsupported('recordDecision'),
  renameProject: unsupported('renameProject'),
  newProject: unsupported('newProject'),
  // kernel-backed, not stubbed: it is a plain read of the log this fixture already folds, and the
  // seeded workspace is what a copilot answer about "which checkout" would have to name. The health
  // comes from the SAME pure derivation the CLI uses; what the fixture cannot honestly answer it
  // says it cannot — /e2e is no checkout (dirExists false, git unasked) and there is no memory read
  // model here, so the note count is UNKNOWN rather than a fabricated zero.
  listWorkspaces: async () => {
    const events = await storage.events.all()
    const state = fold(events)
    return [...state.workspaces.values()].map(w => ({
      workspace: w,
      health: workspaceHealth(state, events, null, w, { dirExists: false, clean: null }),
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
  health: async () => ({ memory: { state: 'ok' as const, pending: 0 }, supervisor: { state: 'none' as const } }),
  appendExchange: async x => appendCopilotExchange(storage.events, x, Door.web),
})
console.log(`e2e server on http://127.0.0.1:${E2E_PORT}`)
