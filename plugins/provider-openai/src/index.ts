import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { modelIdsFrom, type ModelCost, type ModelProvider } from '@orc/contracts'

// live model discovery — [] when the key is missing or the API is down (fetch injectable for tests,
// but nothing injects one: unlike its ollama/anthropic siblings, this has no test, so not exported)
async function listOpenAIModels(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return []
  try {
    const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } })
    if (!res.ok) return []
    return modelIdsFrom(await res.json(), 'data', 'id')
  } catch {
    return []
  }
}

// no verified price table shipped — costUSD stays null/estimated until set in .orc/config.json costOverrides.openai
export function createOpenAIProvider(
  costOverrides: Record<string, ModelCost> = {},
): ModelProvider<LanguageModel> {
  const openai = createOpenAI({}) // OPENAI_API_KEY from env
  return {
    costs: { ...costOverrides },
    languageModel: modelId => openai(modelId),
    listModels: () => listOpenAIModels(),
  }
}
