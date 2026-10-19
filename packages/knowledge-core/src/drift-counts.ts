import { ClaimState, type ClaimDrift } from '@orc/contracts'

export const driftCounts = (drifts: readonly ClaimDrift[]): Record<ClaimState, number> => {
  const counts: Record<ClaimState, number> = { [ClaimState.clean]: 0, [ClaimState.suspect]: 0, [ClaimState.unknown]: 0, [ClaimState.unanchored]: 0 }
  for (const d of drifts) counts[d.state]++
  return counts
}
