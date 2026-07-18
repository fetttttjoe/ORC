import { Surreal } from 'surrealdb'
import { orm, table, t } from 'surqlize'
import {
  composeAuthor, MemoryNote,
  type MemoryAuthor, type MemoryFilter, type MemoryNoteInput, type NoteSummary,
} from '@orc/contracts'

type WrittenEvent = { seq: number; ts: string; note: MemoryNoteInput; author: MemoryAuthor }
type DeletedEvent = { seq: number; ts: string; id: string; scope: string; author: MemoryAuthor }

// `noteId` holds the note's own string id (surqlize reserves `id` for the auto-added RecordId).
// readCount/lastReadAt are Tier-2 read-observability fields — never event-sourced, only bumped
// here — and are stripped back out in toNote() before the row reaches the public MemoryNote shape.
const noteTable = table('note', {
  noteId: t.string(), scope: t.string(), title: t.string(),
  categories: t.array(t.string()), tags: t.array(t.string()), links: t.array(t.string()),
  paths: t.array(t.string()), rules: t.array(t.string()), summary: t.string(), body: t.string(),
  createdAt: t.string(), createdBy: t.string(), updatedAt: t.string(), updatedBy: t.string(),
  revision: t.number(), readCount: t.number(), lastReadAt: t.option(t.string()),
})
const metaTable = table('meta', { seq: t.number() })

// RecordId key = `${scope}:${id}` (scope/id are separately restricted to [a-z0-9-], so ':' is
// an unambiguous separator); the table itself is always 'note'.
const key = (scope: string, id: string) => `${scope}:${id}`

function makeOrm(surreal: Surreal) {
  return orm(surreal, noteTable, metaTable)
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
    await surreal.query('DEFINE TABLE IF NOT EXISTS note SCHEMALESS; DEFINE TABLE IF NOT EXISTS meta SCHEMALESS;')
    return new SurrealMemory(surreal, makeOrm(surreal))
  }

  // read-then-write: createdAt/By + readCount/lastReadAt preserved; updated/rev advance.
  async applyWritten(e: WrittenEvent): Promise<void> {
    const k = key(e.note.scope, e.note.id)
    const rows = await this.db.select('note', k)
    const ex = rows[0]
    const by = composeAuthor(e.author)
    const data: Record<string, unknown> = {
      noteId: e.note.id, scope: e.note.scope, title: e.note.title,
      categories: e.note.categories, tags: e.note.tags, links: e.note.links,
      paths: e.note.paths, rules: e.note.rules, summary: e.note.summary, body: e.note.body,
      createdAt: ex?.createdAt ?? e.ts, createdBy: ex?.createdBy ?? by,
      updatedAt: e.ts, updatedBy: by, revision: (ex?.revision ?? 0) + 1,
      readCount: ex?.readCount ?? 0,
    }
    // OptionType fields validate against `undefined`, not `null` — omit rather than null it out.
    if (ex?.lastReadAt !== undefined) data.lastReadAt = ex.lastReadAt
    await this.db.upsert('note', k).set(data as never)
  }

  async applyDeleted(e: DeletedEvent): Promise<void> {
    await this.db.delete('note', key(e.scope, e.id))
  }

  async get(id: string, scope = 'project'): Promise<MemoryNote | null> {
    const rows = await this.db.select('note', key(scope, id))
    const r = rows[0]
    if (!r) return null
    return MemoryNote.parse(toNote(r))
  }

  // surqlize's upsert().set() renders SurrealQL `SET field = value, ...` — verified (see
  // surreal.test.ts) that this only touches the listed fields and leaves the rest of an
  // existing row untouched (SurrealQL SET semantics), so this is a safe partial merge.
  async bumpRead(id: string, scope = 'project'): Promise<void> {
    await this.db.upsert('note', key(scope, id)).set({
      readCount: { '+=': 1 }, lastReadAt: new Date().toISOString(),
    })
  }

  async list(filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    const rows = await this.db.select('note')
      .where(n => this.matchFilter(n, filter))
      .orderBy('updatedAt', 'DESC')
    return rows.map(toSummary)
  }

  async search(query: string, filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    const q = query.toLowerCase()
    const rows = await this.db.select('note')
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
    const rows = await this.db.select('meta', 'cursor')
    return rows[0]?.seq ?? 0
  }
  async setCursor(seq: number): Promise<void> {
    await this.db.upsert('meta', 'cursor').set({ seq })
  }
  // ESCAPE HATCH: delete-all is expressible via the builder too (`db.delete('note')` with no id
  // deletes the whole table), so no raw `surreal.query` is used here either.
  async clear(): Promise<void> {
    await this.db.delete('note')
    await this.db.delete('meta')
  }
  async close(): Promise<void> { await this.surreal.close() }
}

// map the stored row back to the MemoryNote shape (noteId → id; drop RecordId + Tier-2 fields).
function toNote(r: Record<string, any>): unknown {
  return {
    id: r.noteId, scope: r.scope, title: r.title, categories: r.categories, tags: r.tags,
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
