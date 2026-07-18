import type { MemoryAuthor, MemoryStore, ResolvedTool } from '@orc/contracts'

const ok = (output: unknown) => ({ output, isError: false })
const err = (e: unknown) => ({ output: { error: e instanceof Error ? e.message : String(e) }, isError: true })

// Injected as ResolvedTool[] via the same channel MCP tools use. Author is bound per step.
export function memoryTools(store: MemoryStore, author: MemoryAuthor): ResolvedTool[] {
  return [
    {
      ref: 'memory/write', name: 'memory_write',
      description: 'Create or update a project knowledge note (upsert by id). Record durable findings/decisions/conventions so later steps reuse them.',
      inputSchema: {
        type: 'object', required: ['id', 'title'],
        properties: {
          id: { type: 'string', description: 'stable slug ^[a-z0-9][a-z0-9-]*$' },
          title: { type: 'string' }, summary: { type: 'string' }, body: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          links: { type: 'array', items: { type: 'string' }, description: 'ids of related notes' },
          paths: { type: 'array', items: { type: 'string' }, description: 'code paths this note refers to' },
          rules: { type: 'array', items: { type: 'string' } },
          scope: { type: 'string' },
        },
      },
      execute: async input => { try { const n = await store.write(input as any, author); return ok({ id: n.id, revision: n.revision }) } catch (e) { return err(e) } },
    },
    {
      ref: 'memory/search', name: 'memory_search',
      description: 'Search project knowledge by keyword. Returns note summaries (id, title, categories, tags, summary). Read the full note with memory_read.',
      inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, category: { type: 'string' }, tag: { type: 'string' } } },
      execute: async input => { try { const q = input as any; return ok({ notes: await store.search(q.query, { category: q.category, tag: q.tag }) }) } catch (e) { return err(e) } },
    },
    {
      ref: 'memory/read', name: 'memory_read',
      description: 'Read one project knowledge note in full by id.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, scope: { type: 'string' } } },
      execute: async input => { try { const q = input as any; const n = await store.get(q.id, q.scope); return n ? ok({ note: n }) : ok({ note: null }) } catch (e) { return err(e) } },
    },
  ]
}
