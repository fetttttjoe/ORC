import type { KnowledgeBackend, KnowledgeConfig, KnowledgeHost, KnowledgePlugin } from '@orc/contracts'

export const REGISTRY_REFUSAL = {
  unknownPlugin: (id: string, known: readonly string[]): string => `knowledge: unknown plugin '${id}' (known: ${known.join(', ')})`,
} as const

export function resolveKnowledgeBackend(config: KnowledgeConfig | null, plugins: readonly KnowledgePlugin[], host: KnowledgeHost): KnowledgeBackend | null {
  if (config === null) return null
  const plugin = plugins.find(p => p.id === config.plugin)
  if (!plugin) throw new Error(REGISTRY_REFUSAL.unknownPlugin(config.plugin, plugins.map(p => p.id)))
  return plugin.create(config.options, host)
}
