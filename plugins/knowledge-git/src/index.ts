import { DEFAULT_KNOWLEDGE_PLUGIN, type KnowledgePlugin } from '@orc/contracts'
import { createGitFilesBackend } from './backend'

export { createDrift, runGit, type Drift, type GitRun } from './drift'
export { createOutlineCache, type SourceOutline } from './outline-cache'

export const gitFilesPlugin: KnowledgePlugin = { id: DEFAULT_KNOWLEDGE_PLUGIN, create: (options, host) => createGitFilesBackend(options, { structure: host.structure }) }
