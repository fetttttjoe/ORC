import { stepAuthor, type KnowledgeBackend, type ResolvedTool, type StepKnowledge } from '@orc/contracts'
import { createKnowledgePort, createInMemoryBackend, bindStepKnowledge, NO_STRUCTURE } from '@orc/knowledge-core'
import type { EventLog } from '../storage'
import type { Kernel } from '../kernel'
import type { createDbosPort } from './dbos-port'

type StepParams = Parameters<NonNullable<Parameters<typeof createDbosPort>[0]['stepTools']>>[0]

export const FIXTURE_CHECKOUT = '/checkout'

export interface InMemoryKnowledge {
  backend: KnowledgeBackend
  stepTools: (p: StepParams, extra?: ResolvedTool[]) => { tools: ResolvedTool[]; knowledge: StepKnowledge }
}

export function inMemoryKnowledge(log: Pick<EventLog, 'append'>, kernel: Kernel): InMemoryKnowledge {
  const backend = createInMemoryBackend({ exists: () => true, structure: NO_STRUCTURE, read: () => null })
  const port = createKnowledgePort({
    backend,
    checkoutOf: async () => FIXTURE_CHECKOUT,
    append: async event => { await log.append(event) },
  })
  const stepTools: InMemoryKnowledge['stepTools'] = (p, extra = []) => {
    const author = stepAuthor(p)
    const bound = bindStepKnowledge({
      access: { port }, author, p: { stepId: p.stepId, role: p.role, taskId: p.taskId, ancestorTaskIds: p.ancestorTaskIds, step: p.step },
      writesOf: id => kernel.listTaskKnowledgeWrites(id),
    })
    return { tools: [...bound.tools, ...extra], knowledge: bound.knowledge }
  }
  return { backend, stepTools }
}
