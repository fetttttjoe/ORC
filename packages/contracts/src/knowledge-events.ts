import { z } from 'zod'
import { MemoryAuthor } from './author'
import { DecisionRef } from './decision'
import { CheckVerdict, DecisionSlug, DeliveryMode, KNOWLEDGE_LIMITS, KnowledgeId, KnowledgeRef } from './knowledge'

export const KnowledgeDeliveredPayload = z.object({
  ids: z.array(KnowledgeId).min(1).max(KNOWLEDGE_LIMITS.deliveredIds),
  mode: z.enum(DeliveryMode),
  subject: z.string().max(KNOWLEDGE_LIMITS.subjectChars),
  author: MemoryAuthor,
})
export type KnowledgeDeliveredPayload = z.infer<typeof KnowledgeDeliveredPayload>

export const KnowledgeWrittenPayload = z.object({
  added: z.array(KnowledgeRef),
  changed: z.array(KnowledgeRef),
  retired: z.array(KnowledgeRef),
  files: z.array(z.string()),
  why: z.string().nullable(),
  decision: DecisionSlug.nullable(),
  decisionsRecorded: z.array(DecisionRef),
  decisionsSuperseded: z.array(DecisionRef),
  author: MemoryAuthor,
})
export type KnowledgeWrittenPayload = z.infer<typeof KnowledgeWrittenPayload>

export const KnowledgeCheckedPayload = z.object({
  id: KnowledgeId,
  verdict: z.enum(CheckVerdict),
  text: z.string().min(1),
  anchors: z.array(z.object({ path: z.string().min(1), symbol: z.string().min(1).nullable(), digest: z.string().nullable() })).max(KNOWLEDGE_LIMITS.anchors),
  why: z.string().min(1),
  author: MemoryAuthor,
})
export type KnowledgeCheckedPayload = z.infer<typeof KnowledgeCheckedPayload>
