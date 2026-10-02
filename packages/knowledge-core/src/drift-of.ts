import { anchorState, claimState, NO_ANCHOR_EVIDENCE, type ClaimDrift, type ClaimReading } from '@orc/contracts'
import { anchorEvidence, type Evidence } from './evidence'

export function driftOf(readings: readonly ClaimReading[], evidence: Evidence | null): ClaimDrift[] {
  return readings.map(({ claim, basis, anchors }) => {
    const judged = anchors.map(a => ({
      ...a, state: anchorState(a, evidence === null ? NO_ANCHOR_EVIDENCE : anchorEvidence(evidence, claim.id, claim.text, a.path, a.symbol)),
    }))
    return { claim, state: claimState(judged.map(a => a.state)), basis, anchors: judged }
  })
}
