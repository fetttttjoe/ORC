import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, type MemoryNote, type MemoryNoteDraft, type MemoryStore, type NoteSummary } from '@orc/contracts'
import { memoryTools, tierForRole } from './tools'

const toNote = (input: MemoryNoteDraft): MemoryNote =>
  ({ ...MemoryNoteInput.parse(input), createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1 })

const summary = (id: string, title: string): NoteSummary =>
  ({ id, title, summary: 's', categories: [], tags: [], scope: 'project' })

const fakeStore = (over: Partial<MemoryStore> = {}) => {
  const written: { input: MemoryNoteDraft; author: unknown; idempotencyKey?: string }[] = []
  const store: MemoryStore = {
    write: async (input, author, opts) => { written.push({ input, author, idempotencyKey: opts?.idempotencyKey }); return toNote(input) },
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

  it('memory_write derives an idempotency key from runToken + toolCallId; none without them', async () => {
    const { store, written } = fakeStore()
    const bound = memoryTools(store, { source: 'agent', runToken: 'step:t1:s1:a1' })
    const write = bound.find(t => t.name === 'memory_write')!
    await write.execute({ id: 'auth', title: 'Auth' }, 'call_9')
    expect(written[0]?.idempotencyKey).toBe('step:t1:s1:a1:tool:call_9:memory:auth')

    await write.execute({ id: 'auth', title: 'Auth' }) // no toolCallId (e.g. CLI path)
    expect(written[1]?.idempotencyKey).toBeUndefined()
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

  it('memory_read always truncates the body to the budget', async () => {
    const { store } = fakeStore({ get: async () => toNote({ id: 'auth', title: 'Auth', body: 'x'.repeat(400) }) })
    const read = memoryTools(store, { source: 'cli' }).find(t => t.name === 'memory_read')!
    const r = await read.execute({ id: 'auth', budget: 10 })
    const out = r.output as { note: MemoryNote; truncated: boolean }
    expect(out.note.body.length).toBeLessThanOrEqual(40)
    expect(out.truncated).toBe(true)
  })

  it('memory_neighbors passes scope through to the store', async () => {
    let seen: { scope?: string } | undefined
    const { store } = fakeStore({ neighbors: async (_seed, opts) => { seen = opts; return [] } })
    const nb = memoryTools(store, { source: 'cli' }).find(t => t.name === 'memory_neighbors')!
    const r = await nb.execute({ seed: 'net-topology', scope: 'infra' })
    expect(seen?.scope).toBe('infra')
    // zero-result absence epistemics (E-i): empty is "no note matched", not "no such decision"
    expect(r.output).toMatchObject({ note: "no note matched — absence is not proof a decision doesn't exist" })
  })

  it('memory_search with no matches includes the same absence-epistemics note', async () => {
    const { store } = fakeStore({ search: async () => [] })
    const search = memoryTools(store, { source: 'cli' }).find(t => t.name === 'memory_search')!
    const r = await search.execute({ query: 'nope' })
    expect(r.output).toMatchObject({ note: "no note matched — absence is not proof a decision doesn't exist" })
  })

  it('scout tier narrows the tool surface (authors notes, but never traverses); auditor keeps the full set', () => {
    const { store } = fakeStore()
    const scoutNames = memoryTools(store, { source: 'cli' }, 'scout').map(t => t.name).sort()
    expect(scoutNames).toEqual(['memory_read', 'memory_search', 'memory_write'])
    expect(scoutNames).not.toContain('memory_neighbors') // deliberate narrowing: scout seeds the graph, doesn't traverse it
    expect(memoryTools(store, { source: 'cli' }, 'auditor').map(t => t.name)).toContain('memory_neighbors')
  })

  it('scout tier appends the provisional-epistemics fragment to its three tools', () => {
    const { store } = fakeStore()
    const tools = memoryTools(store, { source: 'cli' }, 'scout')
    for (const t of tools) expect(t.description).toContain('provisional')
  })

  it('auditor tier appends the traverse-before-asserting fragment to the full surface', () => {
    const { store } = fakeStore()
    const tools = memoryTools(store, { source: 'cli' }, 'auditor')
    expect(tools).toHaveLength(4)
    for (const t of tools) expect(t.description).toContain('contradicts/supersedes before asserting')
  })

  it('verify tier (default and explicit) is byte-for-byte identical to today', () => {
    const { store } = fakeStore()
    const shape = (tools: ReturnType<typeof memoryTools>) => tools.map(t => ({ ref: t.ref, name: t.name, description: t.description, inputSchema: t.inputSchema }))
    const noTierArg = memoryTools(store, { source: 'cli' })
    const explicitVerify = memoryTools(store, { source: 'cli' }, 'verify')
    expect(shape(explicitVerify)).toEqual(shape(noTierArg))
  })

  it('tierForRole is the single source both prod (runtime.ts) and the grounded e2e derive tier from', () => {
    expect(tierForRole('scout')).toBe('scout')
    expect(tierForRole('auditor')).toBe('auditor')
    expect(tierForRole('implementer')).toBe('verify')
    expect(tierForRole('anything-else')).toBe('verify')
  })

  it('memory_write advertises rationale/uncertainty so a model can discover and set them', () => {
    const { store } = fakeStore()
    const write = memoryTools(store, { source: 'cli' }).find(t => t.name === 'memory_write')!
    const props = (write.inputSchema as { properties: Record<string, unknown> }).properties
    expect(props.rationale).toMatchObject({ type: 'string' })
    expect(props.uncertainty).toMatchObject({ type: 'array', items: { type: 'string' } })
  })
})
