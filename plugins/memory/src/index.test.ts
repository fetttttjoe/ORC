import { describe, expect, it } from 'bun:test'
import { MemoryNoteInput, NOTE_TIER, type MemoryNote, type VerifiedStamp } from '@orc/contracts'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { measureDrift } from './index'
import type { DriftSources } from './claim-drift-read'

// The corpus drift reading behind `orc status` and needsReground. Measured HERE rather than through
// probeMemory, because what this exercises is the mapping from stored notes into the drift check —
// a field dropped there is invisible everywhere else: the rule still passes its own unit tests while
// no production caller can ever reach it.
// mirrors what the store gateway actually produces — parse into a tier, then stamp provenance — so
// a fixture cannot invent a note the real write path could not
const note = (over: Record<string, unknown> = {}, verified?: VerifiedStamp): MemoryNote => {
  const n = MemoryNoteInput.parse({ id: 'auth', title: 'Auth', paths: ['src/auth.ts'], sourceRevision: 'rev-a', ...over })
  if (n.tier !== NOTE_TIER.semantic) throw new Error(`fixture must be semantic, got '${n.tier}'`)
  return {
    ...n, sources: n.sources.map(src => ({ ...src, retrievedAt: '' })),
    createdAt: 't', createdBy: 'cli', updatedAt: 't', updatedBy: 'cli', revision: 1, workspaceId: TEST_WORKSPACE_ID,
    ...(verified && { verified }),
  }
}
const probe = (changed: Record<string, string[]>): DriftSources => ({
  changedSince: async rev => new Set(changed[rev] ?? []),
  blobsAt: async () => new Map(),
})
const allNotes = (notes: MemoryNote[]) => ({ allNotes: async () => notes })

describe('measureDrift', () => {
  it('counts a note whose declared code moved since it was written', async () => {
    expect(await measureDrift(probe({ 'rev-a': ['src/auth.ts'] }), allNotes([note()])))
      .toEqual({ checkable: 1, drifted: 1, ratio: 1 })
  })

  // The either-clean rule has to survive the trip from a stored note into corpusDrift, or `orc
  // status` keeps reporting notes an auditor confirmed as rot — and needsReground calls for a
  // wholesale re-ground off that inflated ratio.
  it('does not count a note an auditor verified AFTER the code moved', async () => {
    const verified = { revision: 'rev-b', at: '2026-07-30T00:00:00.000Z', by: 'cli' }
    expect(await measureDrift(probe({ 'rev-a': ['src/auth.ts'] }), allNotes([note({}, verified)])))
      .toEqual({ checkable: 1, drifted: 0, ratio: 0 })
  })

  // advisory, never fatal: a reading that cannot be taken is absent, which callers render as "not
  // measured" — deliberately distinct from a measured zero, which would claim the graph is current
  it('returns undefined rather than throwing when the note source is down', async () => {
    expect(await measureDrift(probe({}), { allNotes: async () => { throw new Error('surreal down') } })).toBeUndefined()
  })

  it('returns undefined when nothing is checkable', async () => {
    expect(await measureDrift(probe({}), allNotes([note({ paths: [] })]))).toBeUndefined()
  })
})
