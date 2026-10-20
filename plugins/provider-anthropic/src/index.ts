import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { modelIdsFrom, type ModelCost, type ModelProvider, type ProviderPlugin } from '@orc/contracts'
import { z } from 'zod'
import { cachingFetch } from './cache'
import { loadOAuthToken, oauthFetch } from './oauth'

// per-MTok pricing (platform.claude.com/docs/en/pricing); cache reads 0.1x, 5m writes 1.25x input
const COSTS: Record<string, ModelCost> = {
  'claude-fable-5': { inPerMTok: 10, outPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
  'claude-opus-5': { inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  'claude-opus-4-8': { inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
}

export const providerPlugin: ProviderPlugin<LanguageModel> = {
  id: 'anthropic',
  create: (options, costs) => {
    z.strictObject({}).parse(options)
    return createAnthropicProvider(costs)
  },
}

// opt-in, API key by default: a subscription token may fall outside the terms for automated use
function useOAuth(): boolean {
  const mode = process.env.ORC_ANTHROPIC_AUTH
  if (mode === 'oauth') return true
  if (mode === 'apikey') return false
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)
}

// THROWS when it cannot answer; [] means the API answered and nothing usable exists
export async function listAnthropicModels(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
  if (useOAuth()) {
    headers.authorization = `Bearer ${await loadOAuthToken()}` // throws when no token is available
    headers['anthropic-beta'] = 'oauth-2025-04-20'
  } else {
    const key = process.env.ANTHROPIC_API_KEY
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set — cannot ask the anthropic models API')
    headers['x-api-key'] = key
  }
  const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', { headers })
  if (!res.ok) throw new Error(`anthropic /v1/models answered ${res.status}`)
  return modelIdsFrom(await res.json(), 'data', 'id')
}

export function createAnthropicProvider(
  costOverrides: Record<string, ModelCost> = {},
): ModelProvider<LanguageModel> {
  // placeholder key passes the SDK's header check; oauthFetch swaps in the Bearer, then caching marks
  const anthropic = useOAuth()
    ? createAnthropic({ apiKey: 'oauth-via-custom-fetch', fetch: oauthFetch(() => loadOAuthToken(), cachingFetch()) })
    : createAnthropic({ fetch: cachingFetch() }) // ANTHROPIC_API_KEY from env
  return {
    costs: { ...COSTS, ...costOverrides },
    languageModel: modelId => anthropic(modelId),
    listModels: () => listAnthropicModels(),
  }
}
