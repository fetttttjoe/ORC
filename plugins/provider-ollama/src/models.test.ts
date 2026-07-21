import { describe, expect, it } from 'bun:test'
import { listOllamaModels } from './index'

describe('listOllamaModels', () => {
  it('parses /api/tags and returns [] when the daemon is down', async () => {
    expect(await listOllamaModels('http://x', async () =>
      Response.json({ models: [{ name: 'llama3.2:3b' }, { name: 'qwen3:8b' }] }))).toEqual(['llama3.2:3b', 'qwen3:8b'])
    expect(await listOllamaModels('http://x', async () => { throw new Error('down') })).toEqual([])
  })
})
