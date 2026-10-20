import { createOllama } from 'ai-sdk-ollama'
import type { LanguageModel } from 'ai'
import { z } from 'zod'
import type { ModelCost, ModelProvider, ProviderPlugin } from '@orc/contracts'

export const providerPlugin: ProviderPlugin<LanguageModel> = {
  id: 'ollama',
  create: (options, costs) => createOllamaProvider({
    ...z.strictObject({ baseUrl: z.url().optional() }).parse(options), costOverrides: costs,
  }),
}

// absent capabilities (older daemons) must never exclude a model
const TagsResponse = z.object({
  models: z.array(z.object({ name: z.string(), capabilities: z.array(z.string()).optional() }).loose()),
})
const EMBEDDING_CAPABILITY = 'embedding'

// THROWS when the daemon cannot answer; [] means it answered and nothing usable is installed
export async function listOllamaModels(baseUrl: string, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl}/api/tags`)
  if (!res.ok) throw new Error(`ollama /api/tags answered ${res.status}`)
  const parsed = TagsResponse.safeParse(await res.json())
  if (!parsed.success) throw new Error('ollama /api/tags answered an unexpected shape')
  return parsed.data.models
    .filter(m => !m.capabilities?.includes(EMBEDDING_CAPABILITY))
    .map(m => m.name)
}

export function createOllamaProvider(
  opts: { baseUrl?: string; costOverrides?: Record<string, ModelCost> } = {},
): ModelProvider<LanguageModel> {
  const baseUrl = opts.baseUrl ?? 'http://localhost:11434'
  const ollama = createOllama({ baseURL: baseUrl })
  return {
    costs: { '*': { inPerMTok: 0, outPerMTok: 0 }, ...opts.costOverrides }, // local models are free by default
    languageModel: modelId => ollama(modelId),
    listModels: () => listOllamaModels(baseUrl),
  }
}
