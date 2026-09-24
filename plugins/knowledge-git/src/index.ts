import { DEFAULT_KNOWLEDGE_PLUGIN, type KnowledgePlugin } from '@orc/contracts'
import { createGitFilesBackend } from './backend'

export const gitFilesPlugin: KnowledgePlugin = { id: DEFAULT_KNOWLEDGE_PLUGIN, create: options => createGitFilesBackend(options) }
