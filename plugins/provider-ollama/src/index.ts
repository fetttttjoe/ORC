import { createOllama } from 'ai-sdk-ollama'
import type { LanguageModel } from 'ai'
import { isRecord, modelIdsFrom, type EmbeddingProvider, type ModelCost, type ModelProvider } from '@orc/contracts'

// live model discovery from the local daemon — [] when it is not running (fetch injectable for tests)
export async function listOllamaModels(baseUrl: string, fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`)
    if (!res.ok) return []
    return modelIdsFrom(await res.json(), 'models', 'name')
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

const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(x => typeof x === 'number')

// The embedding half of the Ollama provider — a text→vector encoder over the local daemon's
// /api/embed, behind the shared EmbeddingProvider seam. No SDK, no new dep: one fetch, parsed at
// the boundary (isRecord/isNumberArray, never a cast) exactly like listOllamaModels.
export function createOllamaEmbeddingProvider(
  opts: { model: string; baseUrl?: string },
): EmbeddingProvider {
  const baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')
  return {
    async embed(texts) {
      if (texts.length === 0) return []
      const res = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, input: texts }),
      })
      if (!res.ok) throw new Error(`ollama embed ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
      const body: unknown = await res.json()
      const rows: unknown = isRecord(body) ? body.embeddings : undefined
      if (!Array.isArray(rows)) throw new Error('ollama embed: response missing embeddings array')
      return rows.map(r => {
        if (!isNumberArray(r)) throw new Error('ollama embed: a returned embedding is not a number array')
        return r
      })
    },
  }
}
