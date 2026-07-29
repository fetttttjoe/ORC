// Which part of the knowledge graph is under-developed, and nothing else: no store, no embedder, no
// clock (the caller supplies `now`). Pure so the ranking is testable against a hand-built graph and
// so replacing the formula touches this file alone.
//
// A note that links OUT to more than links IN is one that has named work nobody has done: it points
// at subjects it does not itself cover. Weighted toward recency, because a note touched today names
// live gaps and one untouched for a year names abandoned ones.
//
// ponytail: degree difference, not a centrality measure. If the graph ever grows a real hub/authority
// structure, this is the file where HITS or PageRank replaces it.
//
// This is a lead, not a verdict — degree counts are graph SHAPE, not a measurement that a note is
// actually thin. Run against the live project graph (19 semantic notes, out-degree 0-12 and only
// three notes above 6, 2026-07-28): one or two links either way flips a rank, and nothing here
// corroborates a hit against anything the graph doesn't already know about itself. What would
// upgrade a hit from "shaped like a gap" to "is a gap": a retrieval miss that names it (a search
// with no result that this note's title would have answered) or an agent asking for knowledge this
// note claims to cover and not finding it. Neither signal exists yet — this file cannot manufacture
// it, only rank shape.

export interface FrontierNote {
  id: string
  scope: string
  title: string
  tier: string
  links: readonly string[]
  updatedAt: string
}

export interface FrontierHit { id: string; scope: string; title: string; out: number; in: number; score: number }

// Half-life of the recency weight, in days. The ONE tunable here, and a [conjecture] rather than a
// measurement — taken from the source this formula came from (claude-obsidian Mechanism 4), whose
// own doc tags the exact weighting as unvalidated against retrieval metrics. It is a starting form:
// re-tune it the day someone acts on this list and finds it pointed at the wrong notes.
const FRONTIER_HALF_LIFE_DAYS = 30

// Only durable project knowledge has a frontier. A plan node names its own sub-steps by design and
// an episodic note is one run's trail — both would rank as permanent "gaps" that nothing can close.
const FRONTIER_TIER = 'semantic'

const DAY_MS = 86_400_000

export function frontier(
  notes: readonly FrontierNote[],
  now: string,
  opts: { limit?: number } = {},
): FrontierHit[] {
  const scoreable = notes.filter(n => n.tier === FRONTIER_TIER)
  const key = (scope: string, id: string): string => `${scope}/${id}`
  const live = new Set(scoreable.map(n => key(n.scope, n.id)))

  const inbound = new Map<string, number>()
  for (const n of scoreable)
    // distinct targets, and only targets that EXIST: a link to a note nobody wrote is a dangling
    // edge, which unresolvedLinks already reports — counting it here would report one defect twice.
    for (const t of new Set(n.links)) {
      const k = key(n.scope, t)
      if (live.has(k)) inbound.set(k, (inbound.get(k) ?? 0) + 1)
    }

  const nowMs = Date.parse(now)
  const hits: FrontierHit[] = []
  for (const n of scoreable) {
    const out = [...new Set(n.links)].filter(t => live.has(key(n.scope, t))).length
    const inn = inbound.get(key(n.scope, n.id)) ?? 0
    // The frontier is the EDGE of the connected graph, not its outside. A note only reaches that
    // edge if something in the graph reaches IT — in >= 1 is part of what "edge" means, not a
    // calibrated cutoff.
    //
    // This has a real cost, and it is not the same for the two shapes it excludes. For a root index
    // (arch-overview: out 12, in 0) the exclusion is simply correct — a hub by design, not a gap.
    // For an island — a freshly-authored note pointing at real gaps that nothing has linked back to
    // YET — the exclusion is a trade, not a non-issue: that note is exactly the kind of thing this
    // tool exists to surface, and it is invisible here until something else links to it. This
    // formula cannot tell the two shapes apart from degree alone, so it discards both rather than
    // guess. The question "does anything reference this note at all" is answered elsewhere, from
    // the opposite direction — sweep.ts's `unreferenced` already asks it, for deletion candidacy —
    // but that is a different question (should this go) from this one (is this thin), and nothing
    // here re-derives it. A brand-new unlinked note stays invisible to `frontier` until it earns an
    // inbound link or is checked by hand.
    if (inn === 0) continue
    if (out <= inn) continue // settled, or a leaf everything points at — not the frontier
    const updatedMs = Date.parse(n.updatedAt)
    // An unparseable timestamp decays to nothing rather than throwing: a malformed row must not take
    // the whole read-out down, and ranking it last is the honest place for a note we cannot date.
    const days = Number.isNaN(updatedMs) ? Infinity : Math.max(0, (nowMs - updatedMs) / DAY_MS)
    hits.push({ id: n.id, scope: n.scope, title: n.title, out, in: inn, score: (out - inn) * Math.exp(-days / FRONTIER_HALF_LIFE_DAYS) })
  }
  // ties broken by id so the read-out is a pure function of the graph, not of fold order
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return opts.limit === undefined ? hits : hits.slice(0, opts.limit)
}
