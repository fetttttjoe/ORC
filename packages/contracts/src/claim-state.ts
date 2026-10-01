export enum ClaimState { clean = 'clean', suspect = 'suspect', unknown = 'unknown', unanchored = 'unanchored' }

export interface AnchorReading { path: string; symbol: string | null; basis: string | null; current: string | null; readable: boolean }

export const anchorState = (a: AnchorReading, accepted: readonly string[]): ClaimState => {
  if (!a.readable) return ClaimState.unknown
  if (a.current === null) return ClaimState.suspect
  return a.current === a.basis || accepted.includes(a.current) ? ClaimState.clean : ClaimState.suspect
}

export const claimState = (anchors: readonly ClaimState[]): ClaimState => {
  if (anchors.length === 0) return ClaimState.unanchored
  if (anchors.includes(ClaimState.suspect)) return ClaimState.suspect
  if (anchors.includes(ClaimState.unknown)) return ClaimState.unknown
  return ClaimState.clean
}
