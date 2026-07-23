import { createAnthropic } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import type { ModelCost, ModelProvider } from '@orc/contracts'
import { cachingFetch } from './cache'
import { loadOAuthToken, oauthFetch } from './oauth'

// narrow unknown JSON to an indexable object at the fetch boundary — no cast (repo rule: parse, don't assert)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// per-MTok pricing, verified 2026-07-17 (platform.claude.com/docs/en/pricing) — override via .orc/config.json
// cache rates: reads 0.1× input, 5m-TTL writes 1.25× input (platform.claude.com/docs pricing)
const COSTS: Record<string, ModelCost> = {
  'claude-fable-5': { inPerMTok: 10, outPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
  'claude-opus-4-8': { inPerMTok: 5, outPerMTok: 25, cacheReadPerMTok: 0.5, cacheWritePerMTok: 6.25 },
  'claude-sonnet-5': { inPerMTok: 3, outPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  'claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 },
}

// OAuth (Claude subscription) is opt-in: explicit ORC_ANTHROPIC_AUTH, or the presence of a
// CLAUDE_CODE_OAUTH_TOKEN as an unambiguous signal. Default is API-key.
function useOAuth(): boolean {
  const mode = process.env.ORC_ANTHROPIC_AUTH
  if (mode === 'oauth') return true
  if (mode === 'apikey') return false
  return Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN)
}

// live model discovery — works on both auth paths; falls back to the cost-table ids offline.
// fetch is injectable for tests.
export async function listAnthropicModels(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  try {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' }
    if (useOAuth()) {
      headers.authorization = `Bearer ${await loadOAuthToken()}`
      headers['anthropic-beta'] = 'oauth-2025-04-20'
    } else {
      headers['x-api-key'] = process.env.ANTHROPIC_API_KEY ?? ''
    }
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=100', { headers })
    if (!res.ok) return Object.keys(COSTS)
    const body: unknown = await res.json()
    const data: unknown[] = isRecord(body) && Array.isArray(body.data) ? body.data : []
    const ids = data.map(m => (isRecord(m) ? m.id : undefined)).filter((id): id is string => typeof id === 'string')
    return ids.length > 0 ? ids : Object.keys(COSTS)
  } catch {
    return Object.keys(COSTS)
  }
}

export function createAnthropicProvider(
  costOverrides: Record<string, ModelCost> = {},
): ModelProvider<LanguageModel> {
  // The SDK resolves an API key while building headers, before our fetch runs, and throws if
  // none exists. The placeholder satisfies that check; oauthFetch strips the x-api-key header it
  // produces and substitutes the real Bearer token (read fresh per request).
  // prompt caching on BOTH auth paths: oauthFetch rewrites the body (identity block) first,
  // then cachingFetch marks the final shape — so breakpoints land on what is actually sent.
  const anthropic = useOAuth()
    ? createAnthropic({ apiKey: 'oauth-via-custom-fetch', fetch: oauthFetch(() => loadOAuthToken(), cachingFetch()) })
    : createAnthropic({ fetch: cachingFetch() }) // ANTHROPIC_API_KEY from env
  return {
    costs: { ...COSTS, ...costOverrides },
    languageModel: modelId => anthropic(modelId),
    listModels: () => listAnthropicModels(),
  }
}
