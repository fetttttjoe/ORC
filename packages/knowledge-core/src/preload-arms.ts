import { CLAIM_STATES_BY_TRUST, PreloadArm, underEntity, type ClaimDrift, type ClaimState, type KnowledgeClaim } from '@orc/contracts'

export interface PreloadInputs { pushed: KnowledgeClaim[]; byPath: ClaimDrift[]; hits: KnowledgeClaim[]; stateOf: (claim: KnowledgeClaim) => ClaimState; paths: readonly string[] }

const anchoredWhere = (claim: KnowledgeClaim, paths: readonly string[], relates: (anchor: string, requested: string) => boolean): boolean =>
  claim.anchors.some(a => paths.some(p => relates(a.path, p)))
const atOrUnder = (anchor: string, requested: string): boolean => underEntity(requested, anchor)
const above = (anchor: string, requested: string): boolean => underEntity(anchor, requested)
const at = (anchor: string, requested: string): boolean => atOrUnder(anchor, requested) && above(anchor, requested)

export function preloadArms(inputs: PreloadInputs): Array<{ arm: PreloadArm; claims: KnowledgeClaim[] }> {
  const { paths, hits, stateOf } = inputs
  const rank = new Map(hits.map((c, i) => [c.id, i]))
  const rankOf = (c: KnowledgeClaim): number => rank.get(c.id) ?? hits.length
  const byRank = (a: KnowledgeClaim, b: KnowledgeClaim): number => rankOf(a) - rankOf(b) || a.location.localeCompare(b.location) || a.id.localeCompare(b.id)
  const exact = (c: KnowledgeClaim): number => (anchoredWhere(c, paths, at) ? 0 : 1)
  const byState = (claims: readonly KnowledgeClaim[]): KnowledgeClaim[] =>
    CLAIM_STATES_BY_TRUST.flatMap(state => claims.filter(c => stateOf(c) === state))
  const located = inputs.byPath.map(d => d.claim)
  const here = located.filter(c => anchoredWhere(c, paths, atOrUnder))
  const around = located.filter(c => !here.includes(c) && anchoredWhere(c, paths, above))
  return [
    { arm: PreloadArm.pushed, claims: byState(inputs.pushed) },
    { arm: PreloadArm.here, claims: byState(here.toSorted((a, b) => exact(a) - exact(b) || byRank(a, b))) },
    { arm: PreloadArm.around, claims: byState(around.toSorted(byRank)) },
    { arm: PreloadArm.search, claims: byState(hits) },
  ]
}
