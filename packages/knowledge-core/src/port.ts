import { z } from 'zod'
import {
  byAttention, DECISION_REFUSAL, DecisionDraft, DecisionFilter, DecisionInput, decisionSlugOf, decisionStatusOf, DriftFilter, errorMessage, EVENT_KIND,
  KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, KnowledgeCheckInput, KnowledgeId, KnowledgePage, KnowledgePatch, knowledgeIdFrom,
  type EventInput, type KnowledgeBackend, type KnowledgeCall, type KnowledgeCheckedPayload, type KnowledgePatchInput, type KnowledgePort,
  type KnowledgeRead, type KnowledgeWriteResult, type KnowledgeWrittenPayload, type MemoryAuthor,
} from '@orc/contracts'
import { driftOf } from './drift-of'

export interface KnowledgePortDeps {
  backend: KnowledgeBackend
  checkoutOf: (author: MemoryAuthor) => Promise<string>
  append: (event: EventInput) => Promise<void>
  checks?: () => Promise<KnowledgeCheckedPayload[]>
  warn?: (line: string) => void
  today?: () => string
}

export const EVIDENCE_NOT_RECORDED = (reason: string): string => `evidence not recorded: ${reason}`
export const CHECKS_NOT_READ = (reason: string): string => `knowledge checks not read, claims read from their basis alone: ${reason}`

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
  const checksOf = async (): Promise<KnowledgeCheckedPayload[]> => {
    try { return (await deps.checks?.()) ?? [] } catch (err) {
      warn(CHECKS_NOT_READ(errorMessage(err)))
      return []
    }
  }
  const write = async (call: KnowledgeCall, input: KnowledgePatchInput): Promise<KnowledgeWriteResult> => {
    const parsed = KnowledgePatch.parse(input)
    const key = call.idempotencyKey
    const patch = key === null ? parsed : { ...parsed, add: parsed.add.map((a, i) => ({ ...a, id: a.id ?? knowledgeIdFrom(`${key}:${i}`) })) }
    const result = await deps.backend.write(await deps.checkoutOf(call.author), patch)
    return recordWritten(call, {
      added: result.added, changed: result.changed, retired: result.retired, files: result.files, why: patch.why, decision: patch.decision,
      decisionsRecorded: [], decisionsSuperseded: [], author: call.author,
    }, result)
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
      const readings = await deps.backend.readings(await deps.checkoutOf(call.author), DriftFilter.parse(filter ?? {}))
      return driftOf(readings, await checksOf())
    },
    async check(call, raw) {
      const input = KnowledgeCheckInput.parse(raw)
      const [reading] = await deps.backend.readings(await deps.checkoutOf(call.author), DriftFilter.parse({ ids: [input.id] }))
      if (reading === undefined) throw new Error(KNOWLEDGE_REFUSAL.unknownId(input.id))
      const written = input.patch === undefined ? null : await write(patchCall(call), { ...input.patch, why: input.patch.why ?? input.why })
      const payload: KnowledgeCheckedPayload = {
        id: input.id, verdict: input.verdict, text: reading.claim.text,
        anchors: reading.anchors.map(a => ({ path: a.path, symbol: a.symbol, digest: a.current })), why: input.why, author: call.author,
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
        decisionsRecorded: [result.recorded], decisionsSuperseded: result.superseded ? [result.superseded] : [], author: call.author,
      }, result)
    },
  }
}
