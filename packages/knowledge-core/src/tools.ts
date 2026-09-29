import { z } from 'zod'
import {
  DecisionSlug, DeliveryMode, EntityPath, KNOWLEDGE_DEFAULTS, KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, KnowledgeChange,
  KnowledgeDraft, KnowledgeId, KnowledgePage, KnowledgeToolName, toolError,
  type KnowledgeAccess, type KnowledgePort, type MemoryAuthor, type ResolvedTool,
} from '@orc/contracts'

export const KNOWLEDGE_STEP_TOOLS = [KnowledgeToolName.card, KnowledgeToolName.search, KnowledgeToolName.write] as const
export const KNOWLEDGE_READ_TOOLS = [KnowledgeToolName.card, KnowledgeToolName.search] as const
export type KnowledgeStepToolName = (typeof KNOWLEDGE_STEP_TOOLS)[number]

const CardInput = KnowledgePage.partial().extend({ path: EntityPath })
const SearchInput = z.object({ query: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.subjectChars), limit: KnowledgePage.shape.limit.optional() })
const WriteInput = z.object({
  add: z.array(KnowledgeDraft).max(KNOWLEDGE_LIMITS.patchItems).default([]),
  change: z.array(KnowledgeChange).max(KNOWLEDGE_LIMITS.patchItems).default([]),
  retire: z.array(KnowledgeId).max(KNOWLEDGE_LIMITS.patchItems).default([]),
  why: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.whyChars),
  decision: DecisionSlug.nullable().default(null),
})

export const knowledgeIdempotencyKey = (author: MemoryAuthor, toolCallId: string | undefined): string | null =>
  author.runToken && toolCallId ? `${author.runToken}:tool:${toolCallId}:knowledge` : null

export const toolSchemaOf = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dropped, ...json } = z.toJSONSchema(schema, { io: 'input' })
  return json
}

interface ToolSpec {
  description: string
  input: z.ZodType
  run(port: KnowledgePort, author: MemoryAuthor, input: unknown, toolCallId: string | undefined): Promise<unknown>
}

const read = (author: MemoryAuthor, toolCallId: string | undefined, mode: DeliveryMode) =>
  ({ author, idempotencyKey: knowledgeIdempotencyKey(author, toolCallId), mode })

const SPECS: Record<KnowledgeStepToolName, ToolSpec> = {
  [KnowledgeToolName.card]: {
    description: 'Claims recorded about a path: every claim anchored at or under it (a file, a folder, or "." for the whole project) — id, class (fact = what the code does now, why = the reason it is that way), text, anchors, tags and sources. Call it on the files and folders you are about to work in before you read them. Pass `cursor` from `next` for more.',
    input: CardInput,
    run: async (port, author, input, toolCallId) => {
      const q = CardInput.parse(input)
      const card = await port.card(read(author, toolCallId, DeliveryMode.card), q.path, { cursor: q.cursor ?? null, limit: q.limit ?? KNOWLEDGE_DEFAULTS.pageItems })
      return { path: q.path, claims: card.claims, next: card.next }
    },
  },
  [KnowledgeToolName.search]: {
    description: `Claims ranked for a query over their text, tags, anchor paths and symbols. Use it for what ${KnowledgeToolName.card} on your paths did not cover.`,
    input: SearchInput,
    run: async (port, author, input, toolCallId) => {
      const q = SearchInput.parse(input)
      return { query: q.query, claims: await port.search(read(author, toolCallId, DeliveryMode.search), q.query, q.limit ?? KNOWLEDGE_DEFAULTS.searchItems) }
    },
  },
  [KnowledgeToolName.write]: {
    description: 'Record, correct or retire claims in the knowledge files. add: one standalone sentence per claim, class "fact" or "why", anchors [{path, symbol?}] — the first anchor decides the file it is kept in; a research finding lists its http(s) sources. change: {id, and only the fields to replace}. retire: ids of claims your work made false. why: one line on why this write happened (required). A retried call is safe. Never edit knowledge files with file tools.',
    input: WriteInput,
    run: async (port, author, input, toolCallId) => {
      const result = await port.write({ author, idempotencyKey: knowledgeIdempotencyKey(author, toolCallId) }, WriteInput.parse(input))
      return { added: result.added, changed: result.changed, retired: result.retired, warnings: result.warnings }
    },
  },
}

export function knowledgeTools(access: KnowledgeAccess, author: MemoryAuthor, names: readonly KnowledgeStepToolName[]): ResolvedTool[] {
  return names.map(name => {
    const spec = SPECS[name]
    return {
      ref: `knowledge/${name}`, name, description: spec.description, inputSchema: toolSchemaOf(spec.input),
      execute: async (input: unknown, toolCallId?: string) => {
        if ('unavailable' in access) return { output: { error: KNOWLEDGE_REFUSAL.unavailable(access.unavailable) }, isError: true }
        try { return { output: await spec.run(access.port, author, input, toolCallId), isError: false } } catch (err) { return toolError(err) }
      },
    }
  })
}
