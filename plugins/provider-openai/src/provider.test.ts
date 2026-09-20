import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText, tool } from 'ai'
import { z } from 'zod'
import { createOpenAIProvider } from './index'
import { credentialHeaders } from './auth'
import { CODEX_PRESET, OpenAIAuth, openAIOptions } from './options'
import { providerFetch } from './transport'

const dirs: string[] = []
const savedKey = process.env.ORC_TEST_PROVIDER_KEY
afterEach(async () => {
  if (savedKey === undefined) delete process.env.ORC_TEST_PROVIDER_KEY
  else process.env.ORC_TEST_PROVIDER_KEY = savedKey
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function credentials(token = 'test-token') {
  const dir = await mkdtemp(join(tmpdir(), 'orc-codex-auth-'))
  dirs.push(dir)
  await writeFile(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: 'test-account' } }))
  return dir
}

const completed = (output: unknown[] = [{ type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }]) => ({
  id: 'resp_test', object: 'response', created_at: 1, model: 'test-model', status: 'completed',
  output, usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, error: null, incomplete_details: null,
})

function events(value: unknown) {
  const bytes = new TextEncoder().encode(`: comment\r\n\r\ndata: ${JSON.stringify({ type: 'response.completed', response: value })}\r\n\r\n`)
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let n = 0; n < bytes.length; n += 7) controller.enqueue(bytes.slice(n, n + 7))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'test-request' } })
}

test('a preset keeps its endpoint, authentication and transport settings when options are omitted', () => {
  const options = openAIOptions({ preset: CODEX_PRESET })
  expect(options.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
  expect(options.auth).toBe(OpenAIAuth.codex)
  expect(options.streamOnly).toBe(true)
  expect(options.providerOptions).toEqual({ store: false, instructions: '' })
})

test('configured discovery and SDK generation use the same endpoint and fresh credentials', async () => {
  process.env.ORC_TEST_PROVIDER_KEY = 'first-key'
  const calls: Array<{ url: string; authorization: string | null }> = []
  const provider = createOpenAIProvider({}, { baseUrl: 'https://example.test/v1', apiKeyEnv: 'ORC_TEST_PROVIDER_KEY' }, async (url, init) => {
    calls.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') })
    return String(url).endsWith('/models') ? Response.json({ data: [{ id: 'test-model' }] }) : Response.json(completed())
  })
  expect(await provider.listModels?.()).toEqual(['test-model'])
  process.env.ORC_TEST_PROVIDER_KEY = 'rotated-key'
  const result = await generateText({ model: provider.languageModel('test-model'), prompt: 'Hello', maxRetries: 0 })
  expect(result.text).toBe('Hello')
  expect(calls).toEqual([
    { url: 'https://example.test/v1/models', authorization: 'Bearer first-key' },
    { url: 'https://example.test/v1/responses', authorization: 'Bearer rotated-key' },
  ])
})

test('the Codex preset discovers visible models and returns SDK tool calls through streaming-only HTTP', async () => {
  const codexHome = await credentials()
  const requests: Record<string, unknown>[] = []
  const provider = createOpenAIProvider({}, { preset: CODEX_PRESET, codexHome }, async (url, init) => {
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer test-token')
    expect(headers.get('ChatGPT-Account-Id')).toBe('test-account')
    if (String(url).includes('/models?')) return Response.json({ models: [{ slug: 'test-model', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] })
    const body = z.string().parse(init?.body)
    requests.push(z.record(z.string(), z.unknown()).parse(JSON.parse(body)))
    return events(completed([{ type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'lookup', arguments: '{"query":"hello"}', status: 'completed' }]))
  })
  expect(await provider.listModels?.()).toEqual(['test-model'])
  const result = await generateText({
    model: provider.languageModel('test-model'), prompt: 'Find hello', maxOutputTokens: 100, maxRetries: 0,
    tools: { lookup: tool({ inputSchema: z.object({ query: z.string() }) }) },
  })
  expect(result.toolCalls.map(call => ({ name: call.toolName, input: call.input }))).toEqual([{ name: 'lookup', input: { query: 'hello' } }])
  expect(requests[0]?.stream).toBe(true)
  expect(requests[0]?.store).toBe(false)
  expect(requests[0]?.instructions).toBe('')
  expect(requests[0]).not.toHaveProperty('max_output_tokens')
})

test('streaming callers keep their stream and HTTP failures keep status and retry headers', async () => {
  const options = openAIOptions({ auth: OpenAIAuth.none, streamOnly: true })
  const stream = events(completed())
  expect(await providerFetch(options, async () => stream)('https://example.test', { body: '{"stream":true}' })).toBe(stream)
  const limited = new Response('limited', { status: 429, headers: { 'retry-after': '30' } })
  expect(await providerFetch(options, async () => limited)('https://example.test', { body: '{}' })).toBe(limited)
  const incomplete = new Response('data: {"type":"response.created"}\n\n')
  await expect(providerFetch(options, async () => incomplete)('https://example.test', { body: '{}' })).rejects.toThrow('terminal response')
})

test('expired credentials fail before sending a request and a refreshed file is read on the next call', async () => {
  const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.signature`
  const codexHome = await credentials(expired)
  const options = openAIOptions({ preset: CODEX_PRESET, codexHome })
  await expect(credentialHeaders(options)).rejects.toThrow('expired')
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'refreshed', account_id: 'test-account' } }))
  expect((await credentialHeaders(options)).get('authorization')).toBe('Bearer refreshed')
})
