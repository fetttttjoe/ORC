import { MemoryNoteInput, type MemoryAuthor, type MemoryFilter, type MemoryNote, type MemoryStore, type NoteSummary } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import type { SurrealMemory } from './surreal'

// The single writer (spec RM5). Writes are event-first via the NON-locking append (spec D2);
// the projector applies to SurrealDB. Reads hit SurrealDB directly.
export function createMemoryStore(opts: { log: EventLog; surreal: SurrealMemory; sourceRevision?: string | null }): MemoryStore {
  const { log, surreal } = opts
  return {
    async write(input, author, writeOpts) {
      const parsed = MemoryNoteInput.parse(input)        // reject malformed BEFORE appending
      // the gateway stamps the runtime's Git revision — agents cannot claim another one
      const note = { ...parsed, sourceRevision: opts.sourceRevision ?? null }
      await log.append({
        taskId: null, stepId: null, runToken: null, kind: 'memory_written',
        payload: { note, author }, idempotencyKey: writeOpts?.idempotencyKey ?? null,
      })
      // event-first: the record materializes via the projector shortly; return a best-effort
      // read (may be null within the flush window — callers treat write as fire-and-forget).
      return (await surreal.get(note.id, note.scope)) ?? { ...note, createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1 }
    },
    async remove(id, scope = 'project') {
      const author: MemoryAuthor = { source: 'cli' }
      await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_deleted', payload: { id, scope, author } })
    },
    async get(id, scope = 'project') {
      const n = await surreal.get(id, scope)
      if (n) await surreal.bumpRead(id, scope)
      return n
    },
    list: (filter?: MemoryFilter): Promise<NoteSummary[]> => surreal.list(filter),
    search: (query: string, filter?: MemoryFilter): Promise<NoteSummary[]> => surreal.search(query, filter),
    neighbors: (seed, opts) => surreal.neighbors(seed, opts),
  }
}
