// Dependencies first, ties by declaration order; a cycle's remainder is appended, never dropped
export interface OrderableStep {
  id: string
  dependsOn: readonly string[]
}

export function topoOrder<T extends OrderableStep>(steps: readonly T[]): T[] {
  const byId = new Map(steps.map(s => [s.id, s]))
  const placed = new Set<string>()
  const out: T[] = []

  let progressed = true
  while (progressed && out.length < steps.length) {
    progressed = false
    for (const s of steps) {
      if (placed.has(s.id)) continue
      // a dependency that is not a step of this plan cannot block it (the freeze heals those)
      const ready = s.dependsOn.every(d => !byId.has(d) || placed.has(d))
      if (!ready) continue
      placed.add(s.id)
      out.push(s)
      progressed = true
    }
  }
  for (const s of steps) if (!placed.has(s.id)) out.push(s)
  return out
}
