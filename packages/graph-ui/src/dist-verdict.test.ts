import { describe, expect, it } from 'bun:test'
import { decideDistVerdict, DistVerdict } from './dist-verdict'

const FP = 'fingerprint-a'
const OTHER_FP = 'fingerprint-b'

describe('decideDistVerdict', () => {
  it('is missing whenever dist does not exist, regardless of source or stamp', () => {
    expect(decideDistVerdict({ distExists: false, sourceAvailable: true, stamp: FP, sourceFingerprint: FP })).toBe(DistVerdict.missing)
    expect(decideDistVerdict({ distExists: false, sourceAvailable: false, stamp: null, sourceFingerprint: FP })).toBe(DistVerdict.missing)
  })

  it('is fresh when dist exists but the source tree cannot be inspected (packaged install)', () => {
    expect(decideDistVerdict({ distExists: true, sourceAvailable: false, stamp: null, sourceFingerprint: FP })).toBe(DistVerdict.fresh)
  })

  it('is stale when dist exists, source is available, and dist carries no stamp', () => {
    expect(decideDistVerdict({ distExists: true, sourceAvailable: true, stamp: null, sourceFingerprint: FP })).toBe(DistVerdict.stale)
  })

  it('is stale when the stamp does not match the current source fingerprint', () => {
    expect(decideDistVerdict({ distExists: true, sourceAvailable: true, stamp: OTHER_FP, sourceFingerprint: FP })).toBe(DistVerdict.stale)
  })

  it('is fresh when the stamp matches the current source fingerprint', () => {
    expect(decideDistVerdict({ distExists: true, sourceAvailable: true, stamp: FP, sourceFingerprint: FP })).toBe(DistVerdict.fresh)
  })
})
