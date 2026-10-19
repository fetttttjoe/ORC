import { errorMessage, KnowledgeHealthState, type KnowledgeHealth } from '@orc/contracts'
import { knowledgeHealth } from '@orc/knowledge-core'
import type { EventLog, ProjectConfig } from '@orc/kernel'
import { knowledgeAuthor, type WorkspaceFold } from './cwd-workspace'
import { knowledgeAccess, openKnowledge, type KnowledgeOpening } from './knowledge-open'

export const KNOWLEDGE_HEALTH_TTL_MS = 15_000

export async function knowledgeHealthOf(
  opts: { config: ProjectConfig; log: EventLog; opening?: KnowledgeOpening }, fold: WorkspaceFold,
): Promise<KnowledgeHealth> {
  try {
    const access = knowledgeAccess(opts.opening ?? openKnowledge(opts.config), opts.log, opts.config.dir)
    return await knowledgeHealth(access, await knowledgeAuthor(fold, opts.config.dir))
  } catch (err) {
    return { state: KnowledgeHealthState.unavailable, reason: errorMessage(err) }
  }
}
