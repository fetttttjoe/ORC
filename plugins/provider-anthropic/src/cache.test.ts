import { test, expect } from 'bun:test'
import { isRecord } from '@orc/contracts'
import { markCacheBreakpoints, cachingFetch } from './cache'

// Anthropic request `system`/`content` are arrays of plain JSON blocks; narrow at the read
// boundary instead of casting, so a wrong shape fails the check rather than lying about it.
const blockArray = (v: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(v) || !v.every(isRecord)) throw new Error('expected an array of JSON blocks')
  return v
}

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
  const sys = blockArray(json.system)
  expect(sys[0]!.cache_control).toBeUndefined()
  expect(sys[1]!.cache_control).toEqual({ type: 'ephemeral' })
  const msgs = blockArray(json.messages)
  expect(blockArray(msgs[0]!.content)[0]!.cache_control).toBeUndefined()
  expect(blockArray(msgs[1]!.content)[0]!.cache_control).toBeUndefined()
  expect(blockArray(msgs[1]!.content)[1]!.cache_control).toEqual({ type: 'ephemeral' })
})

test('string content and non-JSON bodies pass through untouched', async () => {
  const json: Record<string, unknown> = { system: 'plain', messages: [{ role: 'user', content: 'hi' }] }
  markCacheBreakpoints(json)
  expect(json.system).toBe('plain')
  expect(blockArray(json.messages)[0]!.content).toBe('hi')

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
  expect(sys[0]!.text).toContain('Claude Code')      // identity prepended first
  expect(sys[sys.length - 1]!.cache_control).toEqual({ type: 'ephemeral' }) // cache marks the final shape
  const content = seen.body.messages[0]!.content
  expect(content[content.length - 1]!.cache_control).toEqual({ type: 'ephemeral' })
})
