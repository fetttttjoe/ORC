import { ClaimWrite, composeAuthor, EVENT_KIND, foldMemory, noteKey, MemoryNoteInput, MemoryScope, MemoryWrittenPayload, NOTE_TIER, resolveClaims, type ClaimSearchOptions, type MemoryAuthor, type MemoryFilter, type MemorySearchOpts, type MemoryNote, type MemoryStore, type NoteSummary, type Claim, type ClaimHit, type Topic } from '@orc/contracts'
import { KERNEL_ERROR_CODE, KernelError, type EventLog } from '@orc/kernel'
import type { SurrealMemory } from './surreal'
import { KNOWLEDGE_KINDS } from './projector'

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

  /**
   * Retire or restore MANY notes with ONE pass over the log.
   *
   * From the LOG, not the read model. Archiving DELETES the note's row, so an archived note reads
   * as absent through surreal.get — restore then found nothing and silently no-opped, which made
   * archival a one-way door while reporting success. The fold is the only view that still holds an
   * archived note, which is exactly what makes the archive reversible.
   *
   * Batched because `recheck --apply` retires every candidate at once, and folding per note is N
   * full log reads and N folds against a log past 70k events.
   *
   * Declared HERE rather than as a member so neither door depends on `this`: MemoryStore is an
   * interface, and a consumer that destructures a method off it would get `this === undefined`.
   */
  const setArchivedAll: MemoryStore['setArchivedAll'] = async (entries, archived, author) => {
    if (entries.length === 0) return // no ids, no reason to read the log at all
    const fold = foldMemory(await log.after(0, KNOWLEDGE_KINDS))
    for (const { id, scope } of entries) {
      const held = fold.notes.get(noteKey(scope, id))
      const existing = held?.note
      // Nothing to retire, or already in the asked-for state — a no-op keeps `--apply` idempotent,
      // and an id the log never carried is skipped rather than treated as a fault.
      if (!existing || existing.archived === archived) continue
      // NOTE the absent sourceRevision() call: this re-appends what is stored, flag moved and
      // nothing else. `archived` is excluded from CONTENT_FIELDS, so the content key is unchanged
      // and deriveNoteProvenance carries the verification stamp across too.
      const note = MemoryNoteInput.parse({ ...existing, archived })
      // The note keeps ITS author, not the operator's. Authorship is who wrote the content; moving
      // a lifecycle flag is not writing. Stamping `{source:'cli'}` here erased the taskId every
      // task-bound note carries, so a restored plan note lost the binding `taskSettled` reads and
      // could never be archived again — measured: three restored notes went permanently unretirable.
      await log.append({
        taskId: null, stepId: null, runToken: null, kind: EVENT_KIND.memory_written,
        payload: { note, author: held?.author ?? author ?? { source: 'cli' } },
      })
    }
  }

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
      // event-first: the record materializes via the projector shortly, so the projected row is
      // read for PROVENANCE ONLY — createdAt/createdBy/updatedAt/revision, the fields only the
      // projector derives — and the just-written content is returned over it.
      //
      // Returning that row wholesale returned the PREVIOUS revision on every update: this read
      // happens after the append but before the projector has drained it. memory_write lints what
      // write() hands back, so an update that introduced a dangling link or a paths-warning body
      // was linted against the note's OLD content and came back clean. Content is what gets judged,
      // so content is what must be fresh; provenance may lag one revision inside the flush window.
      //
      // `verified` is deliberately NOT carried over: whether a stamp survives a rewrite is
      // deriveNoteProvenance's decision from the content key, and asserting one here could report a
      // verification of text the write just replaced.
      const projected = await surreal.get(note.id, note.scope)
      const stamped = projected
        ? { createdAt: projected.createdAt, createdBy: projected.createdBy, updatedAt: projected.updatedAt, updatedBy: projected.updatedBy, revision: projected.revision }
        : { createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', revision: 1 }
      // retrievedAt is blank for the same reason: the projector stamps it from the committed event
      // only the semantic tier cites; the other two have no sources field to stamp
      return note.tier === NOTE_TIER.semantic
        ? { ...note, ...stamped, sources: note.sources.map(s => ({ ...s, retrievedAt: '' })) }
        : { ...note, ...stamped }
    },
    // The verification act. Appends memory_verified and NOTHING else — no memory_written — so the
    // note's body, summary, revision and authorship come out byte-stable: the auditor read the note,
    // it did not write it, and a log that records otherwise is the inference this design removes.
    async verify(id, scope = MemoryScope.project, author, verifyOpts) {
      // The SAME HEAD the write path stamps sourceRevision from, resolved the same way (per call,
      // outside the write lock) — a second git read here would let the two stamps disagree about
      // which tree they were compared against, which is the one thing drift's either-clean rule
      // cannot tolerate.
      const revision = await sourceRevision()
      // Refused, not stamped with a placeholder: `verified.revision` is what every later check
      // diffs against, and a stamp nothing can be compared to is worse than no stamp — it reads
      // as confirmation while proving nothing.
      if (revision === null) throw new Error('cannot record a verification without a source revision — this runtime has no readable Git HEAD, so nothing could date the check afterwards')
      const stamp = { revision, at: new Date().toISOString(), by: composeAuthor(author) }
      await log.transaction(async tx => {
        // Existence is checked against the LOG, the source of truth, not the read model: the
        // projection is asynchronous, so a note verified in the same turn it was written would be
        // refused against a view that has not caught up. Same read the write path's merge base uses.
        const latest = await tx.latestNoteEvent(scope, id)
        if (latest?.kind !== EVENT_KIND.memory_written)
          throw new Error(`no note '${id}' in scope '${scope}' — verify a note that exists (a deleted note cannot be verified back into existence)`)
        try {
          await tx.append({
            // `|| null`, not `?? null` — recordAccess's rule and its reason: an empty-string id would
            // fail the envelope's min(1) and turn a tool call into an error, so falsy normalizes to
            // unbound. Bound to the acting step so task-scoped views can ask which notes THIS run
            // verified without payload archaeology.
            taskId: author.taskId || null, stepId: author.stepId || null, runToken: author.runToken || null,
            kind: EVENT_KIND.memory_verified,
            payload: { id, scope, stamp, author },
            // at-least-once: a crash-retry of the surrounding tool call must not append a second
            // verification, same rule recordAccess and write already follow
            idempotencyKey: verifyOpts?.idempotencyKey ?? null,
          })
        } catch (err) {
          // The SAME rule write commits to above: a key identifies ONE tool call, so a keyed replay
          // is that call arriving twice and the FIRST committed verification stands.
          //
          // Load-bearing here in a way it is not for write. The log reuses a stored event silently
          // only when the replayed payload is BYTE-IDENTICAL — and `stamp.at` is a fresh clock read
          // per attempt, so a verification conflicts on EVERY replay by construction. Without this
          // catch, a DBOS re-execution of a tool step whose append had already committed handed the
          // auditor an isError for work that succeeded.
          //
          // CEILING: the stamp returned below is then this attempt's, not the one in the log — they
          // differ by the retry gap in `at`, and by `revision` only if HEAD moved between attempts
          // (it cannot within one step). Same imprecision write documents; the log holds the truth.
          const conflicted = verifyOpts?.idempotencyKey
            && err instanceof KernelError && err.code === KERNEL_ERROR_CODE.idempotency_conflict
          if (!conflicted) throw err
        }
      })
      return stamp
    },
    // optional author: cancel-sweep passes the cancelled task's identity as provenance
    // The single-note case of the batch door, delegating to the hoisted function rather than
    // `this.setArchivedAll`: MemoryStore is an interface, and a consumer that destructures a method
    // off it would get `this === undefined` and a runtime throw.
    setArchived: (id, scope = MemoryScope.project, archived, author) => setArchivedAll([{ id, scope }], archived, author),
    setArchivedAll,

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
    // halfLifeDays threaded like neighbors' below: search re-ranks by the SAME activation decay, so
    // a project that configured a half-life had it honoured in the graph and in traversal but not in
    // search — the one surface a step actually reads through — which silently decayed at the
    // built-in 14 days instead.
    search: (query: string, filter?: MemoryFilter, o?: MemorySearchOpts): Promise<NoteSummary[]> =>
      surreal.search(query, filter, { ...o, halfLifeDays: o?.halfLifeDays ?? opts.halfLifeDays }),
    // the contract's own opts type, never a local respell: a hand-written `& { limit?: number }`
    // here dropped `perNote`, which step.ts's claimsCiting passes
    searchClaims: (query: string, filter?: MemoryFilter, opts?: MemorySearchOpts & ClaimSearchOptions): Promise<ClaimHit[]> => surreal.searchClaims(query, filter, opts),
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
