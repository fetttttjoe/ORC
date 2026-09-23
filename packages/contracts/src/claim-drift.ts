export enum ClaimDriftState {
  clean = 'clean',
  suspect = 'suspect',
  unanchored = 'unanchored',
  unknown = 'unknown',
}

/** what the checkout being judged says a path hashes to — null = the file is gone, undefined = the probe could not answer */
export type BlobAt = (path: string) => string | null | undefined

export interface AnchoredClaim {
  anchors: readonly { path: string; blob: string | null }[]
}

export function claimDriftState(claim: AnchoredClaim, blobAt: BlobAt): ClaimDriftState {
  if (claim.anchors.length === 0) return ClaimDriftState.unanchored
  let unknown = false
  for (const anchor of claim.anchors) {
    const observed = blobAt(anchor.path)
    // an unstamped anchor has no basis, and a failed probe is not a known deletion — neither is rot
    if (anchor.blob === null || observed === undefined) unknown = true
    else if (observed !== anchor.blob) return ClaimDriftState.suspect
  }
  return unknown ? ClaimDriftState.unknown : ClaimDriftState.clean
}

/** a verification's snapshot of one claim, taken from the checkout the auditor checked against */
export interface VerifiedAnchors {
  claimId: string
  anchors: readonly { path: string; symbol?: string | null; blob: string | null }[]
}

const anchorShape = (anchors: VerifiedAnchors['anchors']): string =>
  anchors.map(a => `${a.path}\u0000${a.symbol ?? ''}`).sort().join('\n')

/** the latest verification of this very claim and anchor shape, else the blobs its own write stamped */
export function basisAnchors<C extends AnchoredClaim & { id: string }>(claim: C, verified: readonly VerifiedAnchors[]): AnchoredClaim {
  const shape = anchorShape(claim.anchors)
  for (const v of verified)
    if (v.claimId === claim.id && anchorShape(v.anchors) === shape) return { anchors: v.anchors.map(a => ({ path: a.path, blob: a.blob })) }
  return claim
}

export function suspectClaimIds<C extends AnchoredClaim & { id: string }>(claims: readonly C[], blobAt: BlobAt): string[] {
  return claims.filter(c => claimDriftState(c, blobAt) === ClaimDriftState.suspect).map(c => c.id)
}
