import { KERNEL_ERROR_CODE, KernelError, type EventLog, type ProjectConfig } from '@orc/kernel'
import { errorMessage, KNOWLEDGE_REFUSAL, type KnowledgeAccess, type KnowledgeBackend, type KnowledgePlugin } from '@orc/contracts'
import { createKnowledgePort, resolveKnowledgeBackend } from '@orc/knowledge-core'
import { gitFilesPlugin } from '@orc/knowledge-git'

export const KNOWLEDGE_PLUGINS: readonly KnowledgePlugin[] = [gitFilesPlugin]

export type KnowledgeOpening = { backend: KnowledgeBackend } | { unavailable: string }

export function openKnowledge(config: Pick<ProjectConfig, 'knowledge'>): KnowledgeOpening {
  try {
    const backend = resolveKnowledgeBackend(config.knowledge, KNOWLEDGE_PLUGINS)
    return backend === null ? { unavailable: KNOWLEDGE_REFUSAL.off() } : { backend }
  } catch (err) {
    return { unavailable: errorMessage(err) }
  }
}

export function knowledgeAccess(opening: KnowledgeOpening, log: Pick<EventLog, 'append'>, checkout: string): KnowledgeAccess {
  if ('unavailable' in opening) return opening
  return {
    port: createKnowledgePort({
      backend: opening.backend,
      checkoutOf: async () => checkout,
      append: async event => {
        try { await log.append(event) } catch (err) {
          if (!(err instanceof KernelError && err.code === KERNEL_ERROR_CODE.idempotency_conflict)) throw err
        }
      },
    }),
  }
}
