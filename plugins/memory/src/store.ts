import { EVENT_KIND, MemoryNoteInput, MemoryScope, type MemoryAuthor, type MemoryFilter, type MemoryNote, type MemoryStore, type NoteSummary } from '@orc/contracts'
import type { EventLog } from '@orc/kernel'
import type { SurrealMemory } from './surreal'

// The single writer (spec RM5). Writes are event-first appends — like every append they
// serialize on the per-project advisory lock; the projector applies to SurrealDB. Reads
// hit SurrealDB directly.
export function createMemoryStore(opts: { log: EventLog; surreal: SurrealMemory; sourceRevision?: string | null }): MemoryStore {
  const { log, surreal } = opts
  return {
    async write(input, author, writeOpts) {
      // merge-on-omit upsert: fields the writer did not supply carry the previous revision's
      // values forward — zod defaults otherwise turn every omission into a destructive clear
      // (a refresh agent omitting `body` silently wiped three area notes' bodies). An EXPLICIT
      // empty (''/[]) still clears; undefined-valued keys count as omissions (CLI optional
      // flags arrive that way). Unknown keys on the merge base (createdAt, revision, …) are
      // stripped by the schema parse.
      // ponytail: the merge base reads the projector, which may lag one flush behind the log —
      // fold the base from the event log instead if rapid same-note rewrites ever matter.
      const supplied = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
      const existing = typeof input.id === 'string'
        ? await surreal.get(input.id, typeof supplied.scope === 'string' ? supplied.scope : MemoryScope.project)
        : null
      const parsed = MemoryNoteInput.parse(existing ? { ...existing, ...supplied } : input) // reject malformed BEFORE appending
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
    // optional author: cancel-sweep passes the cancelled task's identity as provenance
    async remove(id, scope = MemoryScope.project, author?: MemoryAuthor) {
      await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id, scope, author: author ?? { source: 'cli' } } })
    },
    get: (id, scope = MemoryScope.project) => surreal.get(id, scope),
    // The access counter is event-sourced like everything else, so this is an append, not a
    // Surreal write — the projector is still the only thing that touches the read model.
    async recordAccess(id, scope = MemoryScope.project, mode, author) {
      await log.append({
        // envelope binds the access to the acting step when the author carries one — per-task
        // pull counts fold from the envelope instead of payload archaeology (P5 token-economy)
        // `|| null`, not `?? null`: an empty-string id would fail the envelope's min(1) and
        // turn a memory read into a tool error — normalize falsy to unbound instead
        taskId: author?.taskId || null, stepId: author?.stepId || null, runToken: author?.runToken || null,
        kind: EVENT_KIND.memory_accessed,
        payload: { id, scope, mode, author },
      })
    },
    list: (filter?: MemoryFilter): Promise<NoteSummary[]> => surreal.list(filter),
    search: (query: string, filter?: MemoryFilter): Promise<NoteSummary[]> => surreal.search(query, filter),
    neighbors: (seed, opts) => surreal.neighbors(seed, opts),
  }
}
