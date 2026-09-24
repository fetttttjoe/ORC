import { z } from 'zod'
import { MemoryAuthor } from './author'
import { DecisionSlug, DeliveryMode, KNOWLEDGE_LIMITS, KnowledgeId, KnowledgeRef } from './knowledge'

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
  why: z.string().nullable(),
  decision: DecisionSlug.nullable(),
  author: MemoryAuthor,
})
export type KnowledgeWrittenPayload = z.infer<typeof KnowledgeWrittenPayload>
