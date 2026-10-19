// The search seam, shaped like ModelProvider: adding Brave or Exa is a new
// implementation plus a registry entry, not another branch in the server.
import { z } from 'zod'
import { stripHtml } from './html-text'
import { USER_AGENT } from './net-guard'

// matched values, never scattered literals
export const SEARCH_BACKEND = { wikipedia: 'wikipedia', tavily: 'tavily' } as const
export type SearchBackendId = (typeof SEARCH_BACKEND)[keyof typeof SEARCH_BACKEND]

export interface SearchHit { title: string; url: string; snippet: string }

// `id` travels with the provider so a result can name the corpus it came from.
export interface SearchProvider {
  readonly id: SearchBackendId
  search(query: string, limit: number): Promise<SearchHit[]>
}

// Parsed, never asserted: an upstream shape change must fail here, not surface as undefined in a note.
const WikiResponse = z.object({
  query: z.object({ search: z.array(z.object({ title: z.string(), snippet: z.string() })).default([]) }).optional(),
})
const TavilyResponse = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), content: z.string() })).default([]),
})

const parseBody = <T>(schema: z.ZodType<T>, body: unknown, backend: SearchBackendId): T => {
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new Error(`${backend} returned an unexpected shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`)
  return parsed.data
}

// the citable article, not a search-results URL
const wikiArticleUrl = (title: string): string =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

// The default because it needs no account. Its snippets are HTML fragments, hence the strip.
export function createWikipediaSearch(): SearchProvider {
  return {
    id: SEARCH_BACKEND.wikipedia,
    async search(query, limit) {
      const api = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${encodeURIComponent(query)}`
      const r = await fetch(api, { headers: { 'User-Agent': USER_AGENT } })
      if (!r.ok) throw new Error(`wikipedia search HTTP ${r.status}`)
      const body = parseBody(WikiResponse, await r.json(), SEARCH_BACKEND.wikipedia)
      // stripHtml parses, so it is async — the snippets are independent, so strip them together
      return Promise.all((body.query?.search ?? []).map(async hit =>
        ({ title: hit.title, url: wikiArticleUrl(hit.title), snippet: await stripHtml(hit.snippet) })))
    },
  }
}

// The open web rather than one encyclopedia. `content` is already text.
export function createTavilySearch(apiKey: string): SearchProvider {
  return {
    id: SEARCH_BACKEND.tavily,
    async search(query, limit) {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, 'User-Agent': USER_AGENT },
        body: JSON.stringify({ query, max_results: limit }),
      })
      // names the variable, never the value
      if (r.status === 401 || r.status === 403)
        throw new Error('tavily rejected TAVILY_API_KEY (401/403) — rotate it, or unset it to use the keyless backend')
      if (!r.ok) throw new Error(`tavily search HTTP ${r.status}`)
      const body = parseBody(TavilyResponse, await r.json(), SEARCH_BACKEND.tavily)
      return body.results.map(hit => ({ title: hit.title, url: hit.url, snippet: hit.content }))
    },
  }
}

export type SearchEnv = Readonly<Record<string, string | undefined>>

// The composition root for this seam. Env arrives as a value so the choice is testable without
// mutating a global. A broken key fails loudly rather than downgrading:
// a run that silently changed corpus mid-way is worse than one that stops.
export function selectSearchProvider(env: SearchEnv): SearchProvider {
  const key = env.TAVILY_API_KEY?.trim() ?? ''
  return key === '' ? createWikipediaSearch() : createTavilySearch(key)
}
