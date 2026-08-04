import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { modelIdsFrom, type ModelCost, type ModelProvider } from '@orc/contracts'

// live model discovery — THROWS when it cannot answer (network failure, bad status, unparseable
// body, missing key); [] means the API answered and nothing usable exists. openai ships no static
// cost table, so a swallowed failure here read as reachable-and-empty and discovery's append-on-
// change would record models: [] over the real catalog — the exact silence-vs-empty confusion the
// listModels contract (2026-08-03) exists to kill. Discovery isolates the throw per provider and
// keeps the last recorded catalog. fetch injectable for tests.
export async function listOpenAIModels(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is not set — cannot ask the openai models API')
  const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`openai /v1/models answered ${res.status}`)
  return modelIdsFrom(await res.json(), 'data', 'id')
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
