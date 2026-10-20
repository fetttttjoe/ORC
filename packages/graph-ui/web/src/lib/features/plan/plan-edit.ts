// Pure dependency-edit rules over step records; every function returns a NEW array, never mutates
export interface EditableStep {
  id: string
  dependsOn: readonly string[]
}

/** Would `from → to` close a cycle? True when `to` already reaches `from` transitively. */
export function wouldCycle<T extends EditableStep>(steps: readonly T[], from: string, to: string): boolean {
  if (from === to) return true
  const byId = new Map(steps.map(s => [s.id, s]))
  // walk BACKWARDS from `from`: if `to` is upstream of it, the link closes a loop
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    if (id === to) return true
    for (const dep of byId.get(id)?.dependsOn ?? []) stack.push(dep)
  }
  return false
}

/** Why a link is refused, or null when allowed: the message an editor shows */
export function linkRefusal<T extends EditableStep>(steps: readonly T[], from: string, to: string): string | null {
  const byId = new Map(steps.map(s => [s.id, s]))
  if (!byId.has(from) || !byId.has(to)) return 'both steps must belong to this plan'
  if (from === to) return 'a step cannot wait for itself'
  if (byId.get(to)?.dependsOn.includes(from) === true) return 'that dependency already exists'
  // a cyclic plan has no execution order and never starts: refuse at the edit
  if (wouldCycle(steps, from, to)) return `that would make ${from} and ${to} wait for each other`
  return null
}

/** `to` starts waiting on `from`; a refused link returns the steps untouched */
export function linkSteps<T extends EditableStep>(steps: readonly T[], from: string, to: string): T[] {
  if (linkRefusal(steps, from, to) !== null) return [...steps]
  return steps.map(s => (s.id === to ? { ...s, dependsOn: [...s.dependsOn, from] } : { ...s }))
}

/** `to` stops waiting on `from`. Removing a link that was never there is a no-op, not an error. */
export function unlinkSteps<T extends EditableStep>(steps: readonly T[], from: string, to: string): T[] {
  return steps.map(s => (s.id === to ? { ...s, dependsOn: s.dependsOn.filter(d => d !== from) } : { ...s }))
}
