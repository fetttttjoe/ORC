export enum ClaimState { clean = 'clean', suspect = 'suspect', unknown = 'unknown', unanchored = 'unanchored' }

export const CLAIM_STATES_BY_TRUST = [ClaimState.clean, ClaimState.unanchored, ClaimState.unknown, ClaimState.suspect] as const
// a state added to the enum but forgotten here is a compile error, not a claim silently dropped by an ordering
type OrderCoversStates = Exclude<ClaimState, (typeof CLAIM_STATES_BY_TRUST)[number]> extends never ? true : never
const orderCoversStates: OrderCoversStates = true
void orderCoversStates

export interface AnchorReading { path: string; symbol: string | null; basis: string | null; current: string | null; readable: boolean }

export interface AnchorEvidence { asserted: readonly string[]; held: readonly string[] }

export const NO_ANCHOR_EVIDENCE: AnchorEvidence = { asserted: [], held: [] }

export const anchorState = (a: AnchorReading, e: AnchorEvidence): ClaimState => {
  if (!a.readable) return ClaimState.unknown
  if (a.current === null) return ClaimState.suspect
  if (e.held.includes(a.current)) return ClaimState.clean
  if (e.asserted.length > 0) return e.asserted.includes(a.current) ? ClaimState.clean : ClaimState.suspect
  return a.current === a.basis ? ClaimState.clean : ClaimState.suspect
}

export const claimState = (anchors: readonly ClaimState[]): ClaimState => {
  if (anchors.length === 0) return ClaimState.unanchored
  if (anchors.includes(ClaimState.suspect)) return ClaimState.suspect
  if (anchors.includes(ClaimState.unknown)) return ClaimState.unknown
  return ClaimState.clean
}
