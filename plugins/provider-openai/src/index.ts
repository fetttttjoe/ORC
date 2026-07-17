import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

// no verified price table shipped — costUSD stays null/estimated until set in .orc/config.json costOverrides.openai
export function createOpenAIProvider(
  costOverrides: Record<string, ModelCost> = {},
): ModelProvider<LanguageModel> {
  const openai = createOpenAI({}) // OPENAI_API_KEY from env
  return {
    costs: { ...costOverrides },
    languageModel: modelId => openai(modelId),
  }
}
