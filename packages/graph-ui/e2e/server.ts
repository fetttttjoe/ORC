// E2E fixture server (run by playwright's webServer): real Postgres test db, seeded state,
// scripted copilot, kernel-backed newTask — everything else read-only-stubbed.
import { MockLanguageModelV4 } from 'ai/test'
import { EVENT_KIND, STEP_ID } from '@orc/contracts'
import { draftFixture } from '@orc/contracts/fixtures'
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
  edit: unsupported('edit'),
  approve: async taskId => ({ version: (await kernel.approvePlan(taskId)).version }),
  run: unsupported('run'),
  // The measured bug, scripted: the answer lands, and then finalize_plan rejects it. Before this
  // fix the pane rendered the receipt and nothing else, so eight approvals in a row read as the
  // system running in circles.
  reply: async (taskId, text) => {
    await storage.events.append({
      ...gateEnvelope, taskId, kind: EVENT_KIND.feedback_provided,
      payload: { topic: 'plan-gate', text, author: { source: 'cli' } },
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
    await storage.events.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written, payload: { note, author: { source: 'cli' } } })
    return { id: note.id, scope: 'project' }
  },
  deleteNote: async (id, scope) => {
    await storage.events.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id, scope: scope ?? 'project', author: { source: 'cli' } } })
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
  appendExchange: async x => {
    await storage.events.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.copilot_exchange, payload: x.payload, usage: x.usage })
  },
})
console.log(`e2e server on http://127.0.0.1:${E2E_PORT}`)
