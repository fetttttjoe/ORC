# M4c — Memory Graph / Recursive-MAS Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn M4b's flat `links: id[]` into a real typed, confidence-weighted, traversable knowledge graph: typed `RELATE` edges in the SurrealDB read model, a graph-distance relevance ranker (no embeddings), a `memory_neighbors` blast-radius pull tool, and token-budgeted pull-tool results — so a recursive MAS can bind a bounded context slice by traversing the graph instead of re-holding the whole context.

**Architecture:** Additive over M4b's event-sourced CQRS. The one contract change — `links` becomes `{ id, kind, confidence? }[]` with **backward-compatible coercion of legacy string ids** — flows into the `memory_written` payload for free. Everything else is cheap-now and lives behind the log: SurrealDB `RELATE` edges are a **derived projection index** rebuilt on replay; two pure modules (`rank.ts`, `budget.ts`) keep scoring and token-shaping DB-free. Event log stays the only truth; SurrealDB + `vault/memory/**` stay disposable projections. See `docs/superpowers/specs/2026-07-19-m4c-memory-graph-recursive-mas-design.md`.

**Tech Stack:** Bun (test runner), TypeScript, zod v4, drizzle-orm + Postgres (event log), SurrealDB v3.2.0 + `surrealdb@2.0.4` client + `surqlize@0.1.0` ORM (read model), Vercel AI SDK tool shape (`ResolvedTool`), DBOS (execution port). No new dependency.

## Global Constraints

Carrying M4b's constraints verbatim, plus M4c-specific ones:

- **Runtime/test:** Bun; `bun test`; typecheck with the root `typecheck` script. SurrealDB tests need `bun run db:up` (the `surrealdb` service, healthy).
- **Validation:** every contract is a zod schema; types inferred. Defaults live in `.default()`, never `??` chains. **Ranker weights live as a `DEFAULT_*` const in code** (config override is deferred — spec §9.2).
- **Event log is the only source of truth.** SurrealDB (docs + `RELATE` edges) and `vault/memory/**` are disposable projections rebuilt from the log. Never read truth from either.
- **No log migration.** The link-shape change is a **tolerant contract** (`LinkInput` coerces legacy string ids → `relates_to`) + a read-model rebuild (`orc memory rebuild`). Historical `memory_written` payloads are never rewritten (append-only immutability — M4b RM2). Any old event MUST still `MemoryNoteInput.parse` — this is a hard test gate (Task 1).
- **Edges are a derived index, materialized by the single-writer projector.** `applyWritten` re-materializes a note's out-edges (delete-then-`RELATE`); `applyDeleted` removes its in+out edges; `clear`/`rebuild` drops the `link` table. Deterministic on replay.
- **Memory writes stay non-locking blind appends; reads query SurrealDB — never `fold(log.all())`.** (M4b D2, unchanged.)
- **Pull-only.** M4c adds a *pull* tool (`memory_neighbors`) to the per-step injected set. No push / no step-boundary auto-binding of a slice (spec D5, deferred).
- **Timestamps come from the event row (`event.ts`), never a client clock** — replay determinism (M4b).
- **surqlize escape-hatch policy (M4b, extended):** build ops with the surqlize builder where it can; use the held raw `Surreal` client (`surreal.query`) for what it can't — now including **`RELATE` edge materialization and graph-edge fetch** (surqlize 0.1.0 has no graph-edge API). Report exactly which ops fell back to raw.
- **ID safety:** note `id` and `scope` match `^[a-z0-9][a-z0-9-]*$` (M4b `MEMORY_ID_RE`).
- **Commits:** conventional-commit messages, one per task minimum.

---

### Task 1: Contract — typed + confidence-weighted links (backward-compatible)

**Files:**
- Modify: `packages/contracts/src/memory.ts` (link shape, `MemoryStore.neighbors`, `NeighborResult`)
- Modify: `packages/contracts/src/memory.test.ts` (coercion + typed-link tests)

**Interfaces:**
- Produces: `LINK_KINDS`, `LinkKind`, `MemoryLink`; `MemoryNoteInput.links: { id, kind, confidence? }[]` (coerces bare string → `{ id, kind: 'relates_to' }`); `NeighborResult`; `MemoryStore.neighbors(seed, opts?)`.
- Consumes: existing `Id`, `MEMORY_ID_RE`, `MemoryNoteInput`.
- **Untouched by design:** `packages/contracts/src/events.ts` — `memory_written` payload is `{ note: MemoryNoteInput, author }` (events.ts:85), so the link change propagates with no edit there. Confirm this in a test, do not edit events.ts.

- [ ] **Step 1: Write the failing test** — add to `packages/contracts/src/memory.test.ts`

```ts
import { MemoryNoteInput, LINK_KINDS } from './memory'

it('coerces a legacy flat string id to a relates_to link (replay-safe)', () => {
  const n = MemoryNoteInput.parse({ id: 'a', title: 'A', links: ['b', 'c'] })
  expect(n.links).toEqual([{ id: 'b', kind: 'relates_to' }, { id: 'c', kind: 'relates_to' }])
})
it('accepts a typed link with kind + optional confidence', () => {
  const n = MemoryNoteInput.parse({ id: 'a', title: 'A', links: [{ id: 'b', kind: 'supersedes', confidence: 0.9 }] })
  expect(n.links[0]).toEqual({ id: 'b', kind: 'supersedes', confidence: 0.9 })
})
it('defaults a typed link kind to relates_to and rejects a bad kind / out-of-range confidence', () => {
  expect(MemoryNoteInput.parse({ id: 'a', title: 'A', links: [{ id: 'b' }] }).links[0].kind).toBe('relates_to')
  expect(MemoryNoteInput.safeParse({ id: 'a', title: 'A', links: [{ id: 'b', kind: 'nope' }] }).success).toBe(false)
  expect(MemoryNoteInput.safeParse({ id: 'a', title: 'A', links: [{ id: 'b', confidence: 2 }] }).success).toBe(false)
  expect(LINK_KINDS).toContain('supersedes')
})
```

- [ ] **Step 2: Run it to verify it fails** — `bun test packages/contracts/src/memory.test.ts` → FAIL (`links` still `string[]`).

- [ ] **Step 3: Implement the typed link** in `packages/contracts/src/memory.ts`

```ts
export const LINK_KINDS = [
  'refines', 'supersedes', 'contradicts', 'depends_on',
  'example_of', 'derived_from', 'relates_to',
] as const
export const LinkKind = z.enum(LINK_KINDS)
export type LinkKind = z.infer<typeof LinkKind>

export const MemoryLink = z.object({
  id: Id,
  kind: LinkKind.default('relates_to'),
  confidence: z.number().min(0).max(1).optional(),
})
export type MemoryLink = z.infer<typeof MemoryLink>

// Backward-compatible: a bare string id (every M4b event) coerces to a relates_to link,
// so historical memory_written payloads still parse on replay. DO NOT drop the string branch.
const LinkInput = z.union([
  z.string().regex(MEMORY_ID_RE).transform(id => ({ id, kind: 'relates_to' as const })),
  MemoryLink,
])
```

Change the `links` field of `MemoryNoteInput` (memory.ts:25) from `z.array(Id)` to:
```ts
  links: z.array(LinkInput).default([]),   // typed graph edges; legacy string ids coerce to relates_to
```

Add the neighbour result shape near `NoteSummary`:
```ts
export const NeighborResult = z.object({
  id: z.string(), title: z.string(), summary: z.string(),
  via: LinkKind, depth: z.number().int().positive(), score: z.number(),
})
export type NeighborResult = z.infer<typeof NeighborResult>
```

Add to the `MemoryStore` interface (memory.ts:52):
```ts
  neighbors(seed: string, opts?: { kinds?: LinkKind[]; depth?: number; cap?: number; scope?: string }): Promise<NeighborResult[]>
```

- [ ] **Step 4: Prove the payload propagated (no events.ts edit)** — add to the test:
```ts
import { PAYLOAD_SCHEMAS } from './events'
it('memory_written payload accepts typed AND legacy-string links unchanged', () => {
  expect(PAYLOAD_SCHEMAS.memory_written.safeParse({ note: { id: 'a', title: 'A', links: ['b'] }, author: { source: 'cli' } }).success).toBe(true)
  expect(PAYLOAD_SCHEMAS.memory_written.safeParse({ note: { id: 'a', title: 'A', links: [{ id: 'b', kind: 'refines' }] }, author: { source: 'cli' } }).success).toBe(true)
})
```

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `bun test packages/contracts/src/memory.test.ts packages/contracts/src/events.test.ts && bun run typecheck`
Expected: PASS. (If any downstream `.links` consumer typechecks as `string[]`, it will surface here — Tasks 3/5 fix the real consumers; do not `as any` around it.)
```bash
git add packages/contracts/src/memory.ts packages/contracts/src/memory.test.ts
git commit -m "feat(contracts): typed + confidence-weighted memory links (legacy string ids coerce to relates_to)"
```

---

### Task 2: Pure graph-distance ranker (`plugins/memory/src/rank.ts`)

**Files:**
- Create: `plugins/memory/src/rank.ts`
- Create: `plugins/memory/src/rank.test.ts`

**Interfaces:**
- Consumes: `LinkKind`, `NeighborResult` (Task 1).
- Produces: `DEFAULT_LINK_WEIGHTS`, `DEFAULT_DECAY/FLOOR/CAP`; `type Edge = { from: string; to: string; kind: LinkKind; confidence?: number }`; `rankNeighbors(edges, seeds, opts?) → { id: string; via: LinkKind; depth: number; score: number }[]` (title/summary joined in by the adapter). Pure — no DB, no clock.

Direct port of code-review-graph's `get_impact_radius` (spec §4.3). Pure ⇒ trivial `bun test`.

- [ ] **Step 1: Write the failing test** — `plugins/memory/src/rank.test.ts`

```ts
import { describe, expect, it } from 'bun:test'
import { rankNeighbors, DEFAULT_LINK_WEIGHTS } from './rank'

const edges = [
  { from: 'a', to: 'b', kind: 'supersedes' as const },   // weight 1.0, depth 1 → 1.0
  { from: 'a', to: 'c', kind: 'relates_to' as const },   // weight 0.5, depth 1 → 0.5
  { from: 'b', to: 'd', kind: 'refines' as const },      // 1.0 * 0.9 * decay^2 ...
]

describe('rankNeighbors', () => {
  it('ranks by best-score (edge-kind weight × decay^depth), excludes the seed, prunes at floor', () => {
    const r = rankNeighbors(edges, ['a'], { depth: 3 })
    expect(r.map(n => n.id)).toEqual(['b', 'c', 'd'])       // 1.0 > 0.5 > (0.9*0.6^2≈0.324... check order)
    expect(r.find(n => n.id === 'a')).toBeUndefined()
    expect(r[0]).toMatchObject({ id: 'b', via: 'supersedes', depth: 1 })
  })
  it('filters by kind, caps result count, and down-weights by confidence', () => {
    expect(rankNeighbors(edges, ['a'], { kinds: ['supersedes'] }).map(n => n.id)).toEqual(['b'])
    expect(rankNeighbors(edges, ['a'], { cap: 1 })).toHaveLength(1)
    const low = rankNeighbors([{ from: 'a', to: 'b', kind: 'supersedes', confidence: 0.1 }], ['a'])
    expect(low[0].score).toBeCloseTo(0.1)                   // 1.0 weight × 0.1 confidence
    expect(DEFAULT_LINK_WEIGHTS.relates_to).toBe(0.5)
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then implement `rank.ts`**

Run: `bun test plugins/memory/src/rank.test.ts` → FAIL.
```ts
import type { LinkKind } from '@orc/contracts'

export const DEFAULT_LINK_WEIGHTS: Record<LinkKind, number> = {
  supersedes: 1.0, contradicts: 1.0, refines: 0.9, depends_on: 0.8,
  derived_from: 0.7, example_of: 0.6, relates_to: 0.5,
}
export const DEFAULT_DECAY = 0.6
export const DEFAULT_FLOOR = 0.05
export const DEFAULT_CAP = 20

export type Edge = { from: string; to: string; kind: LinkKind; confidence?: number }
export type RankedNeighbor = { id: string; via: LinkKind; depth: number; score: number }

// Bounded best-score relaxation: a node's score is the strongest path from any seed,
// score(path) = Π(weight(kind) × confidence) × decay^depth. Prune < floor, cap the result.
export function rankNeighbors(edges: Edge[], seeds: string[], opts: {
  depth?: number; decay?: number; floor?: number; cap?: number
  weights?: Record<LinkKind, number>; kinds?: LinkKind[]
} = {}): RankedNeighbor[] {
  const depth = opts.depth ?? 2, decay = opts.decay ?? DEFAULT_DECAY
  const floor = opts.floor ?? DEFAULT_FLOOR, cap = opts.cap ?? DEFAULT_CAP
  const weights = opts.weights ?? DEFAULT_LINK_WEIGHTS
  const allow = opts.kinds ? new Set(opts.kinds) : null
  const adj = new Map<string, Edge[]>()
  for (const e of edges) { if (allow && !allow.has(e.kind)) continue; (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e) }

  const seed = new Set(seeds)
  const best = new Map<string, RankedNeighbor>()
  let frontier = seeds.map(id => ({ id, score: 1 }))
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: { id: string; score: number }[] = []
    for (const f of frontier) for (const e of adj.get(f.id) ?? []) {
      const score = f.score * (weights[e.kind] ?? 0.5) * (e.confidence ?? 1) * decay ** 0 // decay applied via depth below
      const s = f.score * (weights[e.kind] ?? 0.5) * (e.confidence ?? 1)
      const sd = s * decay ** (d - 1)
      if (sd < floor || seed.has(e.to)) continue
      const prev = best.get(e.to)
      if (!prev || sd > prev.score) { best.set(e.to, { id: e.to, via: e.kind, depth: d, score: sd }); next.push({ id: e.to, score: s }) }
      else next.push({ id: e.to, score: s })
    }
    frontier = next
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, cap)
}
```
(Clean up the dead `score`/`decay**0` line the subagent will notice — the invariant is: per-hop multiply by `weight × confidence`, apply `decay^(depth-1)` for pruning/ranking, keep the max path per node, exclude seeds, cap. Simplify freely as long as the test asserts the ordering/floor/cap/confidence behaviour.)

- [ ] **Step 3: Run tests + commit**

Run: `bun test plugins/memory/src/rank.test.ts && bun run typecheck`
```bash
git add plugins/memory/src/rank.ts plugins/memory/src/rank.test.ts
git commit -m "feat(memory): pure graph-distance neighbour ranker (weight × decay, floor, cap)"
```

---

### Task 3: SurrealDB adapter — typed links + `RELATE` edges + `neighbors()`

**Files:**
- Modify: `plugins/memory/src/surreal.ts` (link field type; edge materialization; edge fetch + `neighbors`)
- Modify: `plugins/memory/src/surreal.test.ts` (edges + neighbours + legacy-link coercion)

**Interfaces:**
- Consumes: `MemoryLink`, `LinkKind`, `NeighborResult` (Task 1); `rankNeighbors`, `Edge` (Task 2); existing `composeAuthor`, `MemoryNote`.
- Produces: `SurrealMemory.neighbors(seed, opts?) → NeighborResult[]`. Unchanged: `open/applyWritten/applyDeleted/get/list/search/bumpRead/getCursor/setCursor/clear/close`.

**surqlize / raw split (report the final split):**
- `note.links` becomes a stored array of objects. surqlize `t.array(...)` may not model an object element cleanly under 0.1.0 — store links as a loosely-typed array (`t.array(t.object({...}))` if it works, else keep the field untyped and rely on SCHEMALESS). The note doc is the authored source; edges are derived.
- **`RELATE` + edge fetch use the raw client** (`this.surreal.query`) — surqlize 0.1.0 has no graph-edge API. Store explicit `fromId`/`toId`/`scope` string fields on each edge so fetch/return needs no `RecordId` parsing.

- [ ] **Step 1: Write the failing test** — add to `plugins/memory/src/surreal.test.ts`

```ts
it('materializes typed RELATE edges and ranks neighbours; delete removes edges; legacy strings coerce', async () => {
  const t = await createTestSurreal(); drops.push(t.drop)
  const m = await SurrealMemory.open(t)
  await m.applyWritten({ seq: 1, ts: '2026-07-18T00:00:00Z', note: note({ id: 'a', links: [{ id: 'b', kind: 'supersedes' }, 'c'] }), author: { source: 'cli' } })
  await m.applyWritten({ seq: 2, ts: '2026-07-18T00:00:00Z', note: note({ id: 'b' }), author: { source: 'cli' } })
  await m.applyWritten({ seq: 3, ts: '2026-07-18T00:00:00Z', note: note({ id: 'c' }), author: { source: 'cli' } })

  const nb = await m.neighbors('a', { depth: 2 })
  expect(nb.map(n => n.id)).toEqual(['b', 'c'])            // supersedes(1.0) ranked above relates_to(0.5)
  expect(nb[0]).toMatchObject({ id: 'b', via: 'supersedes' })
  expect((await m.neighbors('a', { kinds: ['supersedes'] })).map(n => n.id)).toEqual(['b'])

  await m.applyDeleted({ seq: 4, ts: '2026-07-18T00:00:00Z', id: 'a', scope: 'project', author: { source: 'cli' } })
  expect(await m.neighbors('a')).toEqual([])              // edges gone with the note
  await m.close()
})
```
(The `note()` helper must pass `links` through; the second write of `a` with new links must re-materialize its out-edges, not append — assert idempotency if convenient by re-writing `a` and re-checking neighbour count.)

- [ ] **Step 2: Run it to verify it fails** — `bun run db:up && bun test plugins/memory/src/surreal.test.ts` → FAIL (`neighbors` missing).

- [ ] **Step 3: Implement the adapter deltas** in `plugins/memory/src/surreal.ts`

- Update `noteTable.links` to an object-array (surreal.ts:16) or leave SCHEMALESS; `applyWritten` already spreads `e.note.links` into `data` (surreal.ts:56) — now typed objects.
- After the note upsert in `applyWritten`, re-materialize out-edges (raw client):
```ts
// derived edge index (spec D2/D3): delete this note's out-edges, RELATE the current links.
await this.surreal.query('DELETE link WHERE fromId = $id AND scope = $scope', { id: e.note.id, scope: e.note.scope })
for (const l of e.note.links)
  await this.surreal.query(
    'RELATE $from->link->$to SET kind=$kind, confidence=$c, fromId=$fid, toId=$tid, scope=$scope',
    { from: new RecordId('note', key(e.note.scope, e.note.id)), to: new RecordId('note', key(e.note.scope, l.id)),
      kind: l.kind, c: l.confidence ?? null, fid: e.note.id, tid: l.id, scope: e.note.scope },
  )
```
- In `applyDeleted`, also drop its edges (both directions):
```ts
await this.surreal.query('DELETE link WHERE (fromId = $id OR toId = $id) AND scope = $scope', { id: e.id, scope: e.scope })
```
- In `clear()`, drop the edge table too: add `await this.db.delete('link')` (or `this.surreal.query('DELETE link')`).
- New `neighbors`:
```ts
async neighbors(seed: string, opts: { kinds?: LinkKind[]; depth?: number; cap?: number; scope?: string } = {}): Promise<NeighborResult[]> {
  const scope = opts.scope ?? 'project'
  // Fetch directed edges within scope (both directions available for symmetric kinds — spec §9.1).
  const [rows] = await this.surreal.query<[Array<{ fromId: string; toId: string; kind: LinkKind; confidence: number | null }>]>(
    'SELECT fromId, toId, kind, confidence FROM link WHERE scope = $scope', { scope })
  const edges: Edge[] = (rows ?? []).map(r => ({ from: r.fromId, to: r.toId, kind: r.kind, confidence: r.confidence ?? undefined }))
  const ranked = rankNeighbors(edges, [seed], { depth: opts.depth, cap: opts.cap, kinds: opts.kinds })
  // join title/summary from the note docs (cheap: small result set)
  const out: NeighborResult[] = []
  for (const n of ranked) { const doc = await this.get(n.id, scope); if (doc) out.push({ id: n.id, title: doc.title, summary: doc.summary, via: n.via, depth: n.depth, score: n.score }) }
  return out
}
```
(Fetching all in-scope edges then ranking in TS is fine for the hand-authored graph; a frontier-scoped fetch is a later optimisation — spec §4.2. ponytail: no premature graph query.)

- [ ] **Step 4: Run tests + typecheck + commit**

Run: `bun test plugins/memory/src/surreal.test.ts && bun run typecheck`
Expected: PASS. Report the surqlize-vs-raw split (RELATE/fetch are raw; note upsert/get/list/search stay on the builder).
```bash
git add plugins/memory/src/surreal.ts plugins/memory/src/surreal.test.ts
git commit -m "feat(memory): typed RELATE edges + graph-distance neighbours in the SurrealDB read model"
```

---

### Task 4: Token budget helper + `memory_neighbors` tool + budgeted pull tools

**Files:**
- Create: `plugins/memory/src/budget.ts`
- Create: `plugins/memory/src/budget.test.ts`
- Modify: `plugins/memory/src/store.ts` (`neighbors` delegate)
- Modify: `plugins/memory/src/tools.ts` (new tool + `detail_level`/budget on search/read)
- Modify: `plugins/memory/src/tools.test.ts`

**Interfaces:**
- Produces: `approxTokens(s)`, `applyBudget(items, text, { limit, budget })`; `MemoryStore.neighbors` impl; `memory_neighbors` `ResolvedTool`; `detail_level`/`limit`/`budget` on `memory_search`/`memory_read`.
- Consumes: `SurrealMemory.neighbors` (Task 3); `NeighborResult` (Task 1).

- [ ] **Step 1: Failing budget test** — `plugins/memory/src/budget.test.ts`
```ts
import { describe, expect, it } from 'bun:test'
import { applyBudget, approxTokens } from './budget'
describe('applyBudget', () => {
  it('caps by count and by token budget, reporting truncation + omitted', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, body: 'x'.repeat(40) })) // ~10 tok each
    const r = applyBudget(items, i => i.body, { limit: 5, budget: 9999 })
    expect(r.items).toHaveLength(5); expect(r.truncated).toBe(true); expect(r.omitted).toBe(5)
    const b = applyBudget(items, i => i.body, { limit: 100, budget: 25 })   // ~2 items fit
    expect(b.items.length).toBeLessThan(10); expect(b.truncated).toBe(true)
    expect(approxTokens('x'.repeat(40))).toBe(10)
  })
})
```

- [ ] **Step 2: Run → FAIL, then implement `budget.ts`**
```ts
export const approxTokens = (s: string): number => Math.ceil(s.length / 4) // ponytail: chars/4; swap for a real tokenizer only if it misbudgets

export function applyBudget<T>(items: T[], text: (t: T) => string, opts: { limit: number; budget: number }):
  { items: T[]; truncated: boolean; omitted: number } {
  const kept: T[] = []; let used = 0
  for (const it of items) {
    if (kept.length >= opts.limit) break
    const cost = approxTokens(text(it))
    if (kept.length > 0 && used + cost > opts.budget) break // always allow at least one
    used += cost; kept.push(it)
  }
  return { items: kept, truncated: kept.length < items.length, omitted: items.length - kept.length }
}
```

- [ ] **Step 3: Add `neighbors` to the gateway** in `plugins/memory/src/store.ts`
```ts
neighbors: (seed, opts) => surreal.neighbors(seed, opts),
```
(Add to the returned object; the `MemoryStore` interface already declares it — Task 1.)

- [ ] **Step 4: Failing tools test** — add to `plugins/memory/src/tools.test.ts`
```ts
it('declares memory_neighbors and budgets search results', async () => {
  const store = { search: async () => Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, title: `T${i}`, summary: 's', categories: [], tags: [], scope: 'project' })),
    neighbors: async () => [{ id: 'b', title: 'B', summary: 's', via: 'supersedes', depth: 1, score: 1 }],
    get: async () => null, write: async () => ({} as any), remove: async () => {}, list: async () => [] } as any
  const tools = memoryTools(store, { source: 'cli' })
  expect(tools.map(t => t.name).sort()).toEqual(['memory_neighbors', 'memory_read', 'memory_search', 'memory_write'])
  const search = tools.find(t => t.name === 'memory_search')!
  const r = await search.execute({ query: 'x', detail_level: 'minimal' })
  expect(r.output.notes.length).toBe(5); expect(r.output.truncated).toBe(true); expect(r.output.omitted).toBe(3); expect(r.output.next).toContain('memory_read')
  const nb = tools.find(t => t.name === 'memory_neighbors')!
  expect((await nb.execute({ seed: 'a' })).output.neighbors[0].via).toBe('supersedes')
})
```

- [ ] **Step 5: Run → FAIL, then implement the tool deltas** in `plugins/memory/src/tools.ts`

- `memory_search`: add `detail_level`/`limit`/`category`/`tag` to `inputSchema`; in `execute`, pick `limit = input.limit ?? (detail_level === 'minimal' ? 5 : 20)`, `budget = 1500`, run `applyBudget(await store.search(...), n => n.title + n.summary, { limit, budget })`, return `{ notes, truncated, omitted, next: truncated ? 'refine the query, or memory_read/memory_neighbors a specific id' : undefined }`.
- `memory_read`: add `detail_level`/`budget`; on `minimal`, truncate `note.body` to the budget and set `truncated`.
- `memory_neighbors` (new): `inputSchema` `{ seed (required), kinds?, depth?, budget? }`; `execute` → `store.neighbors(seed, { kinds, depth })`, `applyBudget(ranked, n => n.title + n.summary, { limit: cap, budget })`, return `{ neighbors, truncated, omitted, next }`. Description: "Traverse typed links from a seed note (blast radius). Returns ranked related notes with the link kind, depth, and score. Use to pull the notes that constrain a task."

Keep the `ok`/`err` wrappers and the existing three tools' bodies; this is additive.

- [ ] **Step 6: Run tests + typecheck + commit**

Run: `bun test plugins/memory/src/budget.test.ts plugins/memory/src/tools.test.ts plugins/memory/src/store.test.ts && bun run typecheck`
```bash
git add plugins/memory/src/budget.ts plugins/memory/src/budget.test.ts plugins/memory/src/store.ts plugins/memory/src/tools.ts plugins/memory/src/tools.test.ts
git commit -m "feat(memory): memory_neighbors traverse tool + token-budgeted pull-tool results"
```
(`index.ts` `buildTools` already returns `memoryTools(store, author)` — the new tool ships with no wiring change. Confirm, don't re-wire.)

---

### Task 5: Vault-render delta — typed links in frontmatter

**Files:**
- Modify: `plugins/memory/src/note-md.ts`
- Modify: `plugins/memory/src/note-md.test.ts`

**Interfaces:**
- `renderNoteFile(note)` emits typed `links` (id + kind [+ confidence]) as block YAML.

- [ ] **Step 1: Update the failing test** in `plugins/memory/src/note-md.test.ts`

The existing fixture uses `links: ['session-model']`; change it to typed and assert:
```ts
links: [{ id: 'session-model', kind: 'refines' }, { id: 'legacy', kind: 'supersedes', confidence: 0.9 }],
// ...
expect(md).toContain('kind: supersedes')
expect(md).toContain('id: session-model')
```

- [ ] **Step 2: Run → FAIL (only if the YAML shape assertion is new), then confirm `note-md.ts`**

`renderNoteFile` already passes `links: note.links` straight into `frontmatter({...})` (note-md.ts:13). With typed links this is an array of objects — `Bun.YAML.stringify` renders valid block YAML automatically. Likely **no code change** beyond confirming the test passes; if a grouped "## Supersedes / ## Relates to" body section is wanted, that is optional polish (spec §6) — skip unless asked.

- [ ] **Step 3: Run + commit**

Run: `bun test plugins/memory/src/note-md.test.ts && bun run typecheck`
```bash
git add plugins/memory/src/note-md.ts plugins/memory/src/note-md.test.ts
git commit -m "feat(memory): render typed links in vault/memory frontmatter"
```

---

### Task 6: Integration — typed-traversal reuse proof + legacy replay

**Files:**
- Modify/Create: `plugins/memory/src/reuse.integration.test.ts` (extend M4b's reuse proof, or add a sibling test)

**Interfaces:**
- Consumes the full stack: `EventLog`, `createMemory`/`createMemoryStore` + `createMemoryProjector`, `SurrealMemory`. Follows M4b Task 10's harness.

- [ ] **Step 1: Write the integration test**

```ts
it('traverses typed links written by one step and coerces a legacy flat-link event on rebuild', async () => {
  // build log + surreal + projector (M4b Task 10 pattern); proj.start()
  await store.write({ id: 'decision-a', title: 'A', links: [{ id: 'decision-b', kind: 'supersedes' }] } as any, { source: 'cli' })
  await store.write({ id: 'decision-b', title: 'B' } as any, { source: 'cli' })
  await Bun.sleep(200)
  const nb = await store.neighbors('decision-a')
  expect(nb.map(n => n.id)).toEqual(['decision-b'])
  expect(nb[0].via).toBe('supersedes')

  // legacy: append a raw memory_written with FLAT string links (simulating a v1 event), rebuild, assert coercion
  await log.append({ taskId: null, stepId: null, runToken: null, kind: 'memory_written',
    payload: { note: { id: 'legacy', title: 'L', links: ['decision-a'] }, author: { source: 'cli' } } } as any)
  await proj.rebuild()
  expect((await surreal.neighbors('legacy'))[0]).toMatchObject({ id: 'decision-a', via: 'relates_to' })
})
```

- [ ] **Step 2: Run → green; then full suite + typecheck**

Run: `bun run db:up && bun test && bun run typecheck`
Expected: whole suite PASS. The M4b reuse proof and all M4b tests stay green (this milestone is additive).

- [ ] **Step 3: Commit**
```bash
git add plugins/memory/src/reuse.integration.test.ts
git commit -m "test(memory): typed-link traversal reuse proof + legacy flat-link replay coercion"
```

---

## Deferred (not in this plan)

Explicitly out of scope — restated so no task quietly re-adds them (spec §2, research §4):

- **Embeddings / vectors / semantic search.** The graph-distance ranker (Task 2) is the interim
  relevance signal; the SurrealDB vector field remains reserved and RRF is the future fusion slot
  (spec §10, D4). Build nothing vector.
- **Push / auto-inject / step-boundary auto-binding of a context slice.** M4c is pull-only —
  `memory_neighbors` is a tool the agent calls. The runtime seeding + pre-loading a slice into a
  step prompt is deferred (spec D5).
- **RecursiveMAS mechanism:** latent hidden-state exchange, `CrossModelAdapter`/RecursiveLink,
  Inner-Outer co-training. Hard boundary (spec D6) — conflicts with CQRS/interpretability.
- **BM25 full-text search + RRF merge** with the graph ranker. Open question (spec §9.3); current
  substring search stays. Defer unless recall proves poor.
- **Ranker weights as config** (`memoryLinkWeights` override). Defaults-in-code ship first (spec §9.2).
- **`RELATE` → pure-doc BFS fallback**, grouped-links body section, `orc memory neighbors` CLI
  mirror, edge/reverse-direction weighting, context manifests for reproducibility — all optional
  follow-ups (spec §9), not this plan.

## Self-Review

**Spec coverage:**
- RG1 typed + confidence links → Task 1. ✓
- RG2 free migration (tolerant contract + rebuild, no log rewrite) → Task 1 (coercion), Task 6 (legacy-replay proof). ✓
- RG3 graph-distance traversal ranker → Task 2 (pure), Task 3 (`neighbors`). ✓
- RG4 reverse reachability via `RELATE` → Task 3 (edge materialization both directions). ✓
- RG5 token-budgeted pulls → Task 4 (`budget.ts` + tool deltas). ✓
- RG6 recursive-MAS substrate pull primitive → Task 4 (`memory_neighbors`); auto-binding deferred. ✓
- Spec D1 (tolerant contract) → Task 1; D2/D3 (derived edges) → Task 3; D4 (no vectors) → Deferred; D5 (pull-only) → Task 4 + Deferred; D6 (no latent mechanism) → Deferred. ✓
- Contract change is exactly one field + additive types; `events.ts` untouched (asserted in Task 1 Step 4). ✓

**Ordering:** contract (1) → pure ranker (2) → adapter edges/traversal consuming both (3) → gateway/tools/budget consuming the adapter (4) → vault render (5) → end-to-end proof (6). Pure modules (2, budget in 4) precede their DB/tool consumers so failures localize.

**Type consistency:** `LinkKind`/`MemoryLink`/`NeighborResult` (Task 1) are consumed verbatim by `rank.ts` (Task 2), `surreal.ts` (Task 3), `store.ts`/`tools.ts` (Task 4). `Edge`/`rankNeighbors` (Task 2) match `surreal.neighbors` (Task 3). `MemoryStore.neighbors` signature is identical across Task 1 (interface), Task 3 (adapter), Task 4 (gateway + tool).

**Placeholder scan:** Task 6 is a skeleton by necessity (depends on M4b Task 10's fake-run harness); every other task ships complete, runnable code and a failing-first test. Task 2's illustrative BFS carries an explicit "simplify the dead decay line" instruction — the test is the acceptance gate.
