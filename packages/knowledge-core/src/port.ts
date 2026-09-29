import { z } from 'zod'
import {
  byAttention, DECISION_REFUSAL, DecisionDraft, DecisionFilter, DecisionInput, decisionSlugOf, decisionStatusOf, errorMessage, EVENT_KIND,
  KNOWLEDGE_LIMITS, KnowledgeId, KnowledgePage, KnowledgePatch, knowledgeIdFrom,
  type EventInput, type KnowledgeBackend, type KnowledgeCall, type KnowledgePort, type KnowledgeRead, type KnowledgeWrittenPayload, type MemoryAuthor,
} from '@orc/contracts'

export interface KnowledgePortDeps {
  backend: KnowledgeBackend
  checkoutOf: (author: MemoryAuthor) => Promise<string>
  append: (event: EventInput) => Promise<void>
  warn?: (line: string) => void
  today?: () => string
}

export const EVIDENCE_NOT_RECORDED = (reason: string): string => `evidence not recorded: ${reason}`

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
    async write(call, input) {
      const parsed = KnowledgePatch.parse(input)
      const key = call.idempotencyKey
      const patch = key === null ? parsed : { ...parsed, add: parsed.add.map((a, i) => ({ ...a, id: a.id ?? knowledgeIdFrom(`${key}:${i}`) })) }
      const result = await deps.backend.write(await deps.checkoutOf(call.author), patch)
      return recordWritten(call, {
        added: result.added, changed: result.changed, retired: result.retired, files: result.files, why: patch.why, decision: patch.decision,
        decisionsRecorded: [], decisionsSuperseded: [], author: call.author,
      }, result)
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
