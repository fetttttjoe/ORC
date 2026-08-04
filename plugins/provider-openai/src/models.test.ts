import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { listOpenAIModels } from './index'

// listModels contract (packages/contracts/src/execution.ts): REJECT when the API cannot answer;
// [] is reserved for "answered, nothing usable". openai ships no static cost table, so a
// swallowed blip here read as reachable-and-empty and discovery's append-on-change recorded
// models: [] over the real catalog — the exact failure the ollama flip (2026-08-03) exists to kill.
describe('listOpenAIModels', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = 'test-key'
  })
  afterEach(() => {
    if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY
  })

  it('parses /v1/models', async () => {
    expect(await listOpenAIModels(async () =>
      Response.json({ data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { broken: true }] }))).toEqual(['gpt-5', 'gpt-5-mini'])
  })

  it('THROWS when the API cannot answer — [] is reserved for "answered, nothing usable"', async () => {
    await expect(listOpenAIModels(async () => { throw new Error('down') })).rejects.toThrow()
    await expect(listOpenAIModels(async () => new Response('busy', { status: 503 }))).rejects.toThrow('503')
    await expect(listOpenAIModels(async () => new Response('<html>oops</html>'))).rejects.toThrow()
    await expect(listOpenAIModels(async () => Response.json({ nope: true }))).rejects.toThrow('data')
  })

  it('THROWS when no API key is set — cannot ask is not an empty catalog', async () => {
    delete process.env.OPENAI_API_KEY
    await expect(listOpenAIModels(async () => Response.json({ data: [] }))).rejects.toThrow('OPENAI_API_KEY')
  })

  it('a genuinely empty model list is a POSITIVE empty list, not an error', async () => {
    expect(await listOpenAIModels(async () => Response.json({ data: [] }))).toEqual([])
  })
})
