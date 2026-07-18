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

// Bounded best-score relaxation: score(path) = Π(weight(kind) × confidence) × decay^(depth-1).
// Keep the strongest path per node, exclude seeds, prune below floor, cap the result.
export function rankNeighbors(edges: Edge[], seeds: string[], opts: {
  depth?: number; floor?: number; cap?: number; kinds?: LinkKind[]
} = {}): RankedNeighbor[] {
  const depth = opts.depth ?? 2, decay = DEFAULT_DECAY
  const floor = opts.floor ?? DEFAULT_FLOOR, cap = opts.cap ?? DEFAULT_CAP
  const weights = DEFAULT_LINK_WEIGHTS
  const allow = opts.kinds ? new Set(opts.kinds) : null

  const adj = new Map<string, Edge[]>()
  for (const e of edges) {
    if (allow && !allow.has(e.kind)) continue
    const list = adj.get(e.from)
    if (list) list.push(e)
    else adj.set(e.from, [e])
  }

  const seedSet = new Set(seeds)
  const best = new Map<string, RankedNeighbor>()
  let frontier = seeds.map(id => ({ id, score: 1 }))
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: { id: string; score: number }[] = []
    for (const f of frontier) for (const e of adj.get(f.id) ?? []) {
      const s = f.score * (weights[e.kind] ?? 0.5) * (e.confidence ?? 1)
      const sd = s * decay ** (d - 1)
      if (sd < floor || seedSet.has(e.to)) continue
      const prev = best.get(e.to)
      // sd is monotone along the best path (sd_next = sd × weight × conf × decay),
      // so only an improved node needs re-expansion.
      if (!prev || sd > prev.score) {
        best.set(e.to, { id: e.to, via: e.kind, depth: d, score: sd })
        next.push({ id: e.to, score: s })
      }
    }
    frontier = next
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, cap)
}
