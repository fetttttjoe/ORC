// E2E fixture server (run by playwright's webServer): real Postgres test db, seeded state,
// scripted copilot, kernel-backed newTask — everything else read-only-stubbed.
import { MockLanguageModelV4 } from 'ai/test'
import { AUTHOR_SOURCE, EVENT_KIND, FAILURE_CLASS, STEP_ID, TASK_STATUS } from '@orc/contracts'
import { stepFixture } from '@orc/contracts/fixtures'
import { draftFixture } from '@orc/contracts/fixtures'

/** the one step draftFixture ships with — the monitor keys its ceiling off this id */
const LIVE_STEP_ID = stepFixture().id
import { Kernel, openStorage } from '@orc/kernel'
import { createTestDb, TEST_PROJECT_ID } from '@orc/kernel/test-helpers'
import type { OrcActions } from '@orc/ui-core'
import { startGraphUi } from '../src/server'

export const E2E_PORT = 7911

const db = await createTestDb()
const storage = await openStorage(db.url, { projectId: TEST_PROJECT_ID })
const kernel = new Kernel(storage.events)
const seeded = await kernel.createTask({ title: 'hello world request', spec: 'write hello.txt' })
await kernel.proposePlan(seeded.id, draftFixture())
// approved, so the projection emits STEP nodes: without them the contract test can only ever
// see one node kind, and the step/artifact shapes go unchecked
await kernel.approvePlan(seeded.id)

// The approval-gate scenario, on its own task so the seeded request's journey stays untouched:
// a plan-step question is OPEN, so the pane offers the one-click approve. Answering it drives
// the reply action below, which reproduces the failure this fixture exists to prove is visible.
const GATE_RUN_TOKEN = 'e2e-gate-run'
const gated = await kernel.createTask({ title: 'gated plan request', spec: 'decompose something' })
const gateEnvelope = { taskId: gated.id, stepId: STEP_ID.plan, runToken: GATE_RUN_TOKEN }
await storage.events.append({
  ...gateEnvelope, kind: EVENT_KIND.feedback_requested,
  payload: { topic: 'plan-gate', question: 'approve this plan?' },
})

// The log tab's pin-to-bottom is only observable when the inspector actually overflows — a
// handful of seeded lifecycle events all fit the 900px viewport, so "pinned" would be trivially
// true. Enough tool calls that the panel scrolls; tool_call adds no graph nodes and rides the
// conversation's one-line ticker, so no other scenario's assertions see them.
for (let i = 1; i <= 60; i++) {
  await storage.events.append({
    taskId: seeded.id, stepId: STEP_ID.analyze, runToken: 'e2e-log-run', kind: EVENT_KIND.tool_call,
    payload: { stepId: STEP_ID.analyze, runToken: 'e2e-log-run', iteration: i, toolCallId: `log-${i}`, toolName: 'fs_read', input: { seq: i } },
  })
}

// A gate whose question is a whole plan. Tall on purpose: an unbounded gate block used to grow
// past the pane and paint over the copilot beneath it, and the layout test needs its own task so
// the answer-refusal scenario above cannot retire it first.
const tall = await kernel.createTask({ title: 'tall gate request', spec: 'a plan with many waves' })
await storage.events.append({
  taskId: tall.id, stepId: STEP_ID.plan, runToken: 'e2e-tall-run', kind: EVENT_KIND.feedback_requested,
  payload: {
    topic: 'plan-gate',
    question: ['plan ready — approve to start:', ...Array.from({ length: 40 }, (_, i) => `wave ${i + 1} — a subplan line long enough to make this question tall`)].join('\n'),
  },
})

// A plan with REAL topology: a diamond over three waves (analyze -> left ∥ right -> join). The
// single-step draftFixture cannot exercise the dependency graph's subflows at all — one wave, one
// node, no edges — so multi-wave rendering shipped unproven until this existed.
const shaped = await kernel.createTask({ title: 'shaped plan request', spec: 'a diamond plan' })
await kernel.proposePlan(shaped.id, draftFixture([
  stepFixture({ id: 'analyze', title: 'analyze', dependsOn: [] }),
  stepFixture({ id: 'left', title: 'left', dependsOn: ['analyze'] }),
  stepFixture({ id: 'right', title: 'right', dependsOn: ['analyze'] }),
  stepFixture({ id: 'join', title: 'join', dependsOn: ['left', 'right'] }),
]))
await kernel.approvePlan(shaped.id)

// A task mid-run. The run monitor only exists while something executes, so without a seeded
// running step it would ship unexercised — and a panel that renders nothing is exactly the
// failure mode the wire-shape bugs took four rounds to surface. Iteration 4 of a ceiling of 5
// also puts the bar in its near-ceiling branch.
const LIVE_RUN_TOKEN = 'e2e-live-run'
const live = await kernel.createTask({ title: 'live run request', spec: 'work that is still going' })
await kernel.proposePlan(live.id, draftFixture())
await kernel.approvePlan(live.id)
await storage.events.append({
  taskId: live.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
  payload: { taskId: live.id, from: TASK_STATUS.approved, to: TASK_STATUS.running },
})
const liveEnvelope = { taskId: live.id, stepId: LIVE_STEP_ID, runToken: LIVE_RUN_TOKEN }
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
const rejected = await kernel.createTask({ title: 'rejected plan request', spec: 'work an auditor judged unacceptable' })
await kernel.proposePlan(rejected.id, draftFixture())
await kernel.approvePlan(rejected.id)
const rejectEnvelope = { taskId: rejected.id, stepId: REJECT_STEP_ID, runToken: REJECT_RUN_TOKEN }
await storage.events.append({
  ...rejectEnvelope, kind: EVENT_KIND.step_started,
  payload: { stepId: REJECT_STEP_ID, runToken: REJECT_RUN_TOKEN, attempt: 1 },
})
await storage.events.append({
  ...rejectEnvelope, kind: EVENT_KIND.step_failed,
  payload: { stepId: REJECT_STEP_ID, runToken: REJECT_RUN_TOKEN, class: FAILURE_CLASS.rejected, message: 'three placement defects; content sound' },
})
await storage.events.append({
  taskId: rejected.id, stepId: null, runToken: null, kind: EVENT_KIND.task_status_changed,
  payload: { taskId: rejected.id, from: TASK_STATUS.approved, to: TASK_STATUS.blocked },
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
  newTask: async input => ({ taskId: (await kernel.createTask({ title: input.title, spec: input.spec ?? '' })).id }),
  propose: unsupported('propose'),
  // kernel-backed, not stubbed: `edit` is the documented repair path for a BLOCKED task
  // (kernel.editPlan stamps blocked -> awaiting_approval), and the console's reopen button is its
  // only caller. Stubbing it unsupported would let that button be tested without being exercised.
  edit: async (taskId, draft) => ({ version: (await kernel.editPlan(taskId, draft)).version }),
  approve: async taskId => ({ version: (await kernel.approvePlan(taskId)).version }),
  run: unsupported('run'),
  // The measured bug, scripted: the answer lands, and then finalize_plan rejects it. Before this
  // fix the pane rendered the receipt and nothing else, so eight approvals in a row read as the
  // system running in circles.
  reply: async (taskId, text) => {
    await storage.events.append({
      ...gateEnvelope, taskId, kind: EVENT_KIND.feedback_provided,
      payload: { topic: 'plan-gate', text, author: { source: AUTHOR_SOURCE.cli } },
    })
    await storage.events.append({
      ...gateEnvelope, taskId, kind: EVENT_KIND.tool_result,
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
  writeNote: async note => {
    await storage.events.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note, author: { source: AUTHOR_SOURCE.cli } } })
    return { id: note.id, scope: 'project' }
  },
  deleteNote: async (id, scope) => {
    await storage.events.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id, scope: scope ?? 'project', author: { source: AUTHOR_SOURCE.cli } } })
    return { id }
  },
  renameProject: unsupported('renameProject'),
  newProject: unsupported('newProject'),
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
  appendExchange: async x => {
    await storage.events.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.copilot_exchange, payload: x.payload, usage: x.usage })
  },
})
console.log(`e2e server on http://127.0.0.1:${E2E_PORT}`)
