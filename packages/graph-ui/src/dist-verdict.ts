export enum DistVerdict {
  fresh = 'fresh',
  stale = 'stale',
  missing = 'missing',
}

export interface DistFingerprintState {
  distExists: boolean
  // false for a packaged install with no dev source tree to compare against
  sourceAvailable: boolean
  stamp: string | null
  sourceFingerprint: string
}

export function decideDistVerdict(state: DistFingerprintState): DistVerdict {
  if (!state.distExists) return DistVerdict.missing
  if (!state.sourceAvailable) return DistVerdict.fresh
  return state.stamp === state.sourceFingerprint ? DistVerdict.fresh : DistVerdict.stale
}
