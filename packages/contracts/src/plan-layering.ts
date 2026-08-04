// The ONE answer to "which steps of this plan run together, and in what order" — the layering the
// run scheduler enacts, the wave rail draws, and the dependency graph positions by. Zero imports
// (the step-ids.ts / health.ts shape) so the browser bundle takes it without the server chain.
//
// It exists because there were TWO implementations: ui-core's todoWaves (Kahn layering, feeding
// the rail) and the console's planLayout (longest-path ranks, feeding the graph). They agreed on
// healthy plans by luck and DISAGREED on broken ones — todoWaves dropped the steps of a cycle
// entirely while planLayout parked them, so one plan rendered with different steps depending on
// which surface you looked at. Two answers to one question is the defect; this file is the answer.

export interface LayerableStep {
  id: string
  dependsOn: readonly string[]
}

/**
 * Rank per step: 0 for a step that waits on nothing, otherwise one past its LATEST dependency.
 * Longest path, not shortest — a step drawn beside something it actually waits for would
 * contradict the order the scheduler runs them in.
 *
 * A dependency naming something outside this plan cannot block it (the freeze heals those), and
 * steps in a dependency CYCLE are ranked into a trailing layer rather than dropped: a plan the
 * operator cannot see is worse than one drawn imperfectly, and a vanished step reads as a plan
 * that never had it. `cyclic` names them so a caller can say so out loud.
 */
export function stepRanks<T extends LayerableStep>(steps: readonly T[]): { rank: Map<string, number>; cyclic: Set<string> } {
  const byId = new Map(steps.map(s => [s.id, s]))
  const rank = new Map<string, number>()
  // read only once every dependency is ranked, so the default never fires; it keeps the lookup
  // assertion-free, since a `!` here is the one place the layering could quietly lie
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

/** The ranks above, grouped into waves. Declaration order is kept inside a wave, so one plan always draws the same way. */
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
