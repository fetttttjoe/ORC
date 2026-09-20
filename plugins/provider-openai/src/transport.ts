import { z } from 'zod'
import { credentialHeaders } from './auth'
import type { OpenAIOptions } from './options'

export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const RequestBody = z.record(z.string(), z.unknown())
const Event = z.object({ type: z.string(), response: z.record(z.string(), z.unknown()).optional() })
const TERMINAL_EVENTS = new Set(['response.completed', 'response.incomplete', 'response.failed'])

async function completedResponse(response: Response): Promise<Response> {
  if (!response.body) throw new Error('Streaming provider returned no response body')
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += value ?? ''
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() ?? ''
      for (const event of events) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data || data === '[DONE]') continue
        const parsed = Event.parse(JSON.parse(data))
        if (TERMINAL_EVENTS.has(parsed.type) && parsed.response) {
          const headers = new Headers(response.headers)
          headers.set('content-type', 'application/json')
          headers.delete('content-length')
          headers.delete('content-encoding')
          return Response.json(parsed.response, { status: response.status, headers })
        }
      }
      if (done) throw new Error('Streaming provider ended before a terminal response event')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function providerFetch(options: OpenAIOptions, fetchImpl: ProviderFetch = fetch): typeof fetch {
  const wrapped: ProviderFetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    headers.delete('authorization')
    for (const [name, value] of await credentialHeaders(options)) headers.set(name, value)
    let body = init?.body
    let convert = false
    if (typeof body === 'string') {
      const parsed = RequestBody.parse(JSON.parse(body))
      convert = options.streamOnly && parsed.stream !== true
      if (options.streamOnly) parsed.stream = true
      for (const field of options.omitRequestFields) delete parsed[field]
      body = JSON.stringify(parsed)
      headers.delete('content-length')
    }
    const response = await fetchImpl(input, { ...init, headers, body })
    return convert && response.ok ? completedResponse(response) : response
  }
  return Object.assign(wrapped, { preconnect: () => {} })
}
