import { describe, expect, it } from 'bun:test'
import {
  AUTHOR_SOURCE, ClaimClass, DeliveryMode, Door, EVENT_KIND, KNOWLEDGE_REFUSAL, KnowledgeToolName, STEP_ID, STEP_ROLE,
  type EventInput, type KnowledgeWrites, type MemoryAuthor,
} from '@orc/contracts'
import { createMemoryBackend } from './memory-backend'
import { createKnowledgePort } from './port'
import { bindStepKnowledge } from './step-knowledge'

const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, workspaceId: 'ws-1', origin: { chatId: 'c-1', door: Door.supervisor }, taskId: 't-1', stepId: 's-1', runToken: 'r-1' }
const worker = { stepId: 's1', role: STEP_ROLE.worker }
const planner = { stepId: STEP_ID.plan, role: STEP_ROLE.auditor }
const finisher = { stepId: STEP_ID.finish, role: STEP_ROLE.finisher }
const fact = (text: string, path: string) => ({ text, class: ClaimClass.fact, anchors: [{ path }] })
const setup = (writes: KnowledgeWrites = { live: [], retired: [], files: [] }, p: { stepId: string; role: string } = worker) => {
  const events: EventInput[] = []
  const port = createKnowledgePort({ backend: createMemoryBackend({ exists: () => true }), checkoutOf: async () => '/c', append: async e => { events.push(e) } })
  return { port, events, bound: bindStepKnowledge({ access: { port }, author, p, writesOf: async () => writes }) }
}

describe('bindStepKnowledge', () => {
  it('the exact tool set per step: decisions on the plan and finish steps, task_claims on the finish step only', () => {
    const names = (p: { stepId: string; role: string }) => new Set(setup(undefined, p).bound.tools.map(t => t.name))
    const base = [KnowledgeToolName.card, KnowledgeToolName.search, KnowledgeToolName.write]
    const decisions = [KnowledgeToolName.decisionList, KnowledgeToolName.decisionRead, KnowledgeToolName.recordDecision]
    expect(names(worker)).toEqual(new Set(base))
    expect(names(planner)).toEqual(new Set([...base, ...decisions]))
    expect(names(finisher)).toEqual(new Set([...base, KnowledgeToolName.taskClaims, ...decisions]))
    expect(names({ stepId: STEP_ID.plan, role: STEP_ROLE.worker })).toEqual(new Set(base))
    expect(names({ stepId: 'lead', role: STEP_ROLE.finisher })).toEqual(new Set(base))
  })
  it('with knowledge off, the plan and finish steps still list the decision tools and each answers unavailable', async () => {
    const decisions = new Set<string>([KnowledgeToolName.decisionList, KnowledgeToolName.decisionRead, KnowledgeToolName.recordDecision])
    for (const p of [planner, finisher]) {
      const off = bindStepKnowledge({ access: { unavailable: 'x' }, author, p, writesOf: async () => ({ live: [], retired: [], files: [] }) })
      expect(new Set(off.tools.map(t => t.name).filter(n => decisions.has(n)))).toEqual(decisions)
      const list = off.tools.find(t => t.name === KnowledgeToolName.decisionList)
      expect(await list?.execute({}, 'c')).toEqual({ output: { error: KNOWLEDGE_REFUSAL.unavailable('x') }, isError: true })
    }
  })
  it('claimsAt lists the claims anchored at edited paths once each, as a push delivery', async () => {
    const { port, events, bound } = setup()
    const { added } = await port.write({ author, idempotencyKey: null }, { add: [fact('a1', 'src/a.ts'), fact('b1', 'src/b.ts'), fact('c1', 'src/c.ts')] })
    const claims = await bound.knowledge.claimsAt(['./src/a.ts', 'src/b.ts', 'src/a.ts'])
    expect(claims.map(c => c.text)).toEqual(['a1', 'b1'])
    expect(events.filter(e => e.kind === EVENT_KIND.knowledge_delivered).map(e => e.payload)).toMatchObject([
      { ids: [added[0]?.id], mode: DeliveryMode.push, subject: 'src/a.ts' },
      { ids: [added[1]?.id], mode: DeliveryMode.push, subject: 'src/b.ts' },
    ])
  })
  it('claimsAt never throws into the step: a failing card warns and yields nothing', async () => {
    const warned: string[] = []
    const failing = {
      card: async () => { throw new Error('bucket broken') }, search: async () => [], get: async () => [], write: async () => { throw new Error('x') },
      decisions: async () => [], decision: async () => { throw new Error('x') }, recordDecision: async () => { throw new Error('x') },
    }
    const bound = bindStepKnowledge({ access: { port: failing }, author, p: worker, writesOf: async () => ({ live: [], retired: [], files: [] }), warn: l => warned.push(l) })
    expect(await bound.knowledge.claimsAt(['src/a.ts'])).toEqual([])
    expect(warned).toEqual(['claims at risk not read: bucket broken'])
  })
  it('citing is a card delivery; unavailable knowledge has no citing and no claims at risk', async () => {
    const { port, events, bound } = setup()
    await port.write({ author, idempotencyKey: null }, { add: [fact('a1', 'src/a.ts')] })
    expect((await bound.citing?.(['src/a.ts']))?.map(c => c.text)).toEqual(['a1'])
    expect(events.at(-1)).toMatchObject({ payload: { mode: DeliveryMode.card } })
    const off = bindStepKnowledge({ access: { unavailable: KNOWLEDGE_REFUSAL.off() }, author, p: worker, writesOf: async () => ({ live: [], retired: [], files: [] }) })
    expect(off.citing).toBeNull()
    expect(await off.knowledge.claimsAt(['src/a.ts'])).toEqual([])
  })
  it('task_claims is on the finish step only, and lists live claims, retired refs and ids no longer in the files', async () => {
    expect(setup().bound.tools.map(t => t.name)).not.toContain(KnowledgeToolName.taskClaims)
    const { port } = setup()
    const { added } = await port.write({ author, idempotencyKey: null }, { add: [fact('kept', 'src/a.ts')] })
    const kept = added[0]
    if (!kept) throw new Error('no claim')
    const writes = { live: [kept, { id: 'gonegone', location: 'k/x.md' }], retired: [{ id: 'oldoldol', location: 'k/y.md' }], files: [] }
    const bound = bindStepKnowledge({ access: { port }, author, p: finisher, writesOf: async () => writes })
    const tool = bound.tools.find(t => t.name === KnowledgeToolName.taskClaims)
    expect(await tool?.execute({}, 'call-1')).toMatchObject({
      isError: false,
      output: { claims: [{ id: kept.id, text: 'kept' }], retired: [{ id: 'oldoldol', location: 'k/y.md' }], missing: ['gonegone'] },
    })
  })
})
