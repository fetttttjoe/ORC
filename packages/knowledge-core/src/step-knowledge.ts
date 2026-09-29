import path from 'node:path'
import {
  DeliveryMode, errorMessage, KNOWLEDGE_DEFAULTS, KNOWLEDGE_REFUSAL, KnowledgeToolName, stepMayReconcile, toolError,
  type KnowledgeAccess, type KnowledgeClaim, type KnowledgePort, type KnowledgeWrites, type MemoryAuthor, type ResolvedTool, type StepKnowledge,
} from '@orc/contracts'
import { KNOWLEDGE_STEP_TOOLS, knowledgeIdempotencyKey, knowledgeTools } from './tools'

export interface StepKnowledgeBinding {
  tools: ResolvedTool[]
  knowledge: StepKnowledge
  citing: ((paths: readonly string[]) => Promise<KnowledgeClaim[]>) | null
}

export const AT_RISK_NOT_READ = (reason: string): string => `claims at risk not read: ${reason}`

const TASK_CLAIMS_DESCRIPTION = `The claims THIS task and its split children recorded and did not retire, read from the knowledge files; the refs of the claims they retired; and the ids of recorded claims no longer in the files. Start here: each claim is yours to keep, correct (${KnowledgeToolName.write} change) or retire.`

async function claimsAt(port: KnowledgePort, author: MemoryAuthor, paths: readonly string[], mode: DeliveryMode): Promise<KnowledgeClaim[]> {
  const found = new Map<string, KnowledgeClaim>()
  for (const entity of new Set(paths.map(p => path.posix.normalize(p)))) {
    const card = await port.card({ author, idempotencyKey: null, mode }, entity, { limit: KNOWLEDGE_DEFAULTS.pageItems })
    for (const claim of card.claims) found.set(claim.id, claim)
  }
  return [...found.values()].slice(0, KNOWLEDGE_DEFAULTS.pageItems)
}

function taskClaimsTool(access: KnowledgeAccess, author: MemoryAuthor, writesOf: () => Promise<KnowledgeWrites>): ResolvedTool {
  return {
    ref: `knowledge/${KnowledgeToolName.taskClaims}`, name: KnowledgeToolName.taskClaims,
    description: TASK_CLAIMS_DESCRIPTION, inputSchema: { type: 'object', properties: {} },
    execute: async (_input, toolCallId) => {
      if ('unavailable' in access) return { output: { error: KNOWLEDGE_REFUSAL.unavailable(access.unavailable) }, isError: true }
      try {
        const writes = await writesOf()
        const ids = writes.live.map(r => r.id)
        const claims = ids.length === 0 ? [] : await access.port.get({ author, idempotencyKey: knowledgeIdempotencyKey(author, toolCallId), mode: DeliveryMode.get }, ids)
        const found = new Set(claims.map(c => c.id))
        return { output: { claims, retired: writes.retired, missing: ids.filter(id => !found.has(id)) }, isError: false }
      } catch (err) { return toolError(err) }
    },
  }
}

export function bindStepKnowledge(opts: {
  access: KnowledgeAccess
  author: MemoryAuthor
  p: { stepId: string; role: string }
  writesOf: () => Promise<KnowledgeWrites>
  warn?: (line: string) => void
}): StepKnowledgeBinding {
  const { access, author } = opts
  const warn = opts.warn ?? ((line: string) => console.warn(line))
  const tools = [
    ...knowledgeTools(access, author, KNOWLEDGE_STEP_TOOLS),
    ...(stepMayReconcile(opts.p) ? [taskClaimsTool(access, author, opts.writesOf)] : []),
  ]
  if ('unavailable' in access) return { tools, knowledge: { claimsAt: async () => [] }, citing: null }
  const { port } = access
  return {
    tools,
    knowledge: {
      claimsAt: async paths => {
        try { return await claimsAt(port, author, paths, DeliveryMode.push) } catch (err) {
          warn(AT_RISK_NOT_READ(errorMessage(err)))
          return []
        }
      },
    },
    citing: paths => claimsAt(port, author, paths, DeliveryMode.card),
  }
}
