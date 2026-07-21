import { describe, expect, it } from 'bun:test'
import { listAnthropicModels } from './index'

describe('listAnthropicModels', () => {
  it('parses the models API shape', async () => {
    const models = await listAnthropicModels(async () =>
      Response.json({ data: [{ id: 'claude-x-1' }, { id: 'claude-y-2' }, { broken: true }] }))
    expect(models).toEqual(['claude-x-1', 'claude-y-2'])
  })
  it('falls back to the cost-table ids when the API is unreachable or empty', async () => {
    const down = await listAnthropicModels(async () => { throw new Error('offline') })
    expect(down.length).toBeGreaterThan(0)
    expect(down.every(id => id.startsWith('claude-'))).toBe(true)
    const empty = await listAnthropicModels(async () => Response.json({ data: [] }))
    expect(empty).toEqual(down)
  })
})
