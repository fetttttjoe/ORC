import { ClaimState } from './claim-state'

export interface PreloadLineClaim { id: string; text: string; anchors: ReadonlyArray<{ path: string; symbol: string | null }> }

const anchorTag = (a: { path: string; symbol: string | null }): string => (a.symbol === null ? `@${a.path}` : `@${a.path}#${a.symbol}`)

export const preloadLine = (claim: PreloadLineClaim, state: ClaimState): string =>
  `- ${claim.text} {${[claim.id, ...(state === ClaimState.clean ? [] : [state]), ...claim.anchors.map(anchorTag)].join(' ')}}`
