import { RecordId, Surreal } from 'surrealdb'
import { edge, orm, table, t } from 'surqlize'
import {
  composeAuthor, EVENT_KIND, LINK_KINDS, NOTE_KINDS,
  MemoryAccessedPayload, MemoryDeletedPayload, MemoryNote, MemoryWrittenPayload,
  type EventRecord, type LinkKind, type MemoryFilter, type NeighborResult, type NoteSummary,
} from '@orc/contracts'
import { rankNeighbors, type Edge } from './rank'

// The read model's table names — single spelling for every builder call and RecordId.
enum Tb { Note = 'note', Meta = 'meta', Link = 'link' }

// `noteId` holds the note's own string id (surqlize reserves `id` for the auto-added RecordId).
// hits/lastAccessedAt are projected from memory_accessed like every other field — they survive a
// rebuild — and are stripped back out in toNote() before the row reaches the public MemoryNote
// shape (they belong to the summary, not to the authored note). Both are optional in the row
// type so a note projected before the counter existed still selects without a rebuild.
// literal-typed link kind, derived from the contract's LINK_KINDS — rows come back as LinkKind.
const kindType = t.union(LINK_KINDS.map(k => t.literal(k)))
const noteKindType = t.union(NOTE_KINDS.map(k => t.literal(k)))

const noteTable = table(Tb.Note, {
  noteId: t.string(), scope: t.string(), title: t.string(),
  kind: noteKindType, sourceRevision: t.option(t.string()),
  categories: t.array(t.string()), tags: t.array(t.string()),
  links: t.array(t.object({ id: t.string(), kind: kindType, confidence: t.option(t.number()) })),
  paths: t.array(t.string()), rules: t.array(t.string()), summary: t.string(), body: t.string(),
  retention: t.string(),
  sources: t.array(t.object({ url: t.string(), title: t.option(t.string()), retrievedAt: t.string() })),
  rationale: t.string(), uncertainty: t.array(t.string()), zone: t.option(t.array(t.string())),
  createdAt: t.string(), createdBy: t.string(), updatedAt: t.string(), updatedBy: t.string(),
  revision: t.number(), hits: t.option(t.number()), lastAccessedAt: t.option(t.string()),
})
const metaTable = table(Tb.Meta, { seq: t.number() })

// Derived edge index (spec D2/D3): materialized from note.links by the projector, rebuilt on
// replay. Explicit fromId/toId/scope string fields so fetch needs no RecordId parsing.
const linkTable = edge(Tb.Note, Tb.Link, Tb.Note, {
  kind: kindType, confidence: t.option(t.number()),
  fromId: t.string(), toId: t.string(), scope: t.string(),
})

// RecordId key = `${scope}:${id}` (scope/id are separately restricted to [a-z0-9-], so ':' is
// an unambiguous separator); the table itself is always 'note'.
const key = (scope: string, id: string) => `${scope}:${id}`

const CONNECT_TIMEOUT_MS = 5_000
const CLOSE_TIMEOUT_MS = 2_000

// Bound a driver call that may never settle. The timer is always cleared, so a resolved promise
// never holds the process open past its own work.
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function makeOrm(surreal: Surreal) {
  return orm(surreal, noteTable, metaTable, linkTable)
}
type Db = ReturnType<typeof makeOrm>

export class SurrealMemory {
  private constructor(private readonly surreal: Surreal, private readonly db: Db) {}

  static async open(t: {
    url: string; ns: string; db: string; username: string; password: string
    connectTimeoutMs?: number
  }): Promise<SurrealMemory> {
    const surreal = new Surreal()
    try {
      // The driver's connect() does NOT reject on an unreachable endpoint — measured still
      // pending after 400s against a closed port, because its reconnect budget governs a dropped
      // established connection, not the initial dial. Every degraded-memory path in the system
      // is downstream of this throwing: probeMemory's catch, and the CLI runtime's fallback to
      // unavailableMemoryTools. Unbounded, `orc status` and every `orc memory` command hang
      // forever instead of degrading, which is the opposite of the stated guarantee.
      // ponytail: one constant, not a setting — promote it if a real deployment needs longer.
      // authentication as a connect-option PROVIDER, not a one-shot .signin(): when the
      // session expires or the socket reconnects, the driver's renewal chain re-invokes the
      // provider with these credentials. A .signin() covers only the current session — after
      // expiry every query fails 'Anonymous access not allowed' until the process restarts.
      await withTimeout(
        surreal.connect(t.url, { authentication: { username: t.username, password: t.password } }),
        t.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
        `surreal unreachable at ${t.url}`)
      await surreal.use({ namespace: t.ns, database: t.db })
      // ESCAPE HATCH (raw): surqlize's builder assumes tables already exist — it has no DEFINE
      // TABLE op. On a brand-new namespace/database, SurrealDB v3.2.0 throws "table does not
      // exist" on SELECT (even though CREATE/UPSERT auto-vivify it), so applyWritten's read-before-
      // write would fail on the very first write. Defining both tables up front avoids that.
      // `link` (default TYPE ANY, so RELATE works) is defined too: neighbors() SELECTs from it
      // even when no edge was ever materialized.
      await surreal.query([Tb.Note, Tb.Meta, Tb.Link].map(tb => `DEFINE TABLE IF NOT EXISTS ${tb} SCHEMALESS;`).join(' '))
      return new SurrealMemory(surreal, makeOrm(surreal))
    } catch (err) {
      // connect() opens a live socket; if signin/use/DEFINE then throws, don't leak it
      // (symmetry with PostgresStore.open, which pool.end()s on an assertMigrated throw).
      // Bounded too: after a connect timeout the driver is still retrying underneath, and an
      // unbounded close here would re-introduce exactly the hang this method now prevents.
      await withTimeout(surreal.close(), CLOSE_TIMEOUT_MS, 'surreal close').catch(() => {})
      throw err
    }
  }

  // The ONE apply path (design §8.2): note/edges/cursor commit in a single Surreal
  // transaction, gated by the ordered cursor — redelivery of any memory event is a no-op,
  // and revision counts distinct accepted writes, never delivery attempts.
  async applyEvent(e: EventRecord): Promise<boolean> {
    return this.db.transaction(async tx => {
      const cursor = (await tx.select(Tb.Meta, 'cursor'))[0]?.seq ?? 0
      if (e.seq <= cursor) return false
      if (e.kind === EVENT_KIND.memory_written) {
        const { note, author } = MemoryWrittenPayload.parse(e.payload)
        const k = key(note.scope, note.id)
        // read-then-write: createdAt/By + hits/lastAccessedAt preserved; updated/rev advance
        const ex = (await tx.select(Tb.Note, k))[0]
        const by = composeAuthor(author)
        await tx.upsert(Tb.Note, k).set({
          noteId: note.id, scope: note.scope, title: note.title,
          kind: note.kind,
          ...(note.sourceRevision !== null && { sourceRevision: note.sourceRevision }),
          categories: note.categories, tags: note.tags,
          // materialize the optional confidence key: t.option infers `number | undefined`, required
          links: note.links.map(l => ({ id: l.id, kind: l.kind, confidence: l.confidence })),
          paths: note.paths, rules: note.rules, summary: note.summary, body: note.body,
          retention: note.retention,
          // retrievedAt comes from the canonical event timestamp, never from the writer — so it
          // is identical on every replay and an agent cannot claim when it fetched a page.
          sources: note.sources.map(s => ({ url: s.url, title: s.title, retrievedAt: e.ts })),
          rationale: note.rationale, uncertainty: note.uncertainty, zone: note.zone,
          createdAt: ex?.createdAt ?? e.ts, createdBy: ex?.createdBy ?? by,
          updatedAt: e.ts, updatedBy: by, revision: (ex?.revision ?? 0) + 1,
          hits: ex?.hits ?? 0,
          // OptionType fields validate against `undefined`, not `null` — omit rather than null it out.
          ...(ex?.lastAccessedAt !== undefined && { lastAccessedAt: ex.lastAccessedAt }),
        })
        // Re-materialize this note's out-edges (delete-then-RELATE) — deterministic on replay.
        await tx.delete(Tb.Link).where(l => l.fromId.eq(note.id).and(l.scope.eq(note.scope)))
        for (const l of note.links)
          await tx.relate(Tb.Link, new RecordId(Tb.Note, k), new RecordId(Tb.Note, key(note.scope, l.id))).set({
            kind: l.kind, fromId: note.id, toId: l.id, scope: note.scope,
            ...(l.confidence !== undefined && { confidence: l.confidence }),
          })
      } else if (e.kind === EVENT_KIND.memory_accessed) {
        const p = MemoryAccessedPayload.parse(e.payload)
        const k = key(p.scope, p.id)
        // read-then-write, not a blind upsert: an access whose note was never projected (or was
        // since deleted) must not conjure a row carrying nothing but a counter. lastAccessedAt is
        // the event ts, so a replay lands on the same value the first pass did.
        const ex = (await tx.select(Tb.Note, k))[0]
        if (ex) await tx.upsert(Tb.Note, k).set({ hits: (ex.hits ?? 0) + 1, lastAccessedAt: e.ts })
      } else if (e.kind === EVENT_KIND.memory_deleted) {
        const p = MemoryDeletedPayload.parse(e.payload)
        await tx.delete(Tb.Note, key(p.scope, p.id))
        // drop the note's edges in both directions with it
        await tx.delete(Tb.Link).where(l => l.fromId.eq(p.id).or(l.toId.eq(p.id)).and(l.scope.eq(p.scope)))
      }
      await tx.upsert(Tb.Meta, 'cursor').set({ seq: e.seq })
      return true
    })
  }

  async neighbors(seed: string, opts: { kinds?: LinkKind[]; depth?: number; scope?: string } = {}): Promise<NeighborResult[]> {
    const scope = opts.scope ?? 'project'
    // All in-scope edges, ranked in TS — fine for a hand-authored graph; a frontier-scoped
    // fetch is a later optimisation (spec §4.2). Both directions (spec RG4): "what supersedes
    // this note" must be reachable from the superseded seed, so each edge is added reversed too.
    const rows = await this.db.select(Tb.Link).where(l => l.scope.eq(scope))
    const edges: Edge[] = rows.flatMap(r => [
      { from: r.fromId, to: r.toId, kind: r.kind, confidence: r.confidence },
      { from: r.toId, to: r.fromId, kind: r.kind, confidence: r.confidence },
    ])
    const ranked = rankNeighbors(edges, [seed], { depth: opts.depth, kinds: opts.kinds })
    // join title/summary from the note docs (cheap: small result set)
    const out: NeighborResult[] = []
    for (const n of ranked) {
      const doc = await this.get(n.id, scope)
      if (doc) out.push({ id: n.id, title: doc.title, summary: doc.summary, via: n.via, depth: n.depth, score: n.score })
    }
    return out
  }

  async get(id: string, scope = 'project'): Promise<MemoryNote | null> {
    const rows = await this.db.select(Tb.Note, key(scope, id))
    const r = rows[0]
    if (!r) return null
    return MemoryNote.parse(toNote(r))
  }

  async list(filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    const rows = await this.db.select(Tb.Note)
      .where(n => this.matchFilter(n, filter))
      .orderBy('updatedAt', 'DESC')
    return rows.map(toSummary)
  }

  async search(query: string, filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    const q = query.toLowerCase()
    const rows = await this.db.select(Tb.Note)
      // text fields: case-insensitive substring match; tags: membership on the lowercased
      // query, since tags are stored lowercase by convention here.
      .where(n => this.matchFilter(n, filter).and(
        n.title.lowercase().contains(q)
          .or(n.summary.lowercase().contains(q))
          .or(n.body.lowercase().contains(q))
          .or(n.tags.contains(q)),
      ))
      .orderBy('updatedAt', 'DESC')
    return rows.map(toSummary)
  }

  // surqlize's fluent `.where()` builder expresses scope/category/tag filtering directly
  // (array-contains via `.contains()`) — no raw-SurrealQL fallback needed for this.
  // `n` is the per-row Actionable proxy handed in by `.where()`; typed `any` here because it
  // crosses a helper-method boundary (the builder's context type is per-call-site generic).
  private matchFilter(n: any, filter: MemoryFilter): any {
    // always-true seed (SurrealQL needs a base predicate to `.and()` onto; `deleted` used to
    // serve this role, but there are no soft-deleted rows anymore — see applyDeleted).
    let cond = n.scope.eq(n.scope)
    if (filter.scope) cond = cond.and(n.scope.eq(filter.scope))
    if (filter.category) cond = cond.and(n.categories.contains(filter.category))
    if (filter.tag) cond = cond.and(n.tags.contains(filter.tag))
    return cond
  }

  async getCursor(): Promise<number> {
    const rows = await this.db.select(Tb.Meta, 'cursor')
    return rows[0]?.seq ?? 0
  }

  // every note across scopes, in deterministic (scope, id) order — the vault rebuild input
  async allNotes(): Promise<MemoryNote[]> {
    const rows = await this.db.select(Tb.Note)
    return rows
      .map(r => MemoryNote.parse(toNote(r)))
      .sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id))
  }
  // ESCAPE HATCH: delete-all is expressible via the builder too (`db.delete('note')` with no id
  // deletes the whole table), so no raw `surreal.query` is used here either.
  //
  // ONE transaction, not three statements. applyEvent gates replay on `e.seq <= cursor`, so a
  // clear that drops content while leaving the cursor ahead of it is unrecoverable through the
  // normal paths: start()/catchUp() both drain zero and probeMemory honestly reports healthy,
  // because "no events after the cursor" is true. Atomicity makes that state unreachable
  // instead of merely unlikely.
  async clear(): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.delete(Tb.Note)
      await tx.delete(Tb.Meta)
      await tx.delete(Tb.Link)
    })
  }
  async close(): Promise<void> { await this.surreal.close() }
}

// map the stored row back to the MemoryNote shape (noteId → id; drop RecordId + Tier-2 fields).
function toNote(r: Record<string, any>): unknown {
  return {
    id: r.noteId, scope: r.scope, title: r.title, kind: r.kind, sourceRevision: r.sourceRevision ?? null,
    categories: r.categories, tags: r.tags,
    links: r.links, paths: r.paths, rules: r.rules, summary: r.summary, body: r.body,
    // ?? fallbacks so a row written before these fields existed still parses on rebuild
    retention: r.retention ?? 'durable',
    sources: r.sources ?? [],
    rationale: r.rationale, uncertainty: r.uncertainty,
    zone: r.zone ?? [], // rows written before the field existed parse on rebuild
    createdAt: r.createdAt, createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
    revision: r.revision,
  }
}

function toSummary(r: Record<string, any>): NoteSummary {
  return {
    id: r.noteId, scope: r.scope, title: r.title,
    categories: r.categories, tags: r.tags, summary: r.summary,
    hits: r.hits ?? 0, lastAccessedAt: r.lastAccessedAt ?? null,
  }
}
