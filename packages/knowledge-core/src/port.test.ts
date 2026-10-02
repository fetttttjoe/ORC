import { describe, expect, it } from 'bun:test'
import { ZodError } from 'zod'
import {
  AUTHOR_SOURCE, CheckVerdict, ClaimClass, ClaimState, DECISION_REFUSAL, DecisionStatus, DeliveryMode, Door, EVENT_KIND, KNOWLEDGE_LIMITS,
  KNOWLEDGE_REFUSAL, KnowledgeDeliveredPayload, KnowledgeWrittenPayload, knowledgeIdFrom, PreloadArm, preloadLine, sha256,
  type Decision, type DecisionInputRaw, type EventInput, type KnowledgeBackend, type MemoryAuthor,
} from '@orc/contracts'
import { directoryDigest } from './anchor-digest'
import { planDecisionRecord } from './decision-record'
import { BASIS_EVIDENCE_KINDS, type EvidenceRecord } from './evidence-events'
import { createEvidenceReader } from './evidence-reader'
import { emptyEvidence } from './evidence'
import { createMemoryBackend, NO_STRUCTURE } from './memory-backend'
import { tokensOf } from './preload'
import { ASSERTION_NOT_READ, createKnowledgePort, EVIDENCE_NOT_READ, EVIDENCE_NOT_RECORDED, type KnowledgePortDeps } from './port'

const author: MemoryAuthor = { source: AUTHOR_SOURCE.agent, workspaceId: 'ws-1', origin: { chatId: 'chat-1', door: Door.supervisor }, taskId: 't-1', stepId: 's-1', runToken: 'r-1' }
const setup = (append: (e: EventInput) => Promise<void> = async () => {}, over: Partial<KnowledgePortDeps> = {}) => {
  const events: EventInput[] = []
  const warned: string[] = []
  const port = createKnowledgePort({
    backend: createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null }),
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
    ...createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null }),
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
    const asserted = [{ id: knowledgeIdFrom('key-1:0'), text: 'x', anchors: [{ path: 'src/a.ts', symbol: null, digest: directoryDigest([]) }] }]
    expect(events).toEqual([{
      chatId: 'chat-1', door: Door.supervisor, taskId: 't-1', stepId: 's-1', runToken: 'r-1', idempotencyKey: 'key-1',
      kind: EVENT_KIND.knowledge_written,
      payload: { added: result.added, changed: [], retired: [], files: result.files, why: 'because', decision: 'd-1', decisionsRecorded: [], decisionsSuperseded: [], asserted, author },
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
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
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
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
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
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
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
        asserted: [],
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
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
    const { port } = setup(async () => {}, { backend: { ...inner, recordDecision: (checkout, draft) => { asked.push(draft.id); return inner.recordDecision(checkout, draft) } } })
    await expect(port.recordDecision(write(), adr('Gone', { status: DecisionStatus.superseded }))).rejects.toThrow(ZodError)
    expect(asked).toEqual([])
  })
})

describe('the knowledge port on claim state and checks', () => {
  const checking = (over: Partial<KnowledgePortDeps> = {}) => {
    const sources = new Map<string, string>([['src/a.ts', 'v1'], ['src/b.ts', 'b']])
    const events: EventInput[] = []
    const records: EvidenceRecord[] = []
    const warned: string[] = []
    let evidenceDown = false
    const reader = createEvidenceReader({
      after: async (seq, kinds) => {
        if (evidenceDown) throw new Error('log down')
        return records.filter(r => r.seq > seq && kinds.some(k => k === r.kind))
      },
      earliestSeq: async () => records[0]?.seq ?? 0,
    }, BASIS_EVIDENCE_KINDS)
    const port = createKnowledgePort({
      backend: createMemoryBackend({ exists: (_c, path) => sources.has(path), structure: NO_STRUCTURE, read: (_c, path) => sources.get(path) ?? null }),
      checkoutOf: async () => '/checkout',
      append: async e => { events.push(e); records.push({ seq: records.length + 1, kind: e.kind, runToken: e.runToken ?? null, payload: e.payload }) },
      evidence: () => reader.read(),
      warn: line => warned.push(line),
      ...over,
    })
    const stateOf = async (id: string) => (await port.drift(write(), { ids: [id] }))[0]?.state
    const assertedBy = (e: EventInput | undefined) => KnowledgeWrittenPayload.parse(e?.payload).asserted
    return { port, sources, events, warned, stateOf, assertedBy, breakEvidence: () => { evidenceDown = true } }
  }
  const claimOn = async (port: ReturnType<typeof checking>['port'], text = 'a writes the store') => {
    const [ref] = (await port.write(write(), { add: [fact(text)] })).added
    return ref?.id ?? ''
  }

  it('a holds check clears a suspect claim until its code changes again; a later text change does not inherit it', async () => {
    const { port, sources, stateOf } = checking()
    const id = await claimOn(port)
    expect(await stateOf(id)).toBe(ClaimState.clean)
    sources.set('src/a.ts', 'v2')
    expect(await stateOf(id)).toBe(ClaimState.suspect)
    await port.check(write(), { id, verdict: CheckVerdict.holds, why: 'read a: it still writes the store' })
    expect(await stateOf(id)).toBe(ClaimState.clean)
    sources.set('src/a.ts', 'v3')
    expect(await stateOf(id)).toBe(ClaimState.suspect)
    await port.write(write(), { change: [{ id, text: 'a writes the store twice' }] })
    sources.set('src/a.ts', 'v2')
    expect(await stateOf(id)).toBe(ClaimState.suspect)
  })

  it('an unknown check records only, and drift appends no event', async () => {
    const { port, sources, events, stateOf } = checking()
    const id = await claimOn(port)
    sources.set('src/a.ts', 'v2')
    events.splice(0)
    expect(await stateOf(id)).toBe(ClaimState.suspect)
    expect(events).toEqual([])
    const result = await port.check(write('chk-1'), { id, verdict: CheckVerdict.unknown, why: 'the code does not say' })
    expect(result).toEqual({ verdict: CheckVerdict.unknown, written: null, warnings: [] })
    expect(events.map(e => [e.kind, e.idempotencyKey])).toEqual([[EVENT_KIND.knowledge_checked, 'chk-1']])
    expect(events[0]?.payload).toEqual({
      id, verdict: CheckVerdict.unknown, text: 'a writes the store', anchors: [{ path: 'src/a.ts', symbol: null, digest: sha256('v2') }], why: 'the code does not say', author,
    })
    expect(await stateOf(id)).toBe(ClaimState.suspect)
  })

  it('a false check without a patch that corrects the claim is refused and appends nothing; so is a holds with a patch and an unknown id', async () => {
    const { port, events } = checking()
    const id = await claimOn(port)
    const other = await claimOn(port, 'b is another module')
    events.splice(0)
    await expect(port.check(write(), { id, verdict: CheckVerdict.false, why: 'wrong' })).rejects.toThrow(KNOWLEDGE_REFUSAL.checkNeedsPatch(id))
    await expect(port.check(write(), { id, verdict: CheckVerdict.false, why: 'wrong', patch: { retire: [other] } })).rejects.toThrow(KNOWLEDGE_REFUSAL.checkNeedsPatch(id))
    await expect(port.check(write(), { id, verdict: CheckVerdict.holds, why: 'fine', patch: { retire: [id] } })).rejects.toThrow(KNOWLEDGE_REFUSAL.checkTakesNoPatch(CheckVerdict.holds))
    await expect(port.check(write(), { id: 'zzzzzzzz', verdict: CheckVerdict.holds, why: 'fine' })).rejects.toThrow(KNOWLEDGE_REFUSAL.unknownId('zzzzzzzz'))
    expect(events).toEqual([])
    expect((await port.get(read(DeliveryMode.get), [id, other])).length).toBe(2)
  })

  it('a false check with a retire retires the claim, then records the check of the text and digests it read before the patch', async () => {
    const { port, sources, events } = checking()
    const id = await claimOn(port)
    sources.set('src/a.ts', 'v2')
    events.splice(0)
    const result = await port.check(write('chk-2'), { id, verdict: CheckVerdict.false, why: 'a no longer writes the store', patch: { retire: [id] } })
    expect(result.written?.retired.map(r => r.id)).toEqual([id])
    expect(events.map(e => [e.kind, e.idempotencyKey])).toEqual([[EVENT_KIND.knowledge_written, 'chk-2:patch'], [EVENT_KIND.knowledge_checked, 'chk-2']])
    expect(events[0]?.payload).toMatchObject({ retired: [{ id }], why: 'a no longer writes the store' })
    expect(events[1]?.payload).toMatchObject({ id, verdict: CheckVerdict.false, text: 'a writes the store', anchors: [{ path: 'src/a.ts', symbol: null, digest: sha256('v2') }] })
    expect(await port.get(read(DeliveryMode.get), [id])).toEqual([])
  })

  it('a false check with a change corrects the claim, records the text it checked, and the check clears nothing', async () => {
    const { port, sources, events, stateOf } = checking()
    const id = await claimOn(port)
    sources.set('src/a.ts', 'v2')
    const result = await port.check(write(), { id, verdict: CheckVerdict.false, why: 'a writes twice now', patch: { change: [{ id, text: 'a writes the store twice' }] } })
    expect(result.written?.changed.map(r => r.id)).toEqual([id])
    expect(events.at(-1)?.payload).toMatchObject({ id, verdict: CheckVerdict.false, text: 'a writes the store' })
    expect((await port.get(read(DeliveryMode.get), [id]))[0]?.text).toBe('a writes the store twice')
    expect(await stateOf(id)).toBe(ClaimState.clean)
    sources.set('src/a.ts', 'v3')
    expect(await stateOf(id)).toBe(ClaimState.suspect)
  })

  it('evidence that cannot be read leaves drift answering from the readings alone, with a warning', async () => {
    const { port, sources, warned, stateOf, breakEvidence } = checking()
    const id = await claimOn(port)
    sources.set('src/a.ts', 'v2')
    await port.check(write(), { id, verdict: CheckVerdict.holds, why: 'still true' })
    expect(await stateOf(id)).toBe(ClaimState.clean)
    breakEvidence()
    expect(await stateOf(id)).toBe(ClaimState.suspect)
    expect(warned).toEqual([EVIDENCE_NOT_READ('log down')])
  })

  it('an add asserts the digests its anchors have right after the write', async () => {
    const { port, events, assertedBy } = checking()
    const { added } = await port.write(write(), { add: [fact('a writes the store'), { text: 'b is unanchored', class: ClaimClass.fact }] })
    expect(assertedBy(events.at(-1))).toEqual([
      { id: added[0]?.id, text: 'a writes the store', anchors: [{ path: 'src/a.ts', symbol: null, digest: sha256('v1') }] },
      { id: added[1]?.id, text: 'b is unanchored', anchors: [] },
    ])
  })

  it('a tag-only change asserts nothing, so it does not clear a claim whose code moved though the backend re-took its basis', async () => {
    const { port, sources, events, stateOf, assertedBy, breakEvidence } = checking()
    const id = await claimOn(port)
    sources.set('src/a.ts', 'v2')
    await port.write(write(), { change: [{ id, tags: ['store'] }] })
    expect(assertedBy(events.at(-1))).toEqual([])
    expect(await stateOf(id)).toBe(ClaimState.suspect)
    breakEvidence()
    expect(await stateOf(id)).toBe(ClaimState.clean)
  })

  it('a text change asserts again, with the digests its anchors have now', async () => {
    const { port, sources, events, stateOf, assertedBy } = checking()
    const id = await claimOn(port)
    sources.set('src/a.ts', 'v2')
    expect(await stateOf(id)).toBe(ClaimState.suspect)
    await port.write(write(), { change: [{ id, text: 'a writes the store twice' }] })
    expect(assertedBy(events.at(-1))).toEqual([{ id, text: 'a writes the store twice', anchors: [{ path: 'src/a.ts', symbol: null, digest: sha256('v2') }] }])
    expect(await stateOf(id)).toBe(ClaimState.clean)
  })

  it('a change that resends the claim\'s own text or anchors asserts nothing and leaves it suspect; a new text clears it', async () => {
    const { port, sources, events, stateOf, assertedBy } = checking()
    const id = await claimOn(port)
    sources.set('src/a.ts', 'v2')
    await port.write(write(), { change: [{ id, text: 'a writes the store', tags: ['store'] }] })
    expect(assertedBy(events.at(-1))).toEqual([])
    await port.write(write(), { change: [{ id, anchors: [{ path: 'src/a.ts' }] }] })
    expect(assertedBy(events.at(-1))).toEqual([])
    expect(await stateOf(id)).toBe(ClaimState.suspect)
    await port.write(write(), { change: [{ id, text: 'a writes the store twice', tags: ['store'] }] })
    expect(await stateOf(id)).toBe(ClaimState.clean)
  })

  it('a patch with more claims to assert than one drift read takes asserts every one of them', async () => {
    const { port, events, assertedBy } = checking()
    const id = await claimOn(port)
    const result = await port.write(write(), {
      add: Array.from({ length: KNOWLEDGE_LIMITS.patchItems }, (_, i) => fact(`a writes the store, part ${i}`)),
      change: [{ id, text: 'a writes the store twice' }],
    })
    expect(result.warnings).toEqual([])
    expect(assertedBy(events.at(-1)).map(a => a.id).toSorted()).toEqual([...result.added.map(r => r.id), id].toSorted())
  })

  it('a write whose anchors cannot be read after it still lands, asserts nothing and says so', async () => {
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
    const { port, events, assertedBy } = checking({ backend: { ...inner, readings: async () => { throw new Error('tree unreadable') } } })
    const result = await port.write(write(), { add: [fact('a writes the store')] })
    expect(result.warnings).toEqual([ASSERTION_NOT_READ('tree unreadable')])
    expect(assertedBy(events.at(-1))).toEqual([])
    expect((await port.get(read(DeliveryMode.get), [result.added[0]?.id ?? ''])).length).toBe(1)
  })

  it('a restating write still lands and asserts every restating change when the held claims cannot be read first', async () => {
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
    let armed = false
    const { port, events, assertedBy } = checking({ backend: { ...inner, get: async (checkout, ids) => { if (armed) throw new Error('index locked'); return inner.get(checkout, ids) } } })
    const id = await claimOn(port)
    armed = true
    const result = await port.write(write(), { change: [{ id, text: 'a writes the store twice' }] })
    expect(result.warnings).toEqual([ASSERTION_NOT_READ('index locked')])
    expect(assertedBy(events.at(-1)).map(a => a.id)).toEqual([id])
  })

  it('a check still answers when its evidence cannot be appended, and says so', async () => {
    const { port } = checking({ append: async e => { if (e.kind === EVENT_KIND.knowledge_checked) throw new Error('log down') } })
    const id = await claimOn(port)
    expect(await port.check(write(), { id, verdict: CheckVerdict.holds, why: 'fine' })).toEqual({ verdict: CheckVerdict.holds, written: null, warnings: [EVIDENCE_NOT_RECORDED('log down')] })
  })
})

describe('the knowledge port preload', () => {
  const at = (text: string, path: string) => ({ text, class: ClaimClass.fact, anchors: [{ path }] })
  const idsOf = async (port: ReturnType<typeof setup>['port'], ...claims: ReturnType<typeof at>[]) =>
    (await port.write(write(), { add: claims })).added.map(r => r.id)
  const deliveries = (events: EventInput[]) => events.filter(e => e.kind === EVENT_KIND.knowledge_delivered)

  it('reads pushed, then here, around and search, each claim once in its first arm', async () => {
    const { port } = setup()
    const [pushed, here, around, found] = await idsOf(port, at('pushed one', 'src/a.ts'), at('here zebra', 'src/a.ts'), at('around one', 'src'), at('found zebra', 'lib/z.ts'))
    const got = await port.preload(write(), { pushed: [pushed ?? ''], paths: ['src/a.ts'], query: 'zebra', budget: 1_000 })
    expect(got.map(p => [p.claim.id, p.arm])).toEqual([[pushed, PreloadArm.pushed], [here, PreloadArm.here], [around, PreloadArm.around], [found, PreloadArm.search]])
  })
  it('reads a pushed claim through its readings alone, never a second time', async () => {
    const asked: string[] = []
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
    const { port } = setup(async () => {}, { backend: { ...inner, get: (c, ids) => { asked.push('get'); return inner.get(c, ids) }, readings: (c, f) => { asked.push('readings'); return inner.readings(c, f) } } })
    const [first, second] = await idsOf(port, at('first', 'src/a.ts'), at('second', 'lib/b.ts'))
    asked.splice(0)
    const got = await port.preload(write(), { pushed: [second ?? '', first ?? ''], paths: [], query: '', budget: 1_000 })
    expect(got.map(p => p.claim.text)).toEqual(['second', 'first'])
    expect(asked).toEqual(['readings'])
  })
  it('delivers what fits the budget, the first claim always', async () => {
    const { port } = setup()
    const ids = await idsOf(port, ...Array.from({ length: 6 }, (_, i) => at(`claim number ${i}`, 'src/a.ts')))
    const cost = tokensOf(preloadLine({ id: ids[0] ?? '', text: 'claim number 0', anchors: [{ path: 'src/a.ts', symbol: null }] }, ClaimState.clean))
    expect((await port.preload(write(), { pushed: [], paths: ['src/a.ts'], query: '', budget: 3 * cost })).length).toBe(3)
    expect((await port.preload(write(), { pushed: [], paths: ['src/a.ts'], query: '', budget: 1 })).length).toBe(1)
  })
  it('appends one knowledge_delivered in preload mode with exactly the delivered ids and the call key', async () => {
    const { port, events } = setup()
    const ids = await idsOf(port, ...Array.from({ length: 6 }, (_, i) => at(`claim number ${i}`, 'src/a.ts')))
    const cost = tokensOf(preloadLine({ id: ids[0] ?? '', text: 'claim number 0', anchors: [{ path: 'src/a.ts', symbol: null }] }, ClaimState.clean))
    events.splice(0)
    const got = await port.preload(write('r-1:preload'), { pushed: [], paths: ['src/a.ts'], query: 'claim', budget: 2 * cost })
    expect(deliveries(events)).toEqual([{
      chatId: 'chat-1', door: Door.supervisor, taskId: 't-1', stepId: 's-1', runToken: 'r-1', idempotencyKey: 'r-1:preload',
      kind: EVENT_KIND.knowledge_delivered, payload: { ids: got.map(p => p.claim.id), mode: DeliveryMode.preload, subject: 'claim', author },
    }])
    expect(got.length).toBe(2)
  })
  it('delivers no more claims than one delivery event records', async () => {
    const { port, events } = setup()
    for (let batch = 0; batch * KNOWLEDGE_LIMITS.patchItems <= KNOWLEDGE_LIMITS.deliveredIds; batch++)
      await idsOf(port, ...Array.from({ length: KNOWLEDGE_LIMITS.patchItems }, (_, i) => at(`claim ${batch} ${i}`, 'src/a.ts')))
    events.splice(0)
    const got = await port.preload(write(), { pushed: [], paths: ['src/a.ts'], query: '', budget: 1_000_000 })
    expect(got.length).toBe(KNOWLEDGE_LIMITS.deliveredIds)
    expect(deliveries(events).map(e => KnowledgeDeliveredPayload.parse(e.payload).ids)).toEqual([got.map(p => p.claim.id)])
  })
  it('an empty request or a zero budget delivers nothing, appends nothing and reads nothing', async () => {
    const asked: string[] = []
    const inner = createMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
    const { port, events } = setup(async () => {}, {
      backend: { ...inner, readings: (c, f) => { asked.push('readings'); return inner.readings(c, f) }, search: (c, q, l) => { asked.push('search'); return inner.search(c, q, l) } },
      evidence: async () => { asked.push('evidence'); return emptyEvidence() },
    })
    const [id] = await idsOf(port, at('x', 'src/a.ts'))
    events.splice(0)
    asked.splice(0)
    expect(await port.preload(write(), { pushed: [], paths: [], query: ' ', budget: 1_000 })).toEqual([])
    expect(await port.preload(write(), { pushed: [id ?? ''], paths: ['src/a.ts'], query: 'x', budget: 0 })).toEqual([])
    expect(events).toEqual([])
    expect(asked).toEqual([])
  })
  it('refuses a request past its limits, or naming a path outside the checkout, before reading anything', async () => {
    const asked: string[] = []
    const { port } = setup(async () => {}, { checkoutOf: async () => { asked.push('checkout'); return '/checkout' } })
    const base = { pushed: [], paths: [], query: 'x', budget: 1_000 }
    await expect(port.preload(write(), { ...base, query: 'q'.repeat(KNOWLEDGE_LIMITS.preloadQueryChars + 1) })).rejects.toThrow(ZodError)
    await expect(port.preload(write(), { ...base, paths: Array.from({ length: KNOWLEDGE_LIMITS.patchItems + 1 }, (_, i) => `src/${i}.ts`) })).rejects.toThrow(ZodError)
    await expect(port.preload(write(), { ...base, paths: ['/etc/passwd'] })).rejects.toThrow(ZodError)
    await expect(port.preload(write(), { ...base, budget: -1 })).rejects.toThrow(ZodError)
    expect(asked).toEqual([])
  })
  it('a requested path with no claims delivers nothing and is no error', async () => {
    const { port, events } = setup()
    await idsOf(port, at('x', 'src/a.ts'))
    events.splice(0)
    expect(await port.preload(write(), { pushed: [], paths: ['nowhere/y.ts'], query: '', budget: 1_000 })).toEqual([])
    expect(events).toEqual([])
  })
  it('costs a claim at the token count of the line the step is shown, a clean one without its state', async () => {
    const sources = new Map([['src/a.ts', 'v1'], ['src/b.ts', 'b']])
    const { port } = setup(async () => {}, { backend: createMemoryBackend({ exists: (_c, path) => sources.has(path), structure: NO_STRUCTURE, read: (_c, path) => sources.get(path) ?? null }) })
    const [moved, kept] = await idsOf(port, at('a holds', 'src/a.ts'), at('b holds', 'src/b.ts'))
    sources.set('src/a.ts', 'v2')
    const ask = (budget: number) => port.preload(write(), { pushed: [moved ?? '', kept ?? ''], paths: [], query: '', budget })
    const all = await ask(10_000)
    expect(all.map(p => p.state)).toEqual([ClaimState.clean, ClaimState.suspect])
    const exact = all.reduce((sum, p) => sum + tokensOf(preloadLine(p.claim, p.state)), 0)
    expect((await ask(exact)).length).toBe(2)
    expect((await ask(exact - 1)).length).toBe(1)
  })
  it('a claim whose code changed since it was written is delivered suspect, behind a clean one', async () => {
    const sources = new Map([['src/a.ts', 'v1'], ['src/b.ts', 'b']])
    const { port } = setup(async () => {}, { backend: createMemoryBackend({ exists: (_c, path) => sources.has(path), structure: NO_STRUCTURE, read: (_c, path) => sources.get(path) ?? null }) })
    const [moved, kept] = await idsOf(port, at('a holds', 'src/a.ts'), at('b holds', 'src/b.ts'))
    sources.set('src/a.ts', 'v2')
    const got = await port.preload(write(), { pushed: [moved ?? '', kept ?? ''], paths: [], query: '', budget: 1_000 })
    expect(got.map(p => [p.claim.id, p.state])).toEqual([[kept, ClaimState.clean], [moved, ClaimState.suspect]])
  })
})
