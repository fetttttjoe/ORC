import { KERNEL_ERROR_CODE, KernelError, type EventLog, type ProjectConfig } from '@orc/kernel'
import type { KnowledgeBackend, KnowledgePlugin, KnowledgePort, MemoryAuthor } from '@orc/contracts'
import { createKnowledgePort, resolveKnowledgeBackend } from '@orc/knowledge-core'
import { gitFilesPlugin } from '@orc/knowledge-git'

export const KNOWLEDGE_PLUGINS: readonly KnowledgePlugin[] = [gitFilesPlugin]

export const knowledgeBackendFor = (config: Pick<ProjectConfig, 'knowledge'>): KnowledgeBackend | null =>
  resolveKnowledgeBackend(config.knowledge, KNOWLEDGE_PLUGINS)

export function openKnowledgePort(opts: {
  config: Pick<ProjectConfig, 'knowledge' | 'dir'>
  log: Pick<EventLog, 'append'>
  checkoutOf?: (author: MemoryAuthor) => Promise<string>
}): KnowledgePort | null {
  const backend = knowledgeBackendFor(opts.config)
  if (backend === null) return null
  return createKnowledgePort({
    backend,
    checkoutOf: opts.checkoutOf ?? (async () => opts.config.dir),
    append: async event => {
      try { await opts.log.append(event) } catch (err) {
        if (!(err instanceof KernelError && err.code === KERNEL_ERROR_CODE.idempotency_conflict)) throw err
      }
    },
  })
}
