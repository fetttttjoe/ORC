import { stepRanks, type LayerableStep } from '@orc/contracts/plan-layering'

export type { LayerableStep }

// Where each step sits: `rank` is the column, `lane` the row; ranks come from plan-layering
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

export function planLayout(steps: readonly LayerableStep[]): PlanLayout {
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
