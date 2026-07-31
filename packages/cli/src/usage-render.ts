import type { Usage } from '@orc/contracts'

// Compile-time guard against a silently-dropped Usage field (the roadmap's "DraftCoversTiers
// precedent", rebuilt here since no literal match existed in this tree): if
// contracts/execution.ts's Usage schema ever gains a field, this Record fails to typecheck unless
// every key is added here too. The failure this exists to prevent: a field priced by
// costUSDFor (packages/contracts/src/execution.ts) but never carried to ANY render site — before
// this file existed, `orc status`'s trailing task-total line was the only place Usage was
// rendered at all, and every other decision surface (per-step lines, the terminal summary, the
// approval-door estimate) silently dropped it.
const USAGE_FIELDS_COVERED: Record<keyof Usage, true> = {
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  costUSD: true,
  estimated: true,
}

// One render of a Usage total, shared by every decision surface that shows one (`orc status`'s
// per-step lines and its trailing task-total line, the terminal summary printed after a watched
// run settles) so the shape — and the cache/cost omission rules — cannot drift between them.
// Exactly reproduces the shape main.ts's status command printed before this file existed:
// 'tokens in/out: X/Y  cache r/w: A/B  cost: $Z(.toFixed(4))( (est))', with the cache segment
// omitted when both cacheReadTokens and cacheWriteTokens are falsy, and cost 'n/a' when costUSD
// is null.
export function formatUsageLine(u: Usage): string {
  void USAGE_FIELDS_COVERED // referenced so the guard above cannot be dead-code-eliminated
  const cache = u.cacheReadTokens || u.cacheWriteTokens
    ? `  cache r/w: ${u.cacheReadTokens ?? 0}/${u.cacheWriteTokens ?? 0}`
    : '' // no cache split recorded
  const cost = u.costUSD === null ? 'n/a' : `$${u.costUSD.toFixed(4)}${u.estimated ? ' (est)' : ''}`
  return `tokens in/out: ${u.inputTokens}/${u.outputTokens}${cache}  cost: ${cost}`
}
