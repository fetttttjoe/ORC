import { test, expect } from 'bun:test'
import { markCacheBreakpoints, cachingFetch } from './cache'

test('marks last system block and last message content block, idempotently', () => {
  const json: Record<string, unknown> = {
    system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q1' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }, { type: 'tool_result', content: 'r' }] },
    ],
  }
  markCacheBreakpoints(json)
  markCacheBreakpoints(json) // idempotent — no double markers
  const sys = json.system as Array<Record<string, unknown>>
  expect(sys[0]!.cache_control).toBeUndefined()
  expect(sys[1]!.cache_control).toEqual({ type: 'ephemeral' })
  const msgs = json.messages as Array<{ content: Array<Record<string, unknown>> }>
  expect(msgs[0]!.content[0]!.cache_control).toBeUndefined()
  expect(msgs[1]!.content[0]!.cache_control).toBeUndefined()
  expect(msgs[1]!.content[1]!.cache_control).toEqual({ type: 'ephemeral' })
})

test('string content and non-JSON bodies pass through untouched', async () => {
  const json: Record<string, unknown> = { system: 'plain', messages: [{ role: 'user', content: 'hi' }] }
  markCacheBreakpoints(json)
  expect(json.system).toBe('plain')
  expect((json.messages as Array<{ content: unknown }>)[0]!.content).toBe('hi')

  let seen: RequestInit | undefined
  const f = cachingFetch(async (_i, init) => { seen = init; return new Response('{}') })
  await f('https://x.test', { body: 'not-json{', method: 'POST' })
  expect(seen!.body).toBe('not-json{')
})

test('composition: oauthFetch rewrites the body, then cachingFetch marks the FINAL shape', async () => {
  const { oauthFetch } = await import('./oauth')
  let seen!: { headers: Headers; body: { system: Array<Record<string, unknown>>; messages: Array<{ content: Array<Record<string, unknown>> }> } }
  const capture = async (_i: RequestInfo | URL, init?: RequestInit) => {
    seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }
    return new Response('{}')
  }
  // index.ts wiring order: oauthFetch(getToken, cachingFetch(base))
  const chain = oauthFetch(async () => 'tok', cachingFetch(capture))
  await chain('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': 'x' },
    body: JSON.stringify({ system: 'user system', messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }),
  })
  expect(seen.headers.get('authorization')).toBe('Bearer tok')
  const sys = seen.body.system
  expect((sys[0] as { text: string }).text).toContain('Claude Code')      // identity prepended first
  expect(sys[sys.length - 1]!.cache_control).toEqual({ type: 'ephemeral' }) // cache marks the final shape
  const content = seen.body.messages[0]!.content
  expect(content[content.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
})
