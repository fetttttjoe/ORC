import { KERNEL_ERROR_CODE, KernelError, type EventLog, type ProjectConfig } from '@orc/kernel'
import {
  errorMessage, EVENT_KIND, KNOWLEDGE_REFUSAL, KnowledgeCheckedPayload,
  type KnowledgeAccess, type KnowledgeBackend, type KnowledgeHost, type KnowledgePlugin,
} from '@orc/contracts'
import { createKnowledgePort, resolveKnowledgeBackend } from '@orc/knowledge-core'
import { gitFilesPlugin } from '@orc/knowledge-git'
import { createTreeSitterStructure } from '@orc/structure-treesitter'

export const KNOWLEDGE_PLUGINS: readonly KnowledgePlugin[] = [gitFilesPlugin]

const host: KnowledgeHost = { structure: createTreeSitterStructure() }

export type KnowledgeOpening = { backend: KnowledgeBackend } | { unavailable: string }

export function openKnowledge(config: Pick<ProjectConfig, 'knowledge'>): KnowledgeOpening {
  try {
    const backend = resolveKnowledgeBackend(config.knowledge, KNOWLEDGE_PLUGINS, host)
    return backend === null ? { unavailable: KNOWLEDGE_REFUSAL.off() } : { backend }
  } catch (err) {
    return { unavailable: errorMessage(err) }
  }
}

const checksIn = (log: Pick<EventLog, 'after'>) => async (): Promise<KnowledgeCheckedPayload[]> =>
  (await log.after(0, [EVENT_KIND.knowledge_checked])).flatMap(e => {
    const parsed = KnowledgeCheckedPayload.safeParse(e.payload)
    return parsed.success ? [parsed.data] : []
  })

export function knowledgeAccess(opening: KnowledgeOpening, log: Pick<EventLog, 'append' | 'after'>, checkout: string): KnowledgeAccess {
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
      checks: checksIn(log),
    }),
  }
}
