/**
 * The dependency-editing rules for a plan draft: add a link, remove a link, and the guard that
 * decides whether a link may exist at all. Pure functions over step records, zero imports.
 *
 * This is the seam the operator's pre-approval editor stands on. It lives apart from the flow
 * adapter deliberately: "may these two steps be linked?" is a PLAN question whose answer must hold
 * whatever draws it, and burying it in a renderer would mean the CLI and the canvas could disagree
 * about what a legal plan is. Nothing here knows about pixels, Svelte, or Svelte Flow.
 *
 * Every function returns a NEW array and never mutates its input — the caller owns its draft, and
 * an editor that mutates the query cache's copy corrupts the view it is editing.
 */
export interface EditableStep {
  id: string
  dependsOn: readonly string[]
}

/** Would `from → to` close a cycle? True when `to` already reaches `from` transitively. */
export function wouldCycle<T extends EditableStep>(steps: readonly T[], from: string, to: string): boolean {
  if (from === to) return true
  const byId = new Map(steps.map(s => [s.id, s]))
  // walk BACKWARDS from `from` along its existing dependencies: if `to` is already upstream of
  // `from`, then adding from → to closes the loop
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

/** Why a link is refused, or null when it is allowed — the message an editor shows the operator. */
export function linkRefusal<T extends EditableStep>(steps: readonly T[], from: string, to: string): string | null {
  const byId = new Map(steps.map(s => [s.id, s]))
  if (!byId.has(from) || !byId.has(to)) return 'both steps must belong to this plan'
  if (from === to) return 'a step cannot wait for itself'
  if (byId.get(to)?.dependsOn.includes(from) === true) return 'that dependency already exists'
  // The check that matters: a plan with a cycle has no execution order, so the wave layering
  // stops dead and the run would never start. Refuse at the edit, where it can still be undone.
  if (wouldCycle(steps, from, to)) return `that would make ${from} and ${to} wait for each other`
  return null
}

/** `to` starts waiting on `from`. A refused link returns the steps untouched — callers show `linkRefusal`. */
export function linkSteps<T extends EditableStep>(steps: readonly T[], from: string, to: string): T[] {
  if (linkRefusal(steps, from, to) !== null) return [...steps]
  return steps.map(s => (s.id === to ? { ...s, dependsOn: [...s.dependsOn, from] } : { ...s }))
}

/** `to` stops waiting on `from`. Removing a link that was never there is a no-op, not an error. */
export function unlinkSteps<T extends EditableStep>(steps: readonly T[], from: string, to: string): T[] {
  return steps.map(s => (s.id === to ? { ...s, dependsOn: s.dependsOn.filter(d => d !== from) } : { ...s }))
}
