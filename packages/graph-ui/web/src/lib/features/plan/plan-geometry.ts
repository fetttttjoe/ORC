// Ranks and lanes to pixel boxes; children are RELATIVE to their container, as Svelte Flow requires
export interface PlacedStep {
  id: string
  rank: number
  lane: number
}

export interface GeometrySpec {
  nodeW: number
  nodeH: number
  /** gap between containers, i.e. between waves */
  gapX: number
  /** gap between steps stacked inside one wave */
  gapY: number
  /** container inset around its steps; padTop leaves room for the wave's own label */
  padX: number
  padTop: number
  padBottom: number
}

export const DEFAULT_GEOMETRY: GeometrySpec = {
  nodeW: 176, nodeH: 34, gapX: 56, gapY: 10, padX: 12, padTop: 26, padBottom: 12,
}

export interface Box { x: number; y: number; width: number; height: number }
export interface GroupBox extends Box { id: string; rank: number; count: number }
/** `x`/`y` are relative to the owning group */
export interface StepBox extends Box { id: string; groupId: string }

export interface PlanGeometry {
  groups: GroupBox[]
  steps: StepBox[]
  width: number
  height: number
}

/** the ONE spelling of a wave container's id, so the flow adapter and any test agree on it */
export const groupIdFor = (rank: number): string => `wave:${rank}`

export function planGeometry(placed: readonly PlacedStep[], spec: GeometrySpec = DEFAULT_GEOMETRY): PlanGeometry {
  const byRank = Map.groupBy(placed, p => p.rank)

  const groups: GroupBox[] = []
  const steps: StepBox[] = []
  const groupW = spec.nodeW + spec.padX * 2

  // uniform pitch, every container as TALL as the fullest wave; short waves centre their steps
  const tallest = Math.max(0, ...[...byRank.values()].map(b => b.length))
  const groupH = spec.padTop + spec.padBottom + tallest * spec.nodeH + Math.max(0, tallest - 1) * spec.gapY

  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const bucket = (byRank.get(rank) ?? []).slice().sort((a, b) => a.lane - b.lane)
    const id = groupIdFor(rank)
    groups.push({ id, rank, count: bucket.length, x: rank * (groupW + spec.gapX), y: 0, width: groupW, height: groupH })

    const stackH = bucket.length * spec.nodeH + Math.max(0, bucket.length - 1) * spec.gapY
    const top = spec.padTop + Math.max(0, (groupH - spec.padTop - spec.padBottom - stackH) / 2)
    bucket.forEach((p, i) => {
      steps.push({ id: p.id, groupId: id, x: spec.padX, y: top + i * (spec.nodeH + spec.gapY), width: spec.nodeW, height: spec.nodeH })
    })
  }

  return {
    groups,
    steps,
    width: groups.length === 0 ? 0 : groups.length * groupW + (groups.length - 1) * spec.gapX,
    height: groups.length === 0 ? 0 : groupH,
  }
}
