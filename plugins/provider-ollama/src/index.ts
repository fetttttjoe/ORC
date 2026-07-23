import { createOllama } from 'ai-sdk-ollama'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

// narrow unknown JSON to an indexable object at the fetch boundary — no cast (repo rule: parse, don't assert)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// live model discovery from the local daemon — [] when it is not running (fetch injectable for tests)
export async function listOllamaModels(baseUrl: string, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`)
    if (!res.ok) return []
    const body: unknown = await res.json()
    const models: unknown[] = isRecord(body) && Array.isArray(body.models) ? body.models : []
    return models.map(m => (isRecord(m) ? m.name : undefined)).filter((n): n is string => typeof n === 'string')
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
