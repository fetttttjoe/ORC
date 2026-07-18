import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { MemoryNoteInput, type MemoryNote, type MemoryStore, type NoteSummary } from '@orc/contracts'
import { memoryTools } from './tools'

const toNote = (input: z.input<typeof MemoryNoteInput>): MemoryNote =>
  ({ ...MemoryNoteInput.parse(input), createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1 })

const summary = (id: string, title: string): NoteSummary =>
  ({ id, title, summary: 's', categories: [], tags: [], scope: 'project' })

const fakeStore = (over: Partial<MemoryStore> = {}) => {
  const written: { input: MemoryNoteInput; author: unknown }[] = []
  const store: MemoryStore = {
    write: async (input, author) => { written.push({ input, author }); return toNote(input) },
    remove: async () => {},
    get: async () => toNote({ id: 'auth', title: 'Auth', body: 'b' }),
    list: async () => [],
    search: async () => [summary('auth', 'Auth')],
    neighbors: async () => [],
    ...over,
  }
  return { store, written }
}

describe('memory tools', () => {
  it('declares four tools; memory_write routes to the store with the bound author', async () => {
    const { store, written } = fakeStore()
    const tools = memoryTools(store, { source: 'agent', executor: 'api-loop', model: 'opus', role: 'review' })
    expect(tools.map(t => t.name).sort()).toEqual(['memory_neighbors', 'memory_read', 'memory_search', 'memory_write'])
    const write = tools.find(t => t.name === 'memory_write')!
    const r = await write.execute({ id: 'auth', title: 'Auth' })
    expect(r.isError).toBe(false)
    expect(written[0]?.author).toMatchObject({ executor: 'api-loop' })
  })

  it('budgets search results and reports truncation with a next hint', async () => {
    const { store } = fakeStore({ search: async () => Array.from({ length: 8 }, (_, i) => summary(`n${i}`, `T${i}`)) })
    const search = memoryTools(store, { source: 'cli' }).find(t => t.name === 'memory_search')!
    const r = await search.execute({ query: 'x', detail_level: 'minimal' })
    expect(r.output).toMatchObject({ truncated: true, omitted: 3 })
    const out = r.output as { notes: NoteSummary[]; next: string }
    expect(out.notes).toHaveLength(5)
    expect(out.next).toContain('memory_read')
  })

  it('memory_neighbors traverses from a seed and returns ranked neighbours', async () => {
    const { store } = fakeStore({ neighbors: async () => [{ id: 'b', title: 'B', summary: 's', via: 'supersedes', depth: 1, score: 1 }] })
    const nb = memoryTools(store, { source: 'cli' }).find(t => t.name === 'memory_neighbors')!
    const r = await nb.execute({ seed: 'a' })
    const out = r.output as { neighbors: { via: string }[] }
    expect(out.neighbors[0]?.via).toBe('supersedes')
  })

  it('memory_read minimal truncates the body to the budget', async () => {
    const { store } = fakeStore({ get: async () => toNote({ id: 'auth', title: 'Auth', body: 'x'.repeat(400) }) })
    const read = memoryTools(store, { source: 'cli' }).find(t => t.name === 'memory_read')!
    const r = await read.execute({ id: 'auth', detail_level: 'minimal', budget: 10 })
    const out = r.output as { note: MemoryNote; truncated: boolean }
    expect(out.note.body.length).toBeLessThanOrEqual(40)
    expect(out.truncated).toBe(true)
  })
})
