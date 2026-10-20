// Two ephemeral breakpoints make each loop iteration a cache read of the shared prefix
import { isRecord } from '@orc/contracts'
import { asFetch, type MinimalFetch } from './fetch-shim'

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
  return asFetch(wrapped)
}
