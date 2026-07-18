import { describe, expect, it } from 'bun:test'
import { memoryTools } from './tools'

const fakeStore = () => {
  const written: any[] = []
  return {
    store: {
      write: async (input: any, author: any) => { written.push({ input, author }); return { ...input, revision: 1 } },
      remove: async () => {}, get: async () => ({ id: 'auth', body: 'b' }),
      list: async () => [], search: async () => [{ id: 'auth', title: 'Auth' }],
    } as any,
    written,
  }
}

describe('memory tools', () => {
  it('declares three tools; memory_write routes to the store with the bound author', async () => {
    const { store, written } = fakeStore()
    const tools = memoryTools(store, { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' })
    expect(tools.map(t => t.name).sort()).toEqual(['memory_read', 'memory_search', 'memory_write'])
    const write = tools.find(t => t.name === 'memory_write')!
    const r = await write.execute({ id: 'auth', title: 'Auth' })
    expect(r.isError).toBe(false)
    expect(written[0].author.executor).toBe('api-loop')
  })
})
