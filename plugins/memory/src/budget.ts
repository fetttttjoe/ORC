export const approxTokens = (s: string): number => Math.ceil(s.length / 4) // ponytail: chars/4; swap for a real tokenizer only if it misbudgets

export function applyBudget<T>(items: T[], text: (t: T) => string, opts: { limit: number; budget: number }):
  { items: T[]; truncated: boolean; omitted: number } {
  const kept: T[] = []
  let used = 0
  for (const it of items) {
    if (kept.length >= opts.limit) break
    const cost = approxTokens(text(it))
    if (kept.length > 0 && used + cost > opts.budget) break // always allow at least one
    used += cost
    kept.push(it)
  }
  return { items: kept, truncated: kept.length < items.length, omitted: items.length - kept.length }
}
