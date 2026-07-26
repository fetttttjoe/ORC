import { z } from 'zod'
import { RecordId, Surreal } from 'surrealdb'
import { edge, orm, table, t } from 'surqlize'
import {
  activation, activationBoost, DEFAULT_HALF_LIFE_DAYS,
  deriveNoteProvenance, EDGE_DIRECTION, EVENT_KIND, LINK_KINDS, NOTE_KINDS, MemoryScope,
  MemoryAccessedPayload, MemoryDeletedPayload, MemoryNote, MemoryWrittenPayload,
  SEARCH_MODE, errorMessage, inferTier, noteKey, NoteTier,
  type EmbeddingProvider, type EventRecord, type NeighborQuery, type MemoryFilter, type NoteFields,
  type MemorySearchOpts, type NeighborResult, type NoteSummary,
  linkLookupScopes,
} from '@orc/contracts'
import { rankNeighbors, rrfFuse, type Edge } from './rank'

// The read model's table names — single spelling for every builder call and RecordId.
enum Tb { Note = 'note', Meta = 'meta', Link = 'link' }

// `noteId` holds the note's own string id (surqlize reserves `id` for the auto-added RecordId).
// hits/lastAccessedAt are projected from memory_accessed like every other field — they survive a
// rebuild — and are stripped back out in toNote() before the row reaches the public MemoryNote
// shape (they belong to the summary, not to the authored note). Both are optional in the row
// type so a note projected before the counter existed still selects without a rebuild.
// literal-typed link kind, derived from the contract's LINK_KINDS — rows come back as LinkKind.
// search-term cap: bounds the WHERE expression depth (see search()); 8 terms is far past the
// point where AND-matching returns anything on a note corpus
const MAX_SEARCH_TERMS = 8

const kindType = t.union(LINK_KINDS.map(k => t.literal(k)))
const noteKindType = t.union(NOTE_KINDS.map(k => t.literal(k)))

// Tier-specific columns are optional because a row only HAS the columns its tier owns — a plan
// note has no `rules` column at all, not an empty one. `tier` itself is optional so a row
// projected before the split still selects; `orc memory rebuild` re-derives it from the log.
const noteTable = table(Tb.Note, {
  noteId: t.string(), scope: t.string(), title: t.string(), tier: t.option(t.string()),
  kind: t.option(noteKindType), sourceRevision: t.option(t.string()),
  categories: t.option(t.array(t.string())), tags: t.array(t.string()),
  links: t.array(t.object({ id: t.string(), kind: kindType, confidence: t.option(t.number()) })),
  paths: t.option(t.array(t.string())), rules: t.option(t.array(t.string())),
  summary: t.string(), body: t.string(),
  retention: t.string(),
  sources: t.option(t.array(t.object({ url: t.string(), title: t.option(t.string()), retrievedAt: t.string() }))),
  rationale: t.option(t.string()), uncertainty: t.option(t.array(t.string())), zone: t.option(t.array(t.string())),
  createdAt: t.string(), createdBy: t.string(), updatedAt: t.string(), updatedBy: t.string(),
  revision: t.number(), hits: t.option(t.number()), lastAccessedAt: t.option(t.string()),
  // the note's dense vector (embedder-derived, Tier-2 like hits) — set only when an embedder was
  // configured at write/rebuild; the semantic scan reads it raw, toNote/toSummary drop it.
  embedding: t.option(t.array(t.number())),
})
const metaTable = table(Tb.Meta, { seq: t.number() })

// Derived edge index (spec D2/D3): materialized from note.links by the projector, rebuilt on
// replay. Explicit fromId/toId/scope string fields so fetch needs no RecordId parsing.
const linkTable = edge(Tb.Note, Tb.Link, Tb.Note, {
  kind: kindType, confidence: t.option(t.number()),
  fromId: t.string(), toId: t.string(), scope: t.string(),
  // observed use, per-EDGE (see memory_accessed's `via` branch below) — optional so a
  // pre-existing link row projected before these fields existed still selects without a rebuild.
  hits: t.option(t.number()), lastAccessedAt: t.option(t.string()),
})

// RecordId key = `${scope}:${id}` (scope/id are separately restricted to [a-z0-9-], so ':' is
// an unambiguous separator); the table itself is always 'note'.
const key = (scope: string, id: string) => `${scope}:${id}`

// Raw semantic-scan rows — the fields the cosine SELECT projects, parsed (never cast) at the
// boundary like every other DB read. hits/lastAccessedAt are optional (a note may predate them).
const SemanticRow = z.object({
  noteId: z.string(), scope: z.string(), title: z.string(),
  // projected like every other summary field: without it toSummary would fall back to shape
  // inference over a row that carries none of the columns inference reads, and label every
  // vector hit 'semantic' — including the plan and episodic notes it surfaced.
  tier: NoteTier.optional(),
  categories: z.array(z.string()).optional(), tags: z.array(z.string()), summary: z.string(),
  hits: z.number().optional(), lastAccessedAt: z.string().nullable().optional(),
  score: z.number(),
})

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
  private constructor(
    private readonly surreal: Surreal,
    private readonly db: Db,
    private readonly embedder?: EmbeddingProvider,
  ) {}

  static async open(t: {
    url: string; ns: string; db: string; username: string; password: string
    connectTimeoutMs?: number
  }, embedder?: EmbeddingProvider): Promise<SurrealMemory> {
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
      return new SurrealMemory(surreal, makeOrm(surreal), embedder)
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
    // Embed BEFORE opening the transaction: an embedder round-trip must never be held inside a
    // Surreal tx. Embedding is derived data (recomputed on every rebuild), so re-embedding a
    // redelivered event is harmless waste, not a correctness issue.
    // ponytail: re-embeds even a redelivered memory_written; gate behind the cursor if it bites.
    const embedding = e.kind === EVENT_KIND.memory_written ? await this.embedWritten(e) : undefined
    return this.db.transaction(async tx => {
      const cursor = (await tx.select(Tb.Meta, 'cursor'))[0]?.seq ?? 0
      if (e.seq <= cursor) return false
      if (e.kind === EVENT_KIND.memory_written) {
        // skip-and-advance: an unparseable/legacy payload costs this ONE note revision, never the
        // whole read model. Strict .parse used to abort drainFrom at this seq and re-hit it on every
        // reconcile AND every rebuild(), permanently wedging memory — the log is immutable, so the
        // wedge could never be operated away. The cursor advances at the end regardless.
        const parsed = MemoryWrittenPayload.safeParse(e.payload)
        if (!parsed.success) { console.warn(`[memory] skipping unparseable memory_written at seq ${e.seq}: ${parsed.error.message}`); await tx.upsert(Tb.Meta, 'cursor').set({ seq: e.seq }); return true }
        const { note, author } = parsed.data
        const k = key(note.scope, note.id)
        // read-then-write: createdAt/By + hits/lastAccessedAt preserved; updated/rev advance
        const ex = (await tx.select(Tb.Note, k))[0]
        // provenance + retrievedAt stamping shared with the kernel plan-note fold (deriveNoteProvenance):
        // the one place this is computed, so projector and log-side fold cannot disagree.
        const prov = deriveNoteProvenance(note, author, e.ts, ex)
        // read through NoteView so one write path covers every tier: a column the note's tier does
        // not own is spread away, so the row carries the tier's real shape and a later tier change
        // cannot leave a stale foreign column behind.
        const n: NoteFields = note
        await tx.upsert(Tb.Note, k).set({
          noteId: note.id, scope: note.scope, title: note.title, tier: note.tier,
          ...(n.kind !== undefined && { kind: n.kind }),
          ...(note.sourceRevision !== null && { sourceRevision: note.sourceRevision }),
          ...(n.categories !== undefined && { categories: n.categories }),
          tags: note.tags,
          // materialize the optional confidence key: t.option infers `number | undefined`, required
          links: note.links.map(l => ({ id: l.id, kind: l.kind, confidence: l.confidence })),
          ...(n.paths !== undefined && { paths: n.paths }),
          ...(n.rules !== undefined && { rules: n.rules }),
          summary: note.summary, body: note.body,
          retention: note.retention,
          // ORM row wants the title key always present (OptionType); retrievedAt already stamped by deriveNoteProvenance
          ...(prov.sources !== undefined && { sources: prov.sources.map(s => ({ url: s.url, title: s.title, retrievedAt: s.retrievedAt })) }),
          ...(n.rationale !== undefined && { rationale: n.rationale }),
          ...(n.uncertainty !== undefined && { uncertainty: n.uncertainty }),
          ...(n.zone !== undefined && { zone: n.zone }),
          createdAt: prov.createdAt, createdBy: prov.createdBy,
          updatedAt: prov.updatedAt, updatedBy: prov.updatedBy, revision: prov.revision,
          hits: ex?.hits ?? 0,
          // OptionType fields validate against `undefined`, not `null` — omit rather than null it out.
          ...(ex?.lastAccessedAt !== undefined && { lastAccessedAt: ex.lastAccessedAt }),
          // the embedder-derived vector when configured (omit-if-undefined like the fields above —
          // a keyword-only deployment simply never sets it, and a rebuild re-derives it)
          ...(embedding && { embedding }),
        })
        // Re-materialize this note's out-edges (delete-then-RELATE) — deterministic on replay.
        // PRESERVE stats first: read the existing out-edges before the delete wipes them, keyed
        // by (toId, kind), so a link that SURVIVES the rewrite carries its earned hits/
        // lastAccessedAt into the re-RELATE below (same omit-if-undefined pattern as the note row
        // above, surreal.ts:154-156). A link the update REMOVES loses its stats with it — correct,
        // the connection no longer exists. Skipping this read is the blocker T6 was named for:
        // every note UPDATE would otherwise silently wipe its edges' accumulated activation.
        const existingLinks = await tx.select(Tb.Link).where(l => l.fromId.eq(note.id).and(l.scope.eq(note.scope)))
        const linkStats = new Map(existingLinks.map(l => [`${l.toId} ${l.kind}`, l]))
        await tx.delete(Tb.Link).where(l => l.fromId.eq(note.id).and(l.scope.eq(note.scope)))
        for (const l of note.links) {
          const exLink = linkStats.get(`${l.id} ${l.kind}`)
          await tx.relate(Tb.Link, new RecordId(Tb.Note, k), new RecordId(Tb.Note, key(note.scope, l.id))).set({
            kind: l.kind, fromId: note.id, toId: l.id, scope: note.scope,
            ...(l.confidence !== undefined && { confidence: l.confidence }),
            hits: exLink?.hits ?? 0,
            ...(exLink?.lastAccessedAt !== undefined && { lastAccessedAt: exLink.lastAccessedAt }),
          })
        }
      } else if (e.kind === EVENT_KIND.memory_accessed) {
        const parsed = MemoryAccessedPayload.safeParse(e.payload)
        if (!parsed.success) { console.warn(`[memory] skipping unparseable memory_accessed at seq ${e.seq}: ${parsed.error.message}`); await tx.upsert(Tb.Meta, 'cursor').set({ seq: e.seq }); return true }
        const p = parsed.data
        const k = key(p.scope, p.id)
        // read-then-write, not a blind upsert: an access whose note was never projected (or was
        // since deleted) must not conjure a row carrying nothing but a counter. lastAccessedAt is
        // the event ts, so a replay lands on the same value the first pass did.
        const ex = (await tx.select(Tb.Note, k))[0]
        if (ex) await tx.upsert(Tb.Note, k).set({ hits: (ex.hits ?? 0) + 1, lastAccessedAt: e.ts })
        // the walked EDGE strengthens too, not just the node — same canonicalization as
        // foldEdgeStats (contracts/memory.ts): direction 'out' means seed→id, so the stored
        // (fromId, toId) pair is (seed, id); 'in' reverses it. No row matched (edge since
        // removed, or this access carries no provenance) → no-op.
        if (p.via) {
          const { seed, kind, direction } = p.via
          const fromId = direction === EDGE_DIRECTION.out ? seed : p.id
          const toId = direction === EDGE_DIRECTION.out ? p.id : seed
          const link = (await tx.select(Tb.Link).where(l =>
            l.scope.eq(p.scope).and(l.kind.eq(kind)).and(l.fromId.eq(fromId)).and(l.toId.eq(toId))))[0]
          if (link) await tx.update(link.id).set({ hits: (link.hits ?? 0) + 1, lastAccessedAt: e.ts })
        }
      } else if (e.kind === EVENT_KIND.memory_deleted) {
        const parsed = MemoryDeletedPayload.safeParse(e.payload)
        if (!parsed.success) { console.warn(`[memory] skipping unparseable memory_deleted at seq ${e.seq}: ${parsed.error.message}`); await tx.upsert(Tb.Meta, 'cursor').set({ seq: e.seq }); return true }
        const p = parsed.data
        await tx.delete(Tb.Note, key(p.scope, p.id))
        // drop the note's edges in both directions with it
        await tx.delete(Tb.Link).where(l => l.fromId.eq(p.id).or(l.toId.eq(p.id)).and(l.scope.eq(p.scope)))
      }
      await tx.upsert(Tb.Meta, 'cursor').set({ seq: e.seq })
      return true
    })
  }

  async neighbors(seed: string, opts: NeighborQuery = {}): Promise<NeighborResult[]> {
    const scope = opts.scope ?? MemoryScope.project
    const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
    const now = opts.now ?? new Date().toISOString()
    // All in-scope edges, ranked in TS — fine for a hand-authored graph; a frontier-scoped
    // fetch is a later optimisation (spec §4.2). Both directions (spec RG4): "what supersedes
    // this note" must be reachable from the superseded seed, so each edge is added reversed too.
    const rows = await this.db.select(Tb.Link).where(l => l.scope.eq(scope))
    // each stored edge is traversed both ways (spec RG4), but tagged with direction so an asymmetric
    // kind stays unambiguous: the authored A→B edge is 'out' from A / 'in' from B.
    const edges: Edge[] = rows.flatMap(r => {
      // edge heat folds into confidence: one multiplication, rank stays purely structural.
      // ponytail: promote to an explicit Edge field if rank ever needs raw confidence.
      const act = activation({ hits: r.hits ?? 0, lastAccessedAt: r.lastAccessedAt ?? null }, now, halfLife)
      const confidence = (r.confidence ?? 1) * activationBoost(act)
      return [
        { from: r.fromId, to: r.toId, kind: r.kind, confidence, direction: EDGE_DIRECTION.out },
        { from: r.toId, to: r.fromId, kind: r.kind, confidence, direction: EDGE_DIRECTION.in },
      ]
    })
    const ranked = rankNeighbors(edges, [seed], { depth: opts.depth, kinds: opts.kinds })
    // join title/summary AND the activation inputs from the raw row (hits/lastAccessedAt are
    // Tier-2 fields toNote strips) — then re-weight: structure × activationBoost. Boost-only,
    // so a graph with zero accesses ranks exactly as before.
    // ponytail: rankNeighbors' cap applies pre-boost — a hot node outside the structural top-20
    // cannot boost in; widen the cap into an opts pass-through if that ever bites.
    const out: NeighborResult[] = []
    // Resolve each neighbour by the ONE link rule (contracts linkLookupScopes), not by assuming the
    // traversed scope: an edge authored in a plan scope may name a note that lives in the durable
    // project lane, and looking it up only in the plan scope is what silently dropped it. Cross-scope
    // neighbours are TERMINAL here — the edge set is still the traversed scope's own, so reaching a
    // project note does not drag the whole project graph into a plan traversal.
    const lookupScopes = linkLookupScopes(scope)
    const findNote = async (id: string) => {
      for (const s of lookupScopes) {
        const found = (await this.db.select(Tb.Note, key(s, id)))[0]
        if (found) return { row: found, scope: s }
      }
      return null
    }
    for (const n of ranked) {
      const hit = await findNote(n.id)
      if (!hit) continue
      const { row, scope: foundScope } = hit
      const act = activation({ hits: row.hits ?? 0, lastAccessedAt: row.lastAccessedAt ?? null }, now, halfLife)
      out.push({
        id: n.id, title: row.title, summary: row.summary, via: n.via, depth: n.depth,
        score: n.score * activationBoost(act), direction: n.direction, activation: act, from: n.from,
        ...(foundScope !== undefined && { scope: foundScope }),
      })
    }
    // same total order rule as rankNeighbors, now over the boosted score
    return out.sort((a, b) => b.score - a.score || a.depth - b.depth || a.id.localeCompare(b.id))
  }

  async get(id: string, scope: string = MemoryScope.project): Promise<MemoryNote | null> {
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

  async search(query: string, filter: MemoryFilter = {}, opts: MemorySearchOpts = {}): Promise<NoteSummary[]> {
    // No embedder configured → keyword is the only mode that can run, whatever was requested.
    const mode = this.embedder ? (opts.mode ?? SEARCH_MODE.hybrid) : SEARCH_MODE.keyword
    if (mode === SEARCH_MODE.keyword) return this.keywordSearch(query, filter)
    const semantic = await this.semanticSearch(query, filter)
    if (mode === SEARCH_MODE.semantic) return semantic
    // hybrid: fuse the two orderings by reciprocal rank, keyed by (scope,id) since ids repeat
    // across scopes. A note found by only one arm still ranks; agreement between arms wins.
    const keyword = await this.keywordSearch(query, filter)
    const byKey = new Map<string, NoteSummary>()
    for (const n of [...semantic, ...keyword]) byKey.set(noteKey(n.scope, n.id), n)
    const fused = rrfFuse([keyword.map(n => noteKey(n.scope, n.id)), semantic.map(n => noteKey(n.scope, n.id))])
    return fused.map(f => byKey.get(f.id)).filter((n): n is NoteSummary => n !== undefined)
  }

  // Vector cosine over stored embeddings — a linear scan, brute-force but exact; fine for a
  // hand-authored corpus. Filters apply in TS, mirroring keywordSearch. ponytail: swap the scan for
  // a DEFINE INDEX ... HNSW + `<|K|>` KNN select when the corpus outgrows a full scan.
  private async semanticSearch(query: string, filter: MemoryFilter): Promise<NoteSummary[]> {
    if (!this.embedder) return []
    // Everything after the embedder check is best-effort and guarded as ONE unit: a query-embed
    // reject, a cosine DIMENSION error (a note embedded under a different model width after a model
    // swap without a rebuild), or a malformed row must DEGRADE to keyword — never fail the whole
    // search. Returning [] makes hybrid fuse keyword-only (keyword notes survive) and semantic-only
    // return the honest empty; it honours the contract's degraded-tolerant intent.
    try {
      const [qv] = await this.embedder.embed([query])
      if (!qv) return []
      // raw query: surqlize has no vector::* select builder — the same escape hatch open() uses for
      // DEFINE TABLE. $q binds the query vector; rows without an embedding are excluded.
      const res = await this.surreal.query(
        `SELECT noteId, scope, title, tier, categories, tags, summary, hits, lastAccessedAt,`
        + ` vector::similarity::cosine(embedding, $q) AS score`
        + ` FROM ${Tb.Note} WHERE embedding != NONE ORDER BY score DESC LIMIT 50`,
        { q: qv },
      )
      const rows = SemanticRow.array().parse(Array.isArray(res) ? res[0] : res)
      // use makes memory more findable: re-rank cosine by activation heat, mirroring neighbors() so a
      // note agents keep reading rises in search (and thus preload) as it does in the graph. Shift
      // cosine into [0,2] BEFORE boosting so the heat factor (≥1) stays monotonic across the WHOLE
      // cosine range — multiplying a negative cosine by ≥1 would otherwise sink a hotter note below
      // a colder one. ponytail: a hot note outside the cosine top-50 can't boost in — widen LIMIT if it bites.
      const now = new Date().toISOString()
      const heat = (r: { hits?: number; lastAccessedAt?: string | null }): number =>
        activationBoost(activation({ hits: r.hits ?? 0, lastAccessedAt: r.lastAccessedAt ?? null }, now))
      return rows
        .filter(r => (!filter.scope || r.scope === filter.scope)
          && (!filter.tier || r.tier === filter.tier)
          && (!filter.category || (r.categories ?? []).includes(filter.category))
          && (!filter.tag || r.tags.includes(filter.tag)))
        .map(r => ({ r, s: (r.score + 1) * heat(r) }))
        .sort((a, b) => b.s - a.s)
        .map(({ r }) => toSummary(r))
    } catch (err) {
      console.warn(`[memory] semantic search failed, falling back to keyword: ${errorMessage(err)}`)
      return []
    }
  }

  // Compute a note's vector from its retrieval-bearing text. Best-effort: a backend failure logs
  // once and yields undefined (the note still stores, keyword still finds it).
  private async embedWritten(e: EventRecord): Promise<number[] | undefined> {
    if (!this.embedder) return undefined
    const p = MemoryWrittenPayload.safeParse(e.payload)
    if (!p.success) return undefined
    const { note } = p.data
    const text = [note.title, note.summary, note.body].filter(Boolean).join('\n').slice(0, 8_000)
    try { const [vec] = await this.embedder.embed([text]); return vec }
    catch (err) { console.warn(`[memory] embed failed at seq ${e.seq}: ${errorMessage(err)}`); return undefined }
  }

  private async keywordSearch(query: string, filter: MemoryFilter = {}): Promise<NoteSummary[]> {
    // AND across whitespace-separated terms, each term matching ANY field — a whole-query
    // substring match made every multi-word query miss unless the exact phrase appeared.
    // text fields: case-insensitive substring match; tags: membership on the lowercased
    // term, since tags are stored lowercase by convention here.
    // Term count is CAPPED: each term adds ~5 nested binary nodes to the WHERE expression and
    // SurrealDB rejects deep ASTs ("Exceeded query recursion depth limit"); under AND
    // semantics extra terms only narrow, so the first MAX_SEARCH_TERMS carry the query.
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS)
    const rows = await this.db.select(Tb.Note)
      .where(n => terms.reduce((acc, q) => acc.and(
        n.title.lowercase().contains(q)
          .or(n.summary.lowercase().contains(q))
          .or(n.body.lowercase().contains(q))
          .or(n.tags.contains(q)),
      ), this.matchFilter(n, filter)))
      .orderBy('updatedAt', 'DESC')
    // relevance over recency: field-weighted term score, +1 for durable project scope so
    // transient plan-scope notes don't bury the knowledge base; updatedAt breaks ties.
    // ponytail: substring scoring — swap for a Surreal FTS index if this plateaus.
    const score = (r: Record<string, any>): number => {
      let s = r.scope === MemoryScope.project ? 1 : 0
      for (const q of terms) {
        if (r.title.toLowerCase().includes(q)) s += 3
        if (r.summary.toLowerCase().includes(q)) s += 2
        if (r.body.toLowerCase().includes(q) || r.tags.includes(q)) s += 1
      }
      return s
    }
    return rows.map(r => ({ r, s: score(r) }))
      .sort((a, b) => b.s - a.s)
      .map(({ r }) => toSummary(r))
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
    // the stored column, never an inferred one: a row from before the split has no tier, and
    // `orc memory rebuild` is what gives it one — guessing here would answer a lane question
    // with a fabricated lane.
    if (filter.tier) cond = cond.and(n.tier.eq(filter.tier))
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
    // an absent tier (a row projected before the split) is classified by MemoryNote's own decoder
    // from the columns below, so a read model that has not been rebuilt still parses
    tier: r.tier, id: r.noteId, scope: r.scope, title: r.title, kind: r.kind,
    sourceRevision: r.sourceRevision ?? null,
    categories: r.categories, tags: r.tags,
    links: r.links, paths: r.paths, rules: r.rules, summary: r.summary, body: r.body,
    // ?? fallbacks so a row written before these fields existed still parses on rebuild
    retention: r.retention ?? 'durable',
    sources: r.sources,
    rationale: r.rationale, uncertainty: r.uncertainty, zone: r.zone,
    createdAt: r.createdAt, createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
    revision: r.revision,
  }
}

function toSummary(r: Record<string, any>): NoteSummary {
  return {
    id: r.noteId, scope: r.scope, title: r.title,
    tier: NoteTier.catch(inferTier(r)).parse(r.tier),
    categories: r.categories ?? [], tags: r.tags, summary: r.summary,
    hits: r.hits ?? 0, lastAccessedAt: r.lastAccessedAt ?? null,
  }
}
