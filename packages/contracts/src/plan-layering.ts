// the one layering the scheduler, wave rail and dependency graph share; zero imports

export interface LayerableStep {
  id: string
  dependsOn: readonly string[]
}

// longest path; cyclic steps go to a trailing layer rather than being dropped
export function stepRanks<T extends LayerableStep>(steps: readonly T[]): { rank: Map<string, number>; cyclic: Set<string> } {
  const byId = new Map(steps.map(s => [s.id, s]))
  const rank = new Map<string, number>()
  // never fires once ranked; keeps the lookup free of non-null assertions
  const rankOf = (id: string): number => rank.get(id) ?? 0

  let progressed = true
  while (progressed && rank.size < steps.length) {
    progressed = false
    for (const s of steps) {
      if (rank.has(s.id)) continue
      const deps = s.dependsOn.filter(d => byId.has(d))
      if (!deps.every(d => rank.has(d))) continue
      rank.set(s.id, deps.length === 0 ? 0 : Math.max(...deps.map(rankOf)) + 1)
      progressed = true
    }
  }

  const cyclic = new Set(steps.filter(s => !rank.has(s.id)).map(s => s.id))
  if (cyclic.size > 0) {
    const parked = Math.max(-1, ...rank.values()) + 1
    for (const id of cyclic) rank.set(id, parked)
  }
  return { rank, cyclic }
}

export interface Layer<T> {
  /** 1-based, because every surface labels the first one "wave 1" */
  wave: number
  parallel: boolean
  steps: T[]
}

// ranks grouped into waves; declaration order is kept inside a wave
export function layerSteps<T extends LayerableStep>(steps: readonly T[]): { layers: Layer<T>[]; cyclic: Set<string> } {
  const { rank, cyclic } = stepRanks(steps)
  const byRank = Map.groupBy(steps, s => rank.get(s.id) ?? 0)
  const layers = [...byRank.keys()]
    .sort((a, b) => a - b)
    .map((r, i) => {
      const group = byRank.get(r) ?? []
      return { wave: i + 1, parallel: group.length > 1, steps: group }
    })
  return { layers, cyclic }
}
