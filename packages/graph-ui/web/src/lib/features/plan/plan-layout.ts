import { stepRanks, type LayerableStep } from '@orc/contracts/plan-layering'

/**
 * Where each step sits in a layered drawing: `rank` is the column, `lane` the row within it.
 *
 * The ranks come from contracts/plan-layering — the SAME function the server's wave rail groups
 * by. It used to be computed here too, and the two copies disagreed about cyclic plans, so a plan
 * could render with different steps in the rail than in the graph. This file now decides only the
 * one thing the layering does not: which row a step takes inside its column.
 */
export type LayoutStep = LayerableStep

export interface PlacedStep {
  id: string
  rank: number
  lane: number
}

export interface PlanLayout {
  steps: PlacedStep[]
  /** dependency edges, minus any pointing outside this plan — those name nothing to draw */
  edges: { from: string; to: string }[]
  /** ids the layering could not order; the caller may say so rather than drawing a silent lie */
  cyclic: Set<string>
}

export function planLayout(steps: readonly LayoutStep[]): PlanLayout {
  const ids = new Set(steps.map(s => s.id))
  const { rank, cyclic } = stepRanks(steps)
  const rankOf = (id: string): number => rank.get(id) ?? 0

  // lanes: declaration order within a column, so the same plan always draws the same way
  const nextLane = new Map<number, number>()
  const placed: PlacedStep[] = steps.map(s => {
    const r = rankOf(s.id)
    const lane = nextLane.get(r) ?? 0
    nextLane.set(r, lane + 1)
    return { id: s.id, rank: r, lane }
  })

  return {
    steps: placed,
    edges: steps.flatMap(s => s.dependsOn.filter(d => ids.has(d)).map(from => ({ from, to: s.id }))),
    cyclic,
  }
}
