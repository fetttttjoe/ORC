import { RecordId, Surreal } from 'surrealdb'
import { edge, orm, table, t } from 'surqlize'
import {
  composeAuthor, EVENT_KIND, LINK_KINDS, NOTE_KINDS,
  MemoryDeletedPayload, MemoryNote, MemoryWrittenPayload,
  type EventRecord, type LinkKind, type MemoryFilter, type NeighborResult, type NoteSummary,
} from '@orc/contracts'
import { rankNeighbors, type Edge } from './rank'

// The read model's table names — single spelling for every builder call and RecordId.
enum Tb { Note = 'note', Meta = 'meta', Link = 'link' }

// `noteId` holds the note's own string id (surqlize reserves `id` for the auto-added RecordId).
// readCount/lastReadAt are Tier-2 read-observability fields — never event-sourced, only bumped
// here — and are stripped back out in toNote() before the row reaches the public MemoryNote shape.
// literal-typed link kind, derived from the contract's LINK_KINDS — rows come back as LinkKind.
const kindType = t.union(LINK_KINDS.map(k => t.literal(k)))
const noteKindType = t.union(NOTE_KINDS.map(k => t.literal(k)))

const noteTable = table(Tb.Note, {
  noteId: t.string(), scope: t.string(), title: t.string(),
  kind: noteKindType, sourceRevision: t.option(t.string()),
  categories: t.array(t.string()), tags: t.array(t.string()),
  links: t.array(t.object({ id: t.string(), kind: kindType, confidence: t.option(t.number()) })),
  paths: t.array(t.string()), rules: t.array(t.string()), summary: t.string(), body: t.string(),
  createdAt: t.string(), createdBy: t.string(), updatedAt: t.string(), updatedBy: t.string(),
  revision: t.number(), readCount: t.number(), lastReadAt: t.option(t.string()),
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

function makeOrm(surreal: Surreal) {
  return orm(surreal, noteTable, metaTable, linkTable)
}
type Db = ReturnType<typeof makeOrm>

export class SurrealMemory {
  private constructor(private readonly surreal: Surreal, private readonly db: Db) {}

  static async open(t: { url: string; ns: string; db: string; username: string; password: string }): Promise<SurrealMemory> {
    const surreal = new Surreal()
    await surreal.connect(t.url)
    await surreal.signin({ username: t.username, password: t.password })
    await surreal.use({ namespace: t.ns, database: t.db })
    // ESCAPE HATCH (raw): surqlize's builder assumes tables already exist — it has no DEFINE
    // TABLE op. On a brand-new namespace/database, SurrealDB v3.2.0 throws "table does not
    // exist" on SELECT (even though CREATE/UPSERT auto-vivify it), so applyWritten's read-before-
    // write would fail on the very first write. Defining both tables up front avoids that.
    // `link` (default TYPE ANY, so RELATE works) is defined too: neighbors() SELECTs from it
    // even when no edge was ever materialized.
    await surreal.query([Tb.Note, Tb.Meta, Tb.Link].map(tb => `DEFINE TABLE IF NOT EXISTS ${tb} SCHEMALESS;`).join(' '))
    return new SurrealMemory(surreal, makeOrm(surreal))
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
        // read-then-write: createdAt/By + readCount/lastReadAt preserved; updated/rev advance
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
          createdAt: ex?.createdAt ?? e.ts, createdBy: ex?.createdBy ?? by,
          updatedAt: e.ts, updatedBy: by, revision: (ex?.revision ?? 0) + 1,
          readCount: ex?.readCount ?? 0,
          // OptionType fields validate against `undefined`, not `null` — omit rather than null it out.
          ...(ex?.lastReadAt !== undefined && { lastReadAt: ex.lastReadAt }),
        })
        // Re-materialize this note's out-edges (delete-then-RELATE) — deterministic on replay.
        await tx.delete(Tb.Link).where(l => l.fromId.eq(note.id).and(l.scope.eq(note.scope)))
        for (const l of note.links)
          await tx.relate(Tb.Link, new RecordId(Tb.Note, k), new RecordId(Tb.Note, key(note.scope, l.id))).set({
            kind: l.kind, fromId: note.id, toId: l.id, scope: note.scope,
            ...(l.confidence !== undefined && { confidence: l.confidence }),
          })
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

  // surqlize's upsert().set() renders SurrealQL `SET field = value, ...` — verified (see
  // surreal.test.ts) that this only touches the listed fields and leaves the rest of an
  // existing row untouched (SurrealQL SET semantics), so this is a safe partial merge.
  async bumpRead(id: string, scope = 'project'): Promise<void> {
    await this.db.upsert(Tb.Note, key(scope, id)).set({
      readCount: { '+=': 1 }, lastReadAt: new Date().toISOString(),
    })
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
  async clear(): Promise<void> {
    await this.db.delete(Tb.Note)
    await this.db.delete(Tb.Meta)
    await this.db.delete(Tb.Link)
  }
  async close(): Promise<void> { await this.surreal.close() }
}

// map the stored row back to the MemoryNote shape (noteId → id; drop RecordId + Tier-2 fields).
function toNote(r: Record<string, any>): unknown {
  return {
    id: r.noteId, scope: r.scope, title: r.title, kind: r.kind, sourceRevision: r.sourceRevision ?? null,
    categories: r.categories, tags: r.tags,
    links: r.links, paths: r.paths, rules: r.rules, summary: r.summary, body: r.body,
    createdAt: r.createdAt, createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
    revision: r.revision,
  }
}

function toSummary(r: Record<string, any>): NoteSummary {
  return {
    id: r.noteId, scope: r.scope, title: r.title,
    categories: r.categories, tags: r.tags, summary: r.summary,
  }
}
