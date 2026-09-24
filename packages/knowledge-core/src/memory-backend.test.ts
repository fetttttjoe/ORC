import { describeKnowledgeBackend, CONTRACT_DIRS, CONTRACT_FILES } from './contract-suite'
import { createMemoryBackend } from './memory-backend'

const known = new Set<string>([...CONTRACT_FILES, ...CONTRACT_DIRS])
describeKnowledgeBackend('the in-memory backend', async () => ({
  backend: createMemoryBackend({ exists: (_checkout, path) => known.has(path) }),
  checkout: '/checkout-one',
  other: '/checkout-two',
  cleanup: async () => {},
}))
