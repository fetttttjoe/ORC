import { ClaimWrite, EVENT_KIND, MemoryNoteInput, MemoryScope, MemoryWrittenPayload, NOTE_TIER, resolveClaims, type MemoryAuthor, type MemoryFilter, type MemorySearchOpts, type MemoryNote, type MemoryStore, type NoteSummary, type Claim, type ClaimHit, type Topic } from '@orc/contracts'
import { KERNEL_ERROR_CODE, KernelError, type EventLog } from '@orc/kernel'
import type { SurrealMemory } from './surreal'

// The single writer (spec RM5). Writes are event-first appends — like every append they
// serialize on the per-project advisory lock; the projector applies to SurrealDB. Reads
// hit SurrealDB directly.
// `sourceRevision` is a PROVIDER, not a value: resolving it shells out to git, and only a write
// consumes it — every read path would otherwise pay a subprocess spawn for a field it never reads.
export function createMemoryStore(opts: { log: EventLog; surreal: SurrealMemory; sourceRevision?: () => Promise<string | null>; halfLifeDays?: number }): MemoryStore {
  const { log, surreal } = opts
  // Resolved PER WRITE, never memoized. Caching it across the store's lifetime looked like an
  // obvious saving — only writes read it, and it shells out to git — but a supervisor is a
  // long-lived process: `orc serve` booting at C0 stamped every note and every claim written for
  // the next N hours with C0, in the immutable log, where no rebuild heals it. Everything built on
  // this field then lies: drift reports moved code as current (the note claims a commit from before
  // the change), the preload tells a step to trust it, and the rewrite loop that is supposed to
  // clear drift re-stamps the same stale commit. The spawn is bounded by write frequency, and it
  // already runs OUTSIDE the project write lock (see the call below), so it blocks nothing.
  const sourceRevision = (): Promise<string | null> => opts.sourceRevision?.() ?? Promise.resolve(null)
  return {
    async write(input, author, writeOpts) {
      // merge-on-omit upsert: fields the writer did not supply carry the previous revision's
      // values forward — zod defaults otherwise turn every omission into a destructive clear
      // (a refresh agent omitting `body` silently wiped three area notes' bodies). An EXPLICIT
      // empty (''/[]) still clears; undefined-valued keys count as omissions (CLI optional
      // flags arrive that way). Unknown keys on the merge base (createdAt, revision, …) are
      // stripped by the schema parse.
      const supplied = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
      const scope = typeof supplied.scope === 'string' ? supplied.scope : MemoryScope.project
      // Claims are additive. Both instructions are parsed off the one surface they arrive on, so
      // neither needs a hand-rolled shape check; `addClaims` rides the draft and `invalidates` the
      // opts, and the note parse below strips both as unknown keys — which is why an instruction
      // can never reach the payload as a stored field.
      const claimWrite = ClaimWrite.parse({ ...input, ...writeOpts })
      // resolved BEFORE the transaction: a git spawn must never run inside the project write lock
      const stampedRevision = await sourceRevision()
      // Merge base from the EVENT LOG inside the append transaction, never from the async
      // projection. Two writes to one note inside the projector's flush window would otherwise merge
      // against a stale base and append REGRESSED field values into the canonical log — corruption
      // every rebuild faithfully reproduces (the projection heals; the log does not). read + merge +
      // append are atomic under the project advisory lock.
      //
      // ONE indexed row, not a fold of every memory event: this runs while holding the per-project
      // lock, which serializes every other writer in the project, and ambient capture now writes a
      // note per step — so a scan here would grow with exactly the thing the graph is meant to do.
      const note = await log.transaction(async tx => {
        const latest = typeof input.id === 'string' ? await tx.latestNoteEvent(scope, input.id) : null
        const written = latest?.kind === EVENT_KIND.memory_written
          ? MemoryWrittenPayload.safeParse(latest.payload)
          : null
        const existing = written?.success ? written.data.note : null
        // the live set the tier actually owns — a plan or episodic note has no claims to carry
        const live = existing?.tier === NOTE_TIER.semantic ? existing.claims : []
        const claims = resolveClaims(live, claimWrite.addClaims, claimWrite.invalidates, stampedRevision)
        // reject malformed BEFORE appending. `claims` is passed explicitly rather than merged: it is
        // already resolved against the live set, so merge-on-omit must not reach it.
        const parsed = MemoryNoteInput.parse(existing ? { ...existing, ...supplied, claims } : { ...input, claims })
        // Only the semantic tier has a `claims` column, so the parse above SILENTLY DROPS a
        // resolved claim set on a plan or episodic note — and the caller was told the write
        // succeeded. Reachable without meaning to: inferTier returns `plan` for any non-empty
        // `rationale`, and rationale sits beside addClaims in the same tool schema while the
        // knowledge protocol tells every agent to state durable facts as claims. The statement then
        // exists nowhere — not in the note, not in the claim table, not as an error.
        // Thrown, not warned: a lost fact is not something the writer can discover later.
        if (claims.length > 0 && parsed.tier !== NOTE_TIER.semantic)
          throw new Error(`claims are a semantic-tier fact and this note resolved to tier '${parsed.tier}' — a plan note's reasoning belongs in \`rationale\`, and a durable statement belongs on a semantic note (drop \`rationale\`, or write the claims to a separate note)`)
        // the gateway stamps the runtime's Git revision — agents cannot claim another one
        const merged = { ...parsed, sourceRevision: stampedRevision }
        try {
          await tx.append({
            taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
            // the tombstone is stated on the EVENT: the note carries live claims only, and folding
            // the log is what recovers a retired claim and the write that retired it
            payload: { note: merged, author, invalidates: claimWrite.invalidates },
            idempotencyKey: writeOpts?.idempotencyKey ?? null,
          })
        } catch (err) {
          // A key identifies one tool call, so a keyed replay is that call arriving twice and the
          // FIRST committed write stands — whatever the replay's payload says. In practice they
          // differ only by the gateway's HEAD stamp (a restart moved it), but the rule is the key,
          // not the diff: this must not fail the surrounding operation either way.
          const conflicted = writeOpts?.idempotencyKey
            && err instanceof KernelError && err.code === KERNEL_ERROR_CODE.idempotency_conflict
          if (!conflicted) throw err
        }
        return merged
      })
      // event-first: the record materializes via the projector shortly; return a best-effort
      // read (may be null within the flush window — callers treat write as fire-and-forget).
      // retrievedAt is blank here for the same reason createdAt is: the projector stamps it from
      // the committed event, and within the flush window this shape has no event to read.
      const projected = await surreal.get(note.id, note.scope)
      if (projected) return projected
      const stamped = { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1 }
      // only the semantic tier cites; the other two have no sources field to stamp
      return note.tier === NOTE_TIER.semantic
        ? { ...note, ...stamped, sources: note.sources.map(s => ({ ...s, retrievedAt: '' })) }
        : { ...note, ...stamped }
    },
    // optional author: cancel-sweep passes the cancelled task's identity as provenance
    async remove(id, scope = MemoryScope.project, author?: MemoryAuthor) {
      await log.append({ taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_deleted, payload: { id, scope, author: author ?? { source: 'cli' } } })
    },
    get: (id, scope = MemoryScope.project) => surreal.get(id, scope),
    // The access counter is event-sourced like everything else, so this is an append, not a
    // Surreal write — the projector is still the only thing that touches the read model.
    async recordAccess(id, scope = MemoryScope.project, mode, author, accessOpts) {
      await log.append({
        // envelope binds the access to the acting step when the author carries one — per-task
        // pull counts fold from the envelope instead of payload archaeology (P5 token-economy)
        // `|| null`, not `?? null`: an empty-string id would fail the envelope's min(1) and
        // turn a memory read into a tool error — normalize falsy to unbound instead
        taskId: author?.taskId || null, stepId: author?.stepId || null, runToken: author?.runToken || null,
        kind: EVENT_KIND.memory_accessed,
        payload: { id, scope, mode, author, ...(accessOpts?.via && { via: accessOpts.via }) },
        // at-least-once: a crash-retry of the surrounding operation must not append a second access
        idempotencyKey: accessOpts?.idempotencyKey ?? null,
      })
    },
    list: (filter?: MemoryFilter): Promise<NoteSummary[]> => surreal.list(filter),
    search: (query: string, filter?: MemoryFilter, opts?: MemorySearchOpts): Promise<NoteSummary[]> => surreal.search(query, filter, opts),
    searchClaims: (query: string, filter?: MemoryFilter, opts?: MemorySearchOpts & { limit?: number }): Promise<ClaimHit[]> => surreal.searchClaims(query, filter, opts),
    claimsFor: (noteId: string, scope?: string): Promise<Claim[]> => surreal.claimsFor(noteId, scope),
    neighbors: (seed, o) => surreal.neighbors(seed, { ...o, halfLifeDays: o?.halfLifeDays ?? opts.halfLifeDays }),
    topics: (): Promise<Topic[]> => surreal.topics(),
    async topicClaims(topicKey, author, topicOpts) {
      // resolve the label BEFORE appending: the event carries it because the read model is disposable
      // and a topic's label changes as the corpus does
      const topic = (await surreal.topics()).find(t => t.topicKey === topicKey)
      if (!topic) throw new Error(`no topic '${topicKey}' — list topics again, keys change as the corpus does`)
      const claims = await surreal.topicClaims(topicKey)
      await log.append({
        // envelope bound to the acting step, same rule and same `|| null` normalization as
        // recordAccess above: task-scoped views (recent_activity, task transcripts) filter on the
        // envelope, so an unbound append orphans every topic fetch from the run that made it.
        taskId: author?.taskId || null, stepId: author?.stepId || null, runToken: author?.runToken || null,
        kind: EVENT_KIND.memory_topic_accessed,
        payload: { topicKey, label: topic.label, author },
        // at-least-once: a crash-retry of the surrounding tool call must not append a second fetch
        idempotencyKey: topicOpts?.idempotencyKey ?? null,
      })
      return claims
    },
  }
}
