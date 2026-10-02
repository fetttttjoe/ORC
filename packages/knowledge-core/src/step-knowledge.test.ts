import { describe, expect, it } from 'bun:test'
import {
  AUTHOR_SOURCE, ClaimClass, DeliveryMode, Door, EVENT_KIND, KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, KnowledgeToolName, NO_KNOWLEDGE_WRITES, PreloadArm, STEP_ID, STEP_ROLE,
  KnowledgeDeliveredPayload, knowledgeIdFrom, type EventInput, type KnowledgePort, type KnowledgeWrites, type MemoryAuthor, type PreloadRequest,
} from '@orc/contracts'
import { createMemoryBackend, NO_STRUCTURE } from './memory-backend'
import { createKnowledgePort } from './port'
import { bindStepKnowledge, PRELOAD_NOT_READ, preloadKey } from './step-knowledge'

const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, workspaceId: 'ws-1', origin: { chatId: 'c-1', door: Door.supervisor }, taskId: 't-1', stepId: 's-1', runToken: 'r-1' }
type Params = Parameters<typeof bindStepKnowledge>[0]['p']
const params = (over: Partial<Params> & { stepId: string; role: string }): Params =>
  ({ taskId: 't-1', ancestorTaskIds: [], step: { title: 'A step', instructions: 'do it' }, ...over })
const worker = params({ stepId: 's1', role: STEP_ROLE.worker })
const planner = params({ stepId: STEP_ID.plan, role: STEP_ROLE.auditor })
const finisher = params({ stepId: STEP_ID.finish, role: STEP_ROLE.finisher })
const verifier = params({ stepId: STEP_ID.verify, role: STEP_ROLE.auditor })
const fact = (text: string, path: string) => ({ text, class: ClaimClass.fact, anchors: [{ path }] })
const memoryPort = (events: EventInput[] = []) =>
  createKnowledgePort({ backend: createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null }), checkoutOf: async () => '/c', append: async e => { events.push(e) } })
const setup = (writes: KnowledgeWrites = NO_KNOWLEDGE_WRITES, p: Params = worker) => {
  const events: EventInput[] = []
  const port = memoryPort(events)
  return { port, events, bound: bindStepKnowledge({ access: { port }, author, p, writesOf: async () => writes }) }
}
const failingPort: KnowledgePort = {
  card: async () => { throw new Error('bucket broken') }, search: async () => [], get: async () => [], write: async () => { throw new Error('x') },
  decisions: async () => [], decision: async () => { throw new Error('x') }, recordDecision: async () => { throw new Error('x') },
  drift: async () => [], check: async () => { throw new Error('x') }, preload: async () => { throw new Error('bucket broken') },
}

describe('bindStepKnowledge', () => {
  it('the exact tool set per step: decisions on the plan and finish steps, task_claims on the finish step only, knowledge_check on audits', () => {
    const names = (p: { stepId: string; role: string }) => new Set(setup(undefined, params(p)).bound.tools.map(t => t.name))
    const base = [KnowledgeToolName.card, KnowledgeToolName.search, KnowledgeToolName.write]
    const decisions = [KnowledgeToolName.decisionList, KnowledgeToolName.decisionRead, KnowledgeToolName.recordDecision]
    expect(names(worker)).toEqual(new Set(base))
    expect(names(verifier)).toEqual(new Set([...base, KnowledgeToolName.check]))
    expect(names({ stepId: 'sweep', role: STEP_ROLE.auditor })).toEqual(new Set([...base, KnowledgeToolName.check]))
    expect(names(planner)).toEqual(new Set([...base, ...decisions]))
    expect(names(finisher)).toEqual(new Set([...base, KnowledgeToolName.taskClaims, ...decisions]))
    expect(names({ stepId: STEP_ID.plan, role: STEP_ROLE.worker })).toEqual(new Set(base))
    expect(names({ stepId: STEP_ID.verify, role: STEP_ROLE.worker })).toEqual(new Set(base))
    expect(names({ stepId: 'lead', role: STEP_ROLE.finisher })).toEqual(new Set(base))
  })
  it('with knowledge off, the plan and finish steps still list the decision tools and each answers unavailable', async () => {
    const decisions = new Set<string>([KnowledgeToolName.decisionList, KnowledgeToolName.decisionRead, KnowledgeToolName.recordDecision])
    for (const p of [planner, finisher]) {
      const off = bindStepKnowledge({ access: { unavailable: 'x' }, author, p, writesOf: async () => NO_KNOWLEDGE_WRITES })
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
    const bound = bindStepKnowledge({ access: { port: failingPort }, author, p: worker, writesOf: async () => NO_KNOWLEDGE_WRITES, warn: l => warned.push(l) })
    expect(await bound.knowledge.claimsAt(['src/a.ts'])).toEqual([])
    expect(warned).toEqual(['claims at risk not read: bucket broken'])
  })
  it('citing is a card delivery; unavailable knowledge has no citing and no claims at risk', async () => {
    const { port, events, bound } = setup()
    await port.write({ author, idempotencyKey: null }, { add: [fact('a1', 'src/a.ts')] })
    expect((await bound.citing?.(['src/a.ts']))?.map(c => c.text)).toEqual(['a1'])
    expect(events.at(-1)).toMatchObject({ payload: { mode: DeliveryMode.card } })
    const off = bindStepKnowledge({ access: { unavailable: KNOWLEDGE_REFUSAL.off() }, author, p: worker, writesOf: async () => NO_KNOWLEDGE_WRITES })
    expect(off.citing).toBeNull()
    expect(await off.knowledge.claimsAt(['src/a.ts'])).toEqual([])
    expect(await off.knowledge.preload(1_200, 0)).toEqual([])
  })
  it('task_claims is on the finish step only, and lists live claims, retired refs and ids no longer in the files', async () => {
    expect(setup().bound.tools.map(t => t.name)).not.toContain(KnowledgeToolName.taskClaims)
    const { port } = setup()
    const { added } = await port.write({ author, idempotencyKey: null }, { add: [fact('kept', 'src/a.ts')] })
    const kept = added[0]
    if (!kept) throw new Error('no claim')
    const writes = { live: [kept, { id: 'gonegone', location: 'k/x.md' }], retired: [{ id: 'oldoldol', location: 'k/y.md' }], files: [] }
    const asked: string[] = []
    const bound = bindStepKnowledge({ access: { port }, author, p: params({ ...finisher, ancestorTaskIds: ['root'] }), writesOf: async id => { asked.push(id); return writes } })
    const tool = bound.tools.find(t => t.name === KnowledgeToolName.taskClaims)
    expect(await tool?.execute({}, 'call-1')).toMatchObject({
      isError: false,
      output: { claims: [{ id: kept.id, text: 'kept' }], retired: [{ id: 'oldoldol', location: 'k/y.md' }], missing: ['gonegone'] },
    })
    expect(asked).toEqual(['t-1'])
  })
})

describe('the step preload', () => {
  const asking = () => {
    const seen: PreloadRequest[] = []
    const keys: (string | null)[] = []
    const port: KnowledgePort = { ...memoryPort(), preload: async (call, request) => { keys.push(call.idempotencyKey); seen.push(request); return [] } }
    return { port, seen, keys }
  }

  it('each round of a step records its own delivery, under its own key', async () => {
    const held = new Map<string, string>()
    const delivered: EventInput[] = []
    const port = createKnowledgePort({
      backend: createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null }), checkoutOf: async () => '/c', warn: () => {},
      append: async e => {
        const key = e.idempotencyKey ?? null
        const payload = JSON.stringify(e.payload)
        const prior = key === null ? undefined : held.get(key)
        if (prior !== undefined && prior !== payload) throw new Error(`idempotency conflict on ${key}`)
        if (prior !== undefined) return
        if (key !== null) held.set(key, payload)
        if (e.kind === EVENT_KIND.knowledge_delivered) delivered.push(e)
      },
    })
    const step = { title: 'Fix it', instructions: 'Change src/a.ts.' }
    const bound = bindStepKnowledge({ access: { port }, author, p: params({ stepId: 's1', role: STEP_ROLE.worker, step }), writesOf: async () => NO_KNOWLEDGE_WRITES })
    await port.write({ author, idempotencyKey: null }, { add: [fact('first', 'src/a.ts')] })
    await bound.knowledge.preload(1_200, 0)
    await port.write({ author, idempotencyKey: null }, { add: [fact('written in round 0', 'src/a.ts')] })
    await bound.knowledge.preload(1_200, 1)
    expect(delivered.map(e => [e.idempotencyKey, KnowledgeDeliveredPayload.parse(e.payload).ids.length])).toEqual([[preloadKey('r-1', 0), 1], [preloadKey('r-1', 1), 2]])
    expect(new Set(delivered.map(e => e.idempotencyKey)).size).toBe(2)
  })
  it('pushes the claims the ROOT task tree recorded, latest first', async () => {
    const port = memoryPort()
    const { added } = await port.write({ author, idempotencyKey: null }, { add: [fact('first', 'lib/a.ts'), fact('second', 'lib/b.ts'), fact('third', 'lib/c.ts')] })
    const asked: string[] = []
    const writesOf = async (taskId: string) => { asked.push(taskId); return { live: [...added], retired: [], files: [] } }
    const p = params({ stepId: 's1', role: STEP_ROLE.worker, taskId: 't-1.s.c', ancestorTaskIds: ['t-1.p', 't-1'] })
    const got = await bindStepKnowledge({ access: { port }, author, p, writesOf }).knowledge.preload(1_200, 0)
    expect(asked).toEqual(['t-1'])
    expect(got.map(c => [c.claim.text, c.arm])).toEqual([['third', PreloadArm.pushed], ['second', PreloadArm.pushed], ['first', PreloadArm.pushed]])
  })
  it('asks for the paths the step names and its zone prefixes, dropping what is no relative path, with the run-keyed call', async () => {
    const { port, seen, keys } = asking()
    const step = { title: 'Fix packages/kernel/src/config.ts', instructions: 'See `src/a.ts:12`, not /etc/passwd or src/../x.ts.', zone: ['packages/kernel/src/**', '**/*.ts'] }
    await bindStepKnowledge({ access: { port }, author, p: params({ stepId: 's1', role: STEP_ROLE.worker, step }), writesOf: async () => NO_KNOWLEDGE_WRITES }).knowledge.preload(800, 0)
    expect(seen).toEqual([{
      pushed: [], paths: ['packages/kernel/src/config.ts', 'src/a.ts', 'packages/kernel/src'],
      query: `${step.title}\n${step.instructions}`.slice(0, KNOWLEDGE_LIMITS.preloadQueryChars), budget: 800,
    }])
    expect(keys).toEqual([preloadKey('r-1', 0)])
  })
  it('never asks for the root, which would put every claim at the step\'s path', async () => {
    const { port, seen } = asking()
    const step = { title: 'Tidy', instructions: 'Start from ./ and keep it small.', zone: ['.', 'src/**'] }
    await bindStepKnowledge({ access: { port }, author, p: params({ stepId: 's1', role: STEP_ROLE.worker, step }), writesOf: async () => NO_KNOWLEDGE_WRITES }).knowledge.preload(800, 0)
    expect(seen.map(r => r.paths)).toEqual([['src']])
  })
  it('pushes at most one patch of the latest claims the root recorded', async () => {
    const { port, seen } = asking()
    const live = Array.from({ length: KNOWLEDGE_LIMITS.patchItems + 1 }, (_, i) => ({ id: knowledgeIdFrom(String(i)), location: 'k/a.md' }))
    await bindStepKnowledge({ access: { port }, author, p: worker, writesOf: async () => ({ live, retired: [], files: [] }) }).knowledge.preload(800, 0)
    expect(seen.map(r => r.pushed)).toEqual([live.toReversed().slice(0, KNOWLEDGE_LIMITS.patchItems).map(r => r.id)])
  })
  it('a zero budget asks nothing', async () => {
    const { port, seen } = asking()
    expect(await bindStepKnowledge({ access: { port }, author, p: worker, writesOf: async () => NO_KNOWLEDGE_WRITES }).knowledge.preload(0, 0)).toEqual([])
    expect(seen).toEqual([])
  })
  it('never throws into the step: a failing port warns once and yields nothing', async () => {
    const warned: string[] = []
    const bound = bindStepKnowledge({ access: { port: failingPort }, author, p: worker, writesOf: async () => NO_KNOWLEDGE_WRITES, warn: l => warned.push(l) })
    expect(await bound.knowledge.preload(1_200, 0)).toEqual([])
    expect(warned).toEqual([PRELOAD_NOT_READ('bucket broken')])
  })
})
