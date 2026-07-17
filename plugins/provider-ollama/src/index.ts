import { createOllama } from 'ai-sdk-ollama'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

export function createOllamaProvider(
  opts: { baseUrl?: string; costOverrides?: Record<string, ModelCost> } = {},
): ModelProvider<LanguageModel> {
  const ollama = createOllama({ baseURL: opts.baseUrl ?? 'http://localhost:11434' })
  return {
    costs: { '*': { inPerMTok: 0, outPerMTok: 0 }, ...opts.costOverrides }, // local models are free by default
    languageModel: modelId => ollama(modelId),
  }
}
