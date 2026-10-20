import type { Usage } from '@orc/contracts'

// compile-time guard: a Usage field added to the schema fails typecheck until rendered here too
const USAGE_FIELDS_COVERED: Record<keyof Usage, true> = {
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  costUSD: true,
  estimated: true,
}

// one render of a Usage total for every decision surface, so omission rules cannot drift
export function formatUsageLine(u: Usage): string {
  void USAGE_FIELDS_COVERED // referenced so the guard above cannot be dead-code-eliminated
  const cache = u.cacheReadTokens || u.cacheWriteTokens
    ? `  cache r/w: ${u.cacheReadTokens ?? 0}/${u.cacheWriteTokens ?? 0}`
    : '' // no cache split recorded
  const cost = u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`
  return `tokens in/out: ${u.inputTokens}/${u.outputTokens}${cache}  cost: ${cost}`
}
