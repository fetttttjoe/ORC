import { describe, expect, it } from 'bun:test'
import { listOllamaModels } from './index'

describe('listOllamaModels', () => {
  it('parses /api/tags', async () => {
    expect(await listOllamaModels('http://x', async () =>
      Response.json({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen3:8b' }] }))).toEqual(['llama3.2:3b', 'qwen3:8b'])
  })

  it('THROWS when the daemon cannot answer — [] is reserved for "answered, nothing usable"', async () => {
    await expect(listOllamaModels('http://x', async () => { throw new Error('down') })).rejects.toThrow()
    await expect(listOllamaModels('http://x', async () => new Response('busy', { status: 503 }))).rejects.toThrow('503')
    await expect(listOllamaModels('http://x', async () => Response.json({ nope: true }))).rejects.toThrow('shape')
  })

  it('drops embedding-only models — they cannot run a task', async () => {
    expect(await listOllamaModels('http://x', async () =>
      Response.json({ models: [
        { name: 'qwen3:8b', capabilities: ['completion', 'tools'] },
        { name: 'nomic-embed-text:latest', capabilities: ['embedding'] },
        { name: 'from-an-older-daemon:latest' }, // no capabilities field — keep, never guess
      ] }))).toEqual(['qwen3:8b', 'from-an-older-daemon:latest'])
  })

  it('an embedding-only daemon yields a POSITIVE empty list, not an error', async () => {
    expect(await listOllamaModels('http://x', async () =>
      Response.json({ models: [{ name: 'all-minilm:latest', capabilities: ['embedding'] }] }))).toEqual([])
  })
})
