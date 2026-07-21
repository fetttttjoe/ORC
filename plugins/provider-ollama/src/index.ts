import { createOllama } from 'ai-sdk-ollama'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

// live model discovery from the local daemon — [] when it is not running (fetch injectable for tests)
export async function listOllamaModels(baseUrl: string, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`)
    if (!res.ok) return []
    const body = await res.json() as { models?: Array<{ name?: string }> }
    return (body.models ?? []).map(m => m.name).filter((n): n is string => typeof n === 'string')
  } catch {
    return []
  }
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
