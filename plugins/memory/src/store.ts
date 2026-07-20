import { EVENT_KIND, MemoryNoteInput, type MemoryAuthor, type MemoryFilter, type MemoryNote, type MemoryStore, type NoteSummary } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import type { SurrealMemory } from './surreal'

// The single writer (spec RM5). Writes are event-first appends — like every append they
// serialize on the per-project advisory lock; the projector applies to SurrealDB. Reads
// hit SurrealDB directly.
export function createMemoryStore(opts: { log: EventLog; surreal: SurrealMemory; sourceRevision?: string | null }): MemoryStore {
  const { log, surreal } = opts
  return {
    async write(input, author, writeOpts) {
      const parsed = MemoryNoteInput.parse(input)        // reject malformed BEFORE appending
      // the gateway stamps the runtime's Git revision — agents cannot claim another one
      const note = { ...parsed, sourceRevision: opts.sourceRevision ?? null }
      try {
        await log.append({
          taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
          payload: { note, author }, idempotencyKey: writeOpts?.idempotencyKey ?? null,
        })
      } catch (err) {
        // A keyed replay whose payload differs only in the gateway stamp (a new HEAD after a
        // restart) is still the SAME tool call: the first committed write stands, this one
        // must not fail the surrounding operation.
        const conflicted = writeOpts?.idempotencyKey
          && err instanceof Error && err.message.includes('reused with different event data')
        if (!conflicted) throw err
      }
      // event-first: the record materializes via the projector shortly; return a best-effort
      // read (may be null within the flush window — callers treat write as fire-and-forget).
      // retrievedAt is blank here for the same reason createdAt is: the projector stamps it from
      // the committed event, and within the flush window this shape has no event to read.
      return (await surreal.get(note.id, note.scope)) ?? {
        ...note,
        sources: note.sources.map(s => ({ ...s, retrievedAt: '' })),
        createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1,
      }
    },
    async remove(id, scope = 'project') {
      const author: MemoryAuthor = { source: 'cli' }
      await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id, scope, author } })
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
