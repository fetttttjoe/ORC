import type { ModelCost, ModelProvider, ProviderConfigs, ProviderPlugin } from '@orc/contracts'
import { providerPlugin as anthropic } from '@orc/provider-anthropic'
import { providerPlugin as openai } from '@orc/provider-openai'
import { providerPlugin as ollama } from '@orc/provider-ollama'

export const PROVIDER_PLUGINS: readonly ProviderPlugin[] = [anthropic, openai, ollama]

export function configuredProviders(
  config: { providers: ProviderConfigs; costOverrides: Record<string, Record<string, ModelCost>>; ollamaBaseUrl: string },
  plugins: readonly ProviderPlugin[] = PROVIDER_PLUGINS,
): Map<string, ModelProvider<unknown>> {
  const registry = new Map(plugins.map(plugin => [plugin.id, plugin]))
  const defaults: ProviderConfigs = Object.fromEntries(plugins.map(plugin => [plugin.id, { plugin: plugin.id, options: {} }]))
  defaults[ollama.id] = { plugin: ollama.id, options: { baseUrl: config.ollamaBaseUrl } }
  const providers = new Map<string, ModelProvider<unknown>>()
  for (const [id, definition] of Object.entries({ ...defaults, ...config.providers })) {
    if (definition === null) continue
    const plugin = registry.get(definition.plugin)
    if (!plugin) throw new Error(`provider '${id}': unknown provider plugin '${definition.plugin}'`)
    providers.set(id, plugin.create(definition.options, config.costOverrides[id] ?? {}))
  }
  return providers
}
