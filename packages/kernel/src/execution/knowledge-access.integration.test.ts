import { afterAll, describe, expect, it } from 'bun:test'
import {
  ClaimClass, DeliveryMode, Door, EVENT_KIND, KnowledgeDeliveredPayload, KnowledgeToolName, KnowledgeWrittenPayload, NO_CHAT, PAYLOAD_SCHEMAS, RunOutcome,
  type EventRecord, type Origin,
} from '@orc/contracts'
import { draftFixture, must, stepFixture } from '@orc/contracts/fixtures'
import { apiLoopExecutor } from '@orc/executor-api-loop'
import { scriptModel } from '@orc/executor-api-loop/test-model'
import { openStorage } from '../storage'
import { Kernel } from '../kernel'
import { createTestDb, fakeSkills, seedTestWorkspace, TEST_PROJECT_ID, TEST_WORKSPACE_ID, testConfig } from '../test-helpers'
import { createDbosPort } from './dbos-port'
import { memoryKnowledge } from './knowledge-fixture'

const CLI: Origin = NO_CHAT(Door.cli)
const CLAIM_TEXT = 'The retry budget doubles after every failed attempt'
const CLAIM_PATH = 'src/retry.ts'
const SEARCH_HIT = 'retry budget'
const SEARCH_MISS = 'zzzunmatched'
const STEP_A = 'a'
const STEP_B = 'b'

const deliveriesOf = (events: EventRecord[], stepId: string, mode: DeliveryMode): EventRecord[] =>
  events.filter(e => e.kind === EVENT_KIND.knowledge_delivered && e.stepId === stepId && KnowledgeDeliveredPayload.parse(e.payload).mode === mode)

describe('agent-side knowledge access over a durable run (integration)', () => {
  const cleanup: (() => Promise<void> | void)[] = []
  afterAll(async () => { for (const c of cleanup.reverse()) await c() })

  it('a later step is handed the earlier step claim, and each of its pulls is recorded once under its own step', async () => {
    const pg = await createTestDb(); cleanup.push(pg.drop)
    const storage = await openStorage(pg.url, { projectId: TEST_PROJECT_ID })
    const log = storage.events
    cleanup.push(() => log.close())
    const kernel = new Kernel(log)
    await seedTestWorkspace(log, CLI)
    const config = testConfig(pg.url)

    const model = scriptModel([
      { toolCalls: [{ toolCallId: 'a1', toolName: KnowledgeToolName.write, input: { add: [{ text: CLAIM_TEXT, class: ClaimClass.fact, anchors: [{ path: CLAIM_PATH }] }], why: 'recorded while working' } }] },
      { toolCalls: [{ toolCallId: 'a2', toolName: 'signal', input: { outcome: 'success', summary: 'wrote the claim' } }] },
      { toolCalls: [{ toolCallId: 'b1', toolName: KnowledgeToolName.card, input: { path: CLAIM_PATH } }] },
      { toolCalls: [{ toolCallId: 'b2', toolName: KnowledgeToolName.search, input: { query: SEARCH_HIT } }] },
      { toolCalls: [{ toolCallId: 'b3', toolName: KnowledgeToolName.search, input: { query: SEARCH_MISS } }] },
      { toolCalls: [{ toolCallId: 'b4', toolName: 'signal', input: { outcome: 'success', summary: 'pulled the claim' } }] },
      { toolCalls: [{ toolCallId: 'f1', toolName: 'signal', input: { outcome: 'success', summary: 'nothing to reconcile' } }] },
    ])
    const knowledge = memoryKnowledge(log, kernel)
    const port = await createDbosPort({
      storage, config, skills: fakeSkills,
      providers: new Map([['fake', { costs: {}, languageModel: () => model }]]),
      executors: new Map([['api-loop', apiLoopExecutor()]]),
      stepTools: p => knowledge.stepTools(p),
    })
    await port.launch()
    cleanup.push(() => port.shutdown())

    const t = await kernel.createTask({ workspaceId: TEST_WORKSPACE_ID, title: 'use knowledge', spec: 'write a claim, then pull it' }, CLI)
    await kernel.proposePlan(t.id, draftFixture([
      stepFixture({ id: STEP_A, modelRef: 'fake/m', maxIterations: 10 }),
      stepFixture({ id: STEP_B, modelRef: 'fake/m', maxIterations: 10, dependsOn: [STEP_A] }),
    ]), CLI)
    await kernel.approvePlan(t.id, undefined, undefined, CLI)
    expect(await (await port.startRun(t.id)).wait()).toBe(RunOutcome.done)

    const events = await log.all()
    expect(events.filter(e => e.kind === EVENT_KIND.knowledge_written).map(e => e.stepId)).toEqual([STEP_A])

    const firstPromptOfB = must(events.find(e => e.kind === EVENT_KIND.agent_call && e.stepId === STEP_B), 'step b first agent call')
    expect(JSON.stringify(PAYLOAD_SCHEMAS.agent_call.parse(firstPromptOfB.payload).request)).toContain(CLAIM_TEXT)

    const bTurn = must(events.find(e => e.kind === EVENT_KIND.tool_call && e.stepId === STEP_B), 'step b tool call')
    for (const mode of [DeliveryMode.card, DeliveryMode.search]) {
      const delivered = deliveriesOf(events, STEP_B, mode)
      expect(delivered).toHaveLength(1)
      const record = must(delivered[0], 'delivery')
      const { author } = KnowledgeDeliveredPayload.parse(record.payload)
      expect(author.stepId).toBe(STEP_B)
      expect(author.runToken).toBe(bTurn.runToken)
      expect(author.origin).toEqual({ chatId: bTurn.chatId, door: Door.supervisor })
      expect(record.stepId).toBe(STEP_B)
      expect(record.runToken).toBe(bTurn.runToken)
    }
    const written = KnowledgeWrittenPayload.parse(must(events.find(e => e.kind === EVENT_KIND.knowledge_written), 'a write').payload)
    const searched = must(deliveriesOf(events, STEP_B, DeliveryMode.search)[0], 'search delivery')
    expect(KnowledgeDeliveredPayload.parse(searched.payload).ids).toEqual(written.added.map(ref => ref.id))
    expect(deliveriesOf(events, STEP_A, DeliveryMode.card)).toHaveLength(0)
    expect(deliveriesOf(events, STEP_A, DeliveryMode.search)).toHaveLength(0)
  }, 120_000)
})
