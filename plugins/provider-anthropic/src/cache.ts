// Anthropic prompt caching, injected at the fetch seam — same pattern as oauth.ts: the executor
// stays provider-agnostic and the change never leaves this plugin. Every agent-loop iteration
// re-sends the whole conversation; marking two ephemeral breakpoints (last system block + last
// content block of the last message) makes each iteration a cache READ of the shared prefix
// instead of full-price input. Anthropic allows 4 breakpoints; we use 2. Requests below the
// model's minimum cacheable prefix are unaffected (the marker is ignored server-side).
import { isRecord } from '@orc/contracts'

type MinimalFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function markCacheBreakpoints(json: Record<string, unknown>): void {
  const sys = json.system
  if (Array.isArray(sys) && sys.length > 0) {
    const last = sys[sys.length - 1]
    if (isRecord(last)) last.cache_control ??= { type: 'ephemeral' }
  }
  const msgs = json.messages
  if (Array.isArray(msgs) && msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1]
    const content = isRecord(lastMsg) ? lastMsg.content : undefined
    if (Array.isArray(content) && content.length > 0) {
      const last = content[content.length - 1]
      if (isRecord(last)) last.cache_control ??= { type: 'ephemeral' }
    }
  }
}

export function cachingFetch(baseFetch: MinimalFetch = fetch): typeof fetch {
  const wrapped: MinimalFetch = async (input, init) => {
    const body = init?.body
    if (typeof body === 'string') {
      try {
        const json: unknown = JSON.parse(body)
        if (isRecord(json)) {
          markCacheBreakpoints(json)
          const headers = new Headers(init?.headers)
          headers.delete('content-length') // body may have grown — let the runtime recompute
          return baseFetch(input, { ...init, headers, body: JSON.stringify(json) })
        }
      } catch {
        // non-JSON body: pass through untouched
      }
    }
    return baseFetch(input, init)
  }
  return Object.assign(wrapped, { preconnect: () => {} })
}
