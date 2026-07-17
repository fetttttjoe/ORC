import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'

// per-MTok pricing, verified 2026-07-17 (platform.claude.com/docs/en/pricing) — override via .orc/config.json
const COSTS: Record<string, ModelCost> = {
  'claude-fable-5': { inPerMTok: 10, outPerMTok: 50 },
  'claude-opus-4-8': { inPerMTok: 5, outPerMTok: 25 },
  'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15 },
  'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5 },
}

export function createAnthropicProvider(
  costOverrides: Record<string, ModelCost> = {},
): ModelProvider<LanguageModel> {
  const anthropic = createAnthropic({}) // ANTHROPIC_API_KEY from env
  return {
    costs: { ...COSTS, ...costOverrides },
    languageModel: modelId => anthropic(modelId),
  }
}
