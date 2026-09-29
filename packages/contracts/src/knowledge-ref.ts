import { z } from 'zod'

// Kept import-free (no node:crypto) so execution.ts's SplitResult can carry a KnowledgeRef without pulling knowledge.ts's crypto chain into graph-ui's bundle.
export const KNOWLEDGE_ID_LENGTH = 8
export const KNOWLEDGE_ID_RE = new RegExp(`^[a-z0-9]{${KNOWLEDGE_ID_LENGTH}}$`)
export const KnowledgeId = z.string().regex(KNOWLEDGE_ID_RE)

export const KnowledgeRef = z.object({ id: KnowledgeId, location: z.string().min(1) })
export type KnowledgeRef = z.infer<typeof KnowledgeRef>

export const DECISION_SLUG_CHARS = 80
export const DECISION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const DecisionSlug = z.string().max(DECISION_SLUG_CHARS).regex(DECISION_SLUG_RE)
export const KNOWLEDGE_TAG_LIMITS = { chars: 40, items: 8 } as const
export const KNOWLEDGE_TAG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const KnowledgeTag = z.string().max(KNOWLEDGE_TAG_LIMITS.chars).regex(KNOWLEDGE_TAG_RE)
