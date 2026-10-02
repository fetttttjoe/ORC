const CHARS_PER_TOKEN = 4

export const tokensOf = (line: string): number => Math.ceil(line.length / CHARS_PER_TOKEN)

export interface Candidate<T> { id: string; cost: number; item: T }

export function assemblePreload<T>(arms: ReadonlyArray<ReadonlyArray<Candidate<T>>>, budget: number): Array<{ arm: number; item: T }> {
  if (budget <= 0) return []
  const taken = new Set<string>()
  const chosen: Array<{ arm: number; item: T }> = []
  let left = budget
  for (const [arm, candidates] of arms.entries()) {
    for (const candidate of candidates) {
      if (taken.has(candidate.id)) continue
      if (chosen.length > 0 && candidate.cost > left) continue
      taken.add(candidate.id)
      chosen.push({ arm, item: candidate.item })
      left -= candidate.cost
    }
  }
  return chosen
}
