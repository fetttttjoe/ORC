import { anchorState, CheckVerdict, claimState, type ClaimDrift, type ClaimReading, type KnowledgeCheckedPayload } from '@orc/contracts'

const acceptKey = (id: string, text: string, path: string, symbol: string | null): string => JSON.stringify([id, text, path, symbol])

export function driftOf(readings: readonly ClaimReading[], checks: readonly KnowledgeCheckedPayload[]): ClaimDrift[] {
  const accepted = new Map<string, string[]>()
  for (const check of checks) {
    if (check.verdict !== CheckVerdict.holds) continue
    for (const a of check.anchors) {
      if (a.digest === null) continue
      const key = acceptKey(check.id, check.text, a.path, a.symbol)
      accepted.set(key, [...(accepted.get(key) ?? []), a.digest])
    }
  }
  return readings.map(({ claim, basis, anchors }) => {
    const judged = anchors.map(a => ({ ...a, state: anchorState(a, accepted.get(acceptKey(claim.id, claim.text, a.path, a.symbol)) ?? []) }))
    return { claim, state: claimState(judged.map(a => a.state)), basis, anchors: judged }
  })
}
