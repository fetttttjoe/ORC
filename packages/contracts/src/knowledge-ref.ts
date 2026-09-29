import { z } from 'zod'

// Kept import-free (no node:crypto) so execution.ts's SplitResult can carry a KnowledgeRef without pulling knowledge.ts's crypto chain into graph-ui's bundle.
export const KNOWLEDGE_ID_LENGTH = 8
export const KNOWLEDGE_ID_RE = new RegExp(`^[a-z0-9]{${KNOWLEDGE_ID_LENGTH}}$`)
export const KnowledgeId = z.string().regex(KNOWLEDGE_ID_RE)

export const KnowledgeRef = z.object({ id: KnowledgeId, location: z.string().min(1) })
export type KnowledgeRef = z.infer<typeof KnowledgeRef>
