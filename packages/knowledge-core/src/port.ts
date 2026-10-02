import { z } from 'zod'
import {
  byAttention, ClaimState, DECISION_REFUSAL, DecisionDraft, DecisionFilter, DecisionInput, decisionSlugOf, decisionStatusOf, DeliveryMode, DriftFilter, errorMessage, EVENT_KIND,
  KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, KnowledgeCheckInput, KnowledgeId, KnowledgePage, KnowledgePatch, knowledgeIdFrom, preloadLine, PreloadRequest,
  type ClaimReading, type DigestedAnchor, type EventInput, type KnowledgeAssertion, type KnowledgeBackend, type KnowledgeCall, type KnowledgeChange,
  type KnowledgeCheckedPayload, type KnowledgeClaim, type KnowledgePatchInput, type KnowledgePort, type KnowledgeRead, type KnowledgeWriteResult, type KnowledgeWrittenPayload,
  type MemoryAuthor, type PreloadedClaim,
} from '@orc/contracts'
import { driftOf } from './drift-of'
import { assemblePreload, tokensOf } from './preload'
import { preloadArms } from './preload-arms'
import { restatesClaim } from './patch'
import type { Evidence } from './evidence'

export interface KnowledgePortDeps {
  backend: KnowledgeBackend
  checkoutOf: (author: MemoryAuthor) => Promise<string>
  append: (event: EventInput) => Promise<void>
  evidence?: () => Promise<Evidence>
  warn?: (line: string) => void
  today?: () => string
}

export const EVIDENCE_NOT_RECORDED = (reason: string): string => `evidence not recorded: ${reason}`
export const EVIDENCE_NOT_READ = (reason: string): string => `knowledge evidence not read, claims read from their basis alone: ${reason}`
export const ASSERTION_NOT_READ = (reason: string): string => `anchors not read after the write, so it asserts no digests: ${reason}`

const envelope = (call: KnowledgeCall) => ({
  ...call.author.origin,
  taskId: call.author.taskId || null,
  stepId: call.author.stepId || null,
  runToken: call.author.runToken || null,
  idempotencyKey: call.idempotencyKey,
})
const RequestedIds = z.array(KnowledgeId).max(KNOWLEDGE_LIMITS.deliveredIds).transform(ids => [...new Set(ids)])
const limitOf = (asked: number | undefined, max: number): number => Math.min(KnowledgePage.shape.limit.parse(asked ?? max), max)
const pageOf = (page: Partial<KnowledgePage> | undefined): KnowledgePage =>
  KnowledgePage.parse({ cursor: page?.cursor ?? null, limit: limitOf(page?.limit, KNOWLEDGE_LIMITS.pageItems) })

const utcToday = (): string => new Date().toISOString().slice(0, 10)
const patchCall = (call: KnowledgeCall): KnowledgeCall => ({ ...call, idempotencyKey: call.idempotencyKey === null ? null : `${call.idempotencyKey}:patch` })
const digestedAnchors = (reading: ClaimReading): DigestedAnchor[] => reading.anchors.map(a => ({ path: a.path, symbol: a.symbol, digest: a.current }))
const setsTextOrAnchors = (change: KnowledgeChange): boolean => change.text !== undefined || change.anchors !== undefined
const chunked = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

export function createKnowledgePort(deps: KnowledgePortDeps): KnowledgePort {
  const warn = deps.warn ?? ((line: string) => console.warn(line))
  const today = deps.today ?? utcToday
  const recordWritten = async <R extends { warnings: string[] }>(call: KnowledgeCall, payload: KnowledgeWrittenPayload, result: R): Promise<R> => {
    try {
      await deps.append({ ...envelope(call), kind: EVENT_KIND.knowledge_written, payload })
      return result
    } catch (err) {
      return { ...result, warnings: [...result.warnings, EVIDENCE_NOT_RECORDED(errorMessage(err))] }
    }
  }
  const evidenceOf = async (): Promise<Evidence | null> => {
    try { return (await deps.evidence?.()) ?? null } catch (err) {
      warn(EVIDENCE_NOT_READ(errorMessage(err)))
      return null
    }
  }
  const readingsOf = async (checkout: string, ids: readonly string[]): Promise<ClaimReading[]> =>
    (await Promise.all(chunked(ids, KNOWLEDGE_LIMITS.patchItems).map(chunk => deps.backend.readings(checkout, DriftFilter.parse({ ids: chunk }))))).flat()
  const heldOf = async (checkout: string, ids: readonly string[]): Promise<{ held: KnowledgeClaim[]; warnings: string[] }> => {
    if (ids.length === 0) return { held: [], warnings: [] }
    try {
      return { held: await deps.backend.get(checkout, ids), warnings: [] }
    } catch (err) {
      return { held: [], warnings: [ASSERTION_NOT_READ(errorMessage(err))] }
    }
  }
  const assertionsOf = async (checkout: string, ids: readonly string[], held: ReadonlyMap<string, KnowledgeClaim>): Promise<{ asserted: KnowledgeAssertion[]; warnings: string[] }> => {
    if (ids.length === 0) return { asserted: [], warnings: [] }
    try {
      const restated = (await readingsOf(checkout, ids)).filter(r => { const before = held.get(r.claim.id); return before === undefined || restatesClaim(before, r.claim) })
      return { asserted: restated.map(r => ({ id: r.claim.id, text: r.claim.text, anchors: digestedAnchors(r) })), warnings: [] }
    } catch (err) {
      return { asserted: [], warnings: [ASSERTION_NOT_READ(errorMessage(err))] }
    }
  }
  const write = async (call: KnowledgeCall, input: KnowledgePatchInput): Promise<KnowledgeWriteResult> => {
    const parsed = KnowledgePatch.parse(input)
    const key = call.idempotencyKey
    const patch = key === null ? parsed : { ...parsed, add: parsed.add.map((a, i) => ({ ...a, id: a.id ?? knowledgeIdFrom(`${key}:${i}`) })) }
    const checkout = await deps.checkoutOf(call.author)
    const restating = patch.change.filter(setsTextOrAnchors).map(c => c.id)
    const before = await heldOf(checkout, restating)
    const result = await deps.backend.write(checkout, patch)
    const { asserted, warnings } = await assertionsOf(checkout, [...result.added.map(r => r.id), ...restating], new Map(before.held.map(c => [c.id, c])))
    return recordWritten(call, {
      added: result.added, changed: result.changed, retired: result.retired, files: result.files, why: patch.why, decision: patch.decision,
      decisionsRecorded: [], decisionsSuperseded: [], asserted, author: call.author,
    }, { ...result, warnings: [...result.warnings, ...before.warnings, ...warnings] })
  }
  const deliver = async (call: KnowledgeRead, ids: readonly string[], subject: string): Promise<void> => {
    if (ids.length === 0) return
    try {
      await deps.append({
        ...envelope(call), kind: EVENT_KIND.knowledge_delivered,
        payload: { ids: ids.slice(0, KNOWLEDGE_LIMITS.deliveredIds), mode: call.mode, subject: subject.slice(0, KNOWLEDGE_LIMITS.subjectChars), author: call.author },
      })
    } catch (err) {
      warn(EVIDENCE_NOT_RECORDED(errorMessage(err)))
    }
  }
  const preload: KnowledgePort['preload'] = async (call, raw) => {
    const request = PreloadRequest.parse(raw)
    const searching = request.query.trim() !== ''
    if (request.budget === 0 || (request.pushed.length === 0 && request.paths.length === 0 && !searching)) return []
    const checkout = await deps.checkoutOf(call.author)
    const [located, hits, evidence] = await Promise.all([
      request.paths.length === 0 ? [] : deps.backend.readings(checkout, DriftFilter.parse({ paths: request.paths })),
      searching ? deps.backend.search(checkout, request.query, KNOWLEDGE_LIMITS.searchItems) : [],
      evidenceOf(),
    ])
    const byPath = driftOf(located, evidence)
    const atPath = new Set(byPath.map(d => d.claim.id))
    const elsewhere = [...new Set([...request.pushed, ...hits.map(c => c.id)])].filter(id => !atPath.has(id))
    const judged = new Map([...byPath, ...driftOf(await readingsOf(checkout, elsewhere), evidence)].map(d => [d.claim.id, d]))
    const stateOf = (claim: KnowledgeClaim): ClaimState => judged.get(claim.id)?.state ?? ClaimState.unknown
    const pushed = request.pushed.flatMap(id => judged.get(id)?.claim ?? [])
    const candidates = preloadArms({ pushed, byPath, hits, stateOf, paths: request.paths }).map(({ arm, claims }) => claims.map(claim => {
      const item: PreloadedClaim = { claim, state: stateOf(claim), arm }
      return { id: claim.id, cost: tokensOf(preloadLine(claim, item.state)), item }
    }))
    const delivered = assemblePreload(candidates, request.budget).slice(0, KNOWLEDGE_LIMITS.deliveredIds).map(p => p.item)
    await deliver({ ...call, mode: DeliveryMode.preload }, delivered.map(p => p.claim.id), request.query)
    return delivered
  }
  return {
    async card(call, entity, page) {
      const card = await deps.backend.card(await deps.checkoutOf(call.author), entity, pageOf(page))
      await deliver(call, card.claims.map(c => c.id), entity)
      return card
    },
    async search(call, query, limit) {
      const hits = await deps.backend.search(await deps.checkoutOf(call.author), query, limitOf(limit, KNOWLEDGE_LIMITS.searchItems))
      await deliver(call, hits.map(c => c.id), query)
      return hits
    },
    async get(call, ids) {
      const unique = RequestedIds.parse(ids)
      const found = await deps.backend.get(await deps.checkoutOf(call.author), unique)
      await deliver(call, found.map(c => c.id), unique.join(' '))
      return found
    },
    write,
    async drift(call, filter) {
      const checkout = await deps.checkoutOf(call.author)
      const [readings, evidence] = await Promise.all([deps.backend.readings(checkout, DriftFilter.parse(filter ?? {})), evidenceOf()])
      return driftOf(readings, evidence)
    },
    preload,
    async check(call, raw) {
      const input = KnowledgeCheckInput.parse(raw)
      const [reading] = await deps.backend.readings(await deps.checkoutOf(call.author), DriftFilter.parse({ ids: [input.id] }))
      if (reading === undefined) throw new Error(KNOWLEDGE_REFUSAL.unknownId(input.id))
      const written = input.patch === undefined ? null : await write(patchCall(call), { ...input.patch, why: input.patch.why ?? input.why })
      const payload: KnowledgeCheckedPayload = {
        id: input.id, verdict: input.verdict, text: reading.claim.text, anchors: digestedAnchors(reading), why: input.why, author: call.author,
      }
      try {
        await deps.append({ ...envelope(call), kind: EVENT_KIND.knowledge_checked, payload })
        return { verdict: input.verdict, written, warnings: [] }
      } catch (err) {
        return { verdict: input.verdict, written, warnings: [EVIDENCE_NOT_RECORDED(errorMessage(err))] }
      }
    },
    async decisions(call, filter) {
      const { status } = DecisionFilter.parse(filter ?? {})
      const all = await deps.backend.decisions(await deps.checkoutOf(call.author))
      return all.filter(d => status === undefined || d.status === status).toSorted(byAttention)
    },
    async decision(call, id) {
      const found = await deps.backend.decision(await deps.checkoutOf(call.author), id)
      if (found === null) throw new Error(DECISION_REFUSAL.noSuchDecision(id))
      return found
    },
    async recordDecision(call, raw) {
      const input = DecisionInput.parse(raw)
      const draft = DecisionDraft.parse({
        id: decisionSlugOf(input.title), title: input.title, status: decisionStatusOf(input.status), date: today(), tags: input.tags,
        supersedes: input.supersedes ?? null, context: input.context, decision: input.decision, consequences: input.consequences, considered: input.considered,
      })
      const result = await deps.backend.recordDecision(await deps.checkoutOf(call.author), draft)
      return recordWritten(call, {
        added: [], changed: [], retired: [], files: result.files, why: null, decision: null,
        decisionsRecorded: [result.recorded], decisionsSuperseded: result.superseded ? [result.superseded] : [], asserted: [], author: call.author,
      }, result)
    },
  }
}
