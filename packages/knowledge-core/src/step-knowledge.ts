import path from 'node:path'
import { DeliveryMode, EntityPath, errorMessage, KNOWLEDGE_DEFAULTS, KNOWLEDGE_LIMITS, KNOWLEDGE_REFUSAL, KnowledgeToolName, ROOT_ENTITY, stepMayPlan, stepMayReconcile, stepMayVerify, toolError, type KnowledgeAccess, type KnowledgeClaim, type KnowledgePort, type KnowledgeWrites, type Author, type PreloadedClaim, type ResolvedTool, type StepKnowledge, NO_INPUT_SCHEMA } from '@orc/contracts'
import { decisionTools } from './decision-tools'
import { namedPaths, preloadQuery, zonePrefix } from './preload-request'
import { KNOWLEDGE_STEP_TOOLS, KNOWLEDGE_VERIFY_TOOLS, knowledgeIdempotencyKey, knowledgeTools } from './tools'

export interface StepKnowledgeBinding {
  tools: ResolvedTool[]
  knowledge: StepKnowledge
  citing: ((paths: readonly string[]) => Promise<KnowledgeClaim[]>) | null
}

export const AT_RISK_NOT_READ = (reason: string): string => `claims at risk not read: ${reason}`
export const PRELOAD_NOT_READ = (reason: string): string => `knowledge preload not read: ${reason}`
export const preloadKey = (runToken: string, round: number): string => `${runToken}:preload:${round}`

interface StepParams {
  stepId: string
  role: string
  taskId: string
  ancestorTaskIds: readonly string[]
  step: { title: string; instructions: string; zone?: readonly string[] }
}

const TASK_CLAIMS_DESCRIPTION = `The claims THIS task and its split children recorded and did not retire, read from the knowledge files; the refs of the claims they retired; and the ids of recorded claims no longer in the files. Start here: each claim is yours to keep, correct (${KnowledgeToolName.write} change) or retire.`

async function claimsAt(port: KnowledgePort, author: Author, paths: readonly string[], mode: DeliveryMode): Promise<KnowledgeClaim[]> {
  const found = new Map<string, KnowledgeClaim>()
  for (const entity of new Set(paths.map(p => path.posix.normalize(p)))) {
    const card = await port.card({ author, idempotencyKey: null, mode }, entity, { limit: KNOWLEDGE_DEFAULTS.pageItems })
    for (const claim of card.claims) found.set(claim.id, claim)
  }
  return [...found.values()].slice(0, KNOWLEDGE_DEFAULTS.pageItems)
}

function requestedPaths(step: StepParams['step']): string[] {
  const named = [...namedPaths(`${step.title}\n${step.instructions}`), ...(step.zone ?? []).flatMap(glob => zonePrefix(glob) ?? [])]
  const parsed = named.flatMap(p => { const r = EntityPath.safeParse(p); return r.success && r.data !== ROOT_ENTITY ? [r.data] : [] })
  return [...new Set(parsed)].slice(0, KNOWLEDGE_LIMITS.patchItems)
}

async function preload(port: KnowledgePort, author: Author, p: StepParams, writesOf: (taskId: string) => Promise<KnowledgeWrites>, budget: number, round: number): Promise<PreloadedClaim[]> {
  const root = p.ancestorTaskIds.at(-1) ?? p.taskId
  const pushed = (await writesOf(root)).live.map(r => r.id).toReversed().slice(0, KNOWLEDGE_LIMITS.patchItems)
  return port.preload({ author, idempotencyKey: author.runToken ? preloadKey(author.runToken, round) : null }, {
    pushed, paths: requestedPaths(p.step), query: preloadQuery(p.step.title, p.step.instructions, KNOWLEDGE_LIMITS.preloadQueryChars), budget,
  })
}

function taskClaimsTool(access: KnowledgeAccess, author: Author, writesOf: () => Promise<KnowledgeWrites>): ResolvedTool {
  return {
    ref: `knowledge/${KnowledgeToolName.taskClaims}`, name: KnowledgeToolName.taskClaims,
    description: TASK_CLAIMS_DESCRIPTION, inputSchema: NO_INPUT_SCHEMA,
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
  author: Author
  p: StepParams
  writesOf: (taskId: string) => Promise<KnowledgeWrites>
  warn?: (line: string) => void
}): StepKnowledgeBinding {
  const { access, author, p, writesOf } = opts
  const warn = opts.warn ?? ((line: string) => console.warn(line))
  const tools = [
    ...knowledgeTools(access, author, KNOWLEDGE_STEP_TOOLS),
    ...(stepMayVerify(p) ? knowledgeTools(access, author, KNOWLEDGE_VERIFY_TOOLS) : []),
    ...(stepMayReconcile(p) ? [taskClaimsTool(access, author, () => writesOf(p.taskId))] : []),
    ...(stepMayPlan(p) || stepMayReconcile(p) ? decisionTools(access, author) : []),
  ]
  if ('unavailable' in access) return { tools, knowledge: { claimsAt: async () => [], preload: async () => [] }, citing: null }
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
      preload: async (budget, round) => {
        if (budget <= 0) return []
        try { return await preload(port, author, p, writesOf, budget, round) } catch (err) {
          warn(PRELOAD_NOT_READ(errorMessage(err)))
          return []
        }
      },
    },
    citing: paths => claimsAt(port, author, paths, DeliveryMode.card),
  }
}
