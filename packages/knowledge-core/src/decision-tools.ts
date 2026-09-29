import { z } from 'zod'
import {
  DecisionFilter, DecisionInput, DecisionSlug, decisionSummaryOf, KnowledgeToolName,
  type KnowledgeAccess, type MemoryAuthor, type ResolvedTool,
} from '@orc/contracts'
import { knowledgeIdempotencyKey, resolveKnowledgeTool, type ToolSpec } from './tools'

export const DECISION_STEP_TOOLS = [KnowledgeToolName.decisionList, KnowledgeToolName.decisionRead, KnowledgeToolName.recordDecision] as const
export type DecisionStepToolName = (typeof DECISION_STEP_TOOLS)[number]

const ReadInput = z.object({ id: DecisionSlug })
const RecordInput = DecisionInput.omit({ status: true })

const SPECS: Record<DecisionStepToolName, ToolSpec> = {
  [KnowledgeToolName.decisionList]: {
    description: `Every decision this project has recorded, attention-first, one line each. An empty list is a real answer: nothing is recorded yet. Read one fully with ${KnowledgeToolName.decisionRead} before you say a plan collides with it.`,
    input: DecisionFilter,
    run: async (port, author, input) => ({
      decisions: (await port.decisions({ author, idempotencyKey: null }, DecisionFilter.parse(input))).map(decisionSummaryOf),
    }),
  },
  [KnowledgeToolName.decisionRead]: {
    description: 'One recorded decision in full: Context, Decision, Consequences and the alternatives Considered, with what it supersedes and what superseded it.',
    input: ReadInput,
    run: (port, author, input) => port.decision({ author, idempotencyKey: null }, ReadInput.parse(input).id),
  },
  [KnowledgeToolName.recordDecision]: {
    description: 'Record ONE architectural decision, only AFTER the human approved its exact wording at this step\'s question: title, Context, Decision, Consequences and the alternatives Considered. A changed decision is a supersession (`supersedes` = the old decision\'s id), recorded only if the human approved that too. Recording an existing title with other content is refused. A retried call is safe.',
    input: RecordInput,
    run: async (port, author, input, toolCallId) => {
      const result = await port.recordDecision({ author, idempotencyKey: knowledgeIdempotencyKey(author, toolCallId) }, RecordInput.parse(input))
      return { id: result.recorded.id, status: result.status, superseded: result.superseded?.id ?? null, warnings: result.warnings }
    },
  },
}

export const decisionTools = (access: KnowledgeAccess, author: MemoryAuthor): ResolvedTool[] =>
  DECISION_STEP_TOOLS.map(name => resolveKnowledgeTool(name, SPECS[name], access, author))
