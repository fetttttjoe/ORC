import { describe, expect, it } from 'bun:test'
import { ZodError } from 'zod'
import {
  AUTHOR_SOURCE, ClaimClass, DECISION_REFUSAL, DecisionStatus, DeliveryMode, Door, EVENT_KIND, KNOWLEDGE_LIMITS, knowledgeIdFrom,
  type Decision, type DecisionInputRaw, type EventInput, type KnowledgeBackend, type MemoryAuthor,
} from '@orc/contracts'
import { planDecisionRecord } from './decision-record'
import { createMemoryBackend } from './memory-backend'
import { createKnowledgePort, EVIDENCE_NOT_RECORDED, type KnowledgePortDeps } from './port'

const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, workspaceId: 'ws-1', origin: { chatId: 'chat-1', door: Door.supervisor }, taskId: 't-1', stepId: 's-1', runToken: 'r-1' }
const setup = (append: (e: EventInput) => Promise<void> = async () => {}, over: Partial<KnowledgePortDeps> = {}) => {
  const events: EventInput[] = []
  const warned: string[] = []
  const port = createKnowledgePort({
    backend: createMemoryBackend({ exists: () => true }),
    checkoutOf: async () => '/checkout',
    append: async e => { events.push(e); await append(e) },
    warn: line => warned.push(line),
    ...over,
  })
  return { port, events, warned }
}
const adr = (title: string, over: Partial<DecisionInputRaw> = {}): DecisionInputRaw => ({ title, context: 'c', decision: 'd', consequences: 'q', ...over })
const fileBackedDecisions = (): KnowledgeBackend => {
  const held = new Map<string, Decision>()
  return {
    ...createMemoryBackend({ exists: () => true }),
    decisions: async () => [...held.values()],
    decision: async (_checkout, id) => held.get(id) ?? null,
    recordDecision: async (_checkout, draft) => {
      const plan = planDecisionRecord({ held, claimed: new Set(held.keys()), draft, locationOf: d => `docs/decisions/${d.date}-${d.id}.md` })
      for (const d of plan.writes) held.set(d.id, d)
      return plan.result
    },
  }
}
const read = (mode = DeliveryMode.card) => ({ author, idempotencyKey: null, mode })
const write = (idempotencyKey: string | null = null) => ({ author, idempotencyKey })
const fact = (text: string) => ({ text, class: ClaimClass.fact, anchors: [{ path: 'src/a.ts' }] })

describe('the knowledge port records evidence', () => {
  it('a write appends knowledge_written with refs, why, decision and the author envelope', async () => {
    const { port, events } = setup()
    await port.recordDecision(write(), adr('D 1'))
    events.splice(0)
    const result = await port.write(write('key-1'), { add: [fact('x')], why: 'because', decision: 'd-1' })
    expect(events).toEqual([{
      chatId: 'chat-1', door: Door.supervisor, taskId: 't-1', stepId: 's-1', runToken: 'r-1', idempotencyKey: 'key-1',
      kind: EVENT_KIND.knowledge_written,
      payload: { added: result.added, changed: [], retired: [], files: result.files, why: 'because', decision: 'd-1', decisionsRecorded: [], decisionsSuperseded: [], author },
    }])
  })
  it('a card appends knowledge_delivered with the delivered ids, mode and subject; an empty card appends nothing', async () => {
    const { port, events } = setup()
    expect((await port.card(read(), 'src/a.ts')).claims).toEqual([])
    expect(events).toEqual([])
    const [ref] = (await port.write(write(), { add: [fact('x')] })).added
    await port.card(read(DeliveryMode.preload), 'src/a.ts')
    expect(events.at(-1)).toMatchObject({ kind: EVENT_KIND.knowledge_delivered, payload: { ids: [ref?.id], mode: DeliveryMode.preload, subject: 'src/a.ts' } })
  })
  it('a search appends knowledge_delivered with the delivered ids, mode and subject (the query); an empty search appends nothing', async () => {
    const { port, events } = setup()
    expect(await port.search(read(DeliveryMode.search), 'nothing')).toEqual([])
    expect(events).toEqual([])
    const [ref] = (await port.write(write(), { add: [fact('unique term')] })).added
    await port.search(read(DeliveryMode.search), 'unique')
    expect(events.at(-1)).toMatchObject({ kind: EVENT_KIND.knowledge_delivered, payload: { ids: [ref?.id], mode: DeliveryMode.search, subject: 'unique' } })
  })
  it('a get appends knowledge_delivered with the delivered ids, mode and subject (the ids joined); an empty get appends nothing', async () => {
    const { port, events } = setup()
    expect(await port.get(read(DeliveryMode.get), ['zzzzzzzz'])).toEqual([])
    expect(events).toEqual([])
    const [ref] = (await port.write(write(), { add: [fact('x')] })).added
    await port.get(read(DeliveryMode.get), [ref?.id ?? ''])
    expect(events.at(-1)).toMatchObject({ kind: EVENT_KIND.knowledge_delivered, payload: { ids: [ref?.id], mode: DeliveryMode.get, subject: ref?.id } })
  })
  it('a falsy task, step or run token is an unbound envelope', async () => {
    const { port, events } = setup()
    await port.write({ author: { ...author, taskId: '', stepId: null, runToken: undefined }, idempotencyKey: null }, { add: [fact('x')] })
    expect(events[0]).toMatchObject({ taskId: null, stepId: null, runToken: null })
  })
})

describe('the knowledge port on replay and failure', () => {
  it('a replayed write with the same key adds the same claims once', async () => {
    const { port } = setup()
    const first = await port.write(write('call-7'), { add: [fact('once'), fact('twice')] })
    const second = await port.write(write('call-7'), { add: [fact('once'), fact('twice')] })
    expect(first.added.map(r => r.id)).toEqual([knowledgeIdFrom('call-7:0'), knowledgeIdFrom('call-7:1')])
    expect(second.added).toEqual(first.added)
    expect((await port.card(read(), '.')).claims.length).toBe(2)
  })
  it('a read still answers when evidence cannot be appended, and says so', async () => {
    const { port, warned } = setup(async e => { if (e.kind === EVENT_KIND.knowledge_delivered) throw new Error('log down') })
    await port.write(write(), { add: [fact('x')] })
    expect((await port.card(read(), '.')).claims.length).toBe(1)
    expect(warned).toEqual([EVIDENCE_NOT_RECORDED('log down')])
  })
  it('a write still succeeds when evidence cannot be appended, and warns in its result', async () => {
    const { port } = setup(async () => { throw new Error('log down') })
    const result = await port.write(write(), { add: [fact('x')] })
    expect(result.added.length).toBe(1)
    expect(result.warnings).toContain(EVIDENCE_NOT_RECORDED('log down'))
  })
  it('caps the page and search sizes it asks the backend for', async () => {
    const seen: number[] = []
    const inner = createMemoryBackend({ exists: () => true })
    const port = createKnowledgePort({
      backend: {
        ...inner,
        card: (checkout, entity, page) => { seen.push(page.limit); return inner.card(checkout, entity, page) },
        search: (checkout, query, limit) => { seen.push(limit); return inner.search(checkout, query, limit) },
      },
      checkoutOf: async () => '/checkout',
      append: async () => {},
    })
    await port.card(read(), '.', { limit: 10_000 })
    await port.search(read(DeliveryMode.search), 'x', 10_000)
    expect(seen).toEqual([KNOWLEDGE_LIMITS.pageItems, KNOWLEDGE_LIMITS.searchItems])
  })
  it.each([[Number.NaN], [0], [-1], [1.5]])('refuses a page or search limit of %p', async limit => {
    const { port } = setup()
    await expect(port.card(read(), '.', { limit })).rejects.toThrow(ZodError)
    await expect(port.search(read(DeliveryMode.search), 'x', limit)).rejects.toThrow(ZodError)
  })
})

describe('the knowledge port get', () => {
  it('reads and delivers a repeated id once', async () => {
    const { port, events } = setup()
    const [ref] = (await port.write(write(), { add: [fact('x')] })).added
    const id = ref?.id ?? ''
    expect((await port.get(read(DeliveryMode.get), [id, id])).map(c => c.id)).toEqual([id])
    expect(events.at(-1)).toMatchObject({ kind: EVENT_KIND.knowledge_delivered, payload: { ids: [id], subject: id } })
  })
  it('refuses more ids than one delivery carries, and a malformed id, without asking the backend', async () => {
    const asked: (readonly string[])[] = []
    const inner = createMemoryBackend({ exists: () => true })
    const port = createKnowledgePort({
      backend: { ...inner, get: (checkout, ids) => { asked.push(ids); return inner.get(checkout, ids) } },
      checkoutOf: async () => '/checkout',
      append: async () => {},
    })
    const tooMany = Array.from({ length: KNOWLEDGE_LIMITS.deliveredIds + 1 }, (_, i) => knowledgeIdFrom(String(i)))
    await expect(port.get(read(DeliveryMode.get), tooMany)).rejects.toThrow(ZodError)
    await expect(port.get(read(DeliveryMode.get), ['NOT-AN-ID'])).rejects.toThrow(ZodError)
    expect(asked).toEqual([])
  })
})

describe('the knowledge port on decisions', () => {
  it('a record appends exactly one knowledge_written carrying the refs, the files and the envelope', async () => {
    const inner = createMemoryBackend({ exists: () => true })
    const { port, events } = setup(async () => {}, {
      backend: { ...inner, recordDecision: async (checkout, draft) => ({ ...(await inner.recordDecision(checkout, draft)), files: [`docs/decisions/${draft.id}.md`] }) },
    })
    await port.recordDecision(write(), adr('Old way'))
    events.splice(0)
    const result = await port.recordDecision(write('key-2'), adr('New way', { supersedes: 'old-way' }))
    expect(result.recorded).toEqual({ id: 'new-way', location: 'memory:decision/new-way' })
    expect(events).toEqual([{
      chatId: 'chat-1', door: Door.supervisor, taskId: 't-1', stepId: 's-1', runToken: 'r-1', idempotencyKey: 'key-2',
      kind: EVENT_KIND.knowledge_written,
      payload: {
        added: [], changed: [], retired: [], files: ['docs/decisions/new-way.md'], why: null, decision: null,
        decisionsRecorded: [{ id: 'new-way', location: 'memory:decision/new-way' }],
        decisionsSuperseded: [{ id: 'old-way', location: 'memory:decision/old-way' }],
        author,
      },
    }])
  })
  it('a keyed record called twice appends one payload for its key, and the replay carries no warning', async () => {
    const payloads = new Map<string, string>()
    const { port, events } = setup(async e => {
      const key = e.idempotencyKey ?? null
      if (key === null) return
      const payload = JSON.stringify(e.payload)
      const held = payloads.get(key)
      if (held !== undefined && held !== payload) throw new Error(`idempotency conflict on ${key}`)
      payloads.set(key, payload)
    }, { backend: fileBackedDecisions(), today: () => '2026-09-29' })
    await port.recordDecision(write('key-old'), adr('Old way'))
    const first = await port.recordDecision(write('key-new'), adr('New way', { supersedes: 'old-way' }))
    const again = await port.recordDecision(write('key-new'), adr('New way', { supersedes: 'old-way' }))
    expect(first.files).toEqual(['docs/decisions/2026-09-29-new-way.md', 'docs/decisions/2026-09-29-old-way.md'])
    expect(again).toEqual(first)
    expect(again.warnings).toEqual([])
    expect(events.map(e => e.idempotencyKey)).toEqual(['key-old', 'key-new', 'key-new'])
  })
  it('the date comes from today', async () => {
    const { port } = setup(async () => {}, { today: () => '2026-01-02' })
    await port.recordDecision(write(), adr('Dated'))
    expect((await port.decision(write(), 'dated')).date).toBe('2026-01-02')
  })
  it('a status filter returns only that status, in attention order', async () => {
    const days = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']
    const { port } = setup(async () => {}, { today: () => days.shift() ?? '2026-12-31' })
    await port.recordDecision(write(), adr('Oldest'))
    await port.recordDecision(write(), adr('Maybe', { status: DecisionStatus.proposed }))
    await port.recordDecision(write(), adr('Middle'))
    await port.recordDecision(write(), adr('Newest'))
    expect((await port.decisions(write(), { status: DecisionStatus.accepted })).map(d => d.id)).toEqual(['newest', 'middle', 'oldest'])
    expect((await port.decisions(write())).map(d => d.id)).toEqual(['maybe', 'newest', 'middle', 'oldest'])
  })
  it('a decision of an unknown id is refused as no such decision', async () => {
    const { port } = setup()
    await expect(port.decision(write(), 'ghost')).rejects.toThrow(DECISION_REFUSAL.noSuchDecision('ghost'))
  })
  it('a record still lands when evidence cannot be appended, and warns in its result', async () => {
    const { port } = setup(async () => { throw new Error('log down') })
    const result = await port.recordDecision(write(), adr('Kept'))
    expect(result.warnings).toEqual([EVIDENCE_NOT_RECORDED('log down')])
    expect((await port.decision(write(), 'kept')).title).toBe('Kept')
  })
  it('a superseded input status is refused before the backend is called', async () => {
    const asked: string[] = []
    const inner = createMemoryBackend({ exists: () => true })
    const { port } = setup(async () => {}, { backend: { ...inner, recordDecision: (checkout, draft) => { asked.push(draft.id); return inner.recordDecision(checkout, draft) } } })
    await expect(port.recordDecision(write(), adr('Gone', { status: DecisionStatus.superseded }))).rejects.toThrow(ZodError)
    expect(asked).toEqual([])
  })
})
