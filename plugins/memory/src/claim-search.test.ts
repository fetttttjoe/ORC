import { describe, expect, it } from 'bun:test'
import { TEST_WORKSPACE_ID } from '@orc/contracts/fixtures'
import { dedupeByNote, type ClaimHit } from './claim-search'

const hit = (claimId: string, noteId: string, scope = 'project'): ClaimHit =>
  ({ claimId, noteId, scope, title: noteId, text: claimId, validFrom: '2026-07-26T00:00:00.000Z', sourceRevision: null, paths: [], workspaceId: TEST_WORKSPACE_ID })

describe('dedupeByNote', () => {
  it('keeps the best-ranked claim per note, so one note cannot fill every slot', () => {
    expect(dedupeByNote([hit('c1', 'n1'), hit('c2', 'n1'), hit('c3', 'n2')], 5).map(h => h.claimId))
      .toEqual(['c1', 'c3'])
  })
  it('respects the limit after deduping, not before', () => {
    expect(dedupeByNote([hit('c1', 'n1'), hit('c2', 'n1'), hit('c3', 'n2'), hit('c4', 'n3')], 2).map(h => h.noteId))
      .toEqual(['n1', 'n2'])
  })
  // ids repeat across scopes, so the same note id in two scopes is two notes — the same rule
  // noteKey enforces everywhere else. Keying on the id alone would drop a legitimate hit.
  it('treats the same note id in different scopes as different notes', () => {
    expect(dedupeByNote([hit('c1', 'n1', 'project'), hit('c2', 'n1', 'infra')], 5)).toHaveLength(2)
  })
  it('is empty for no hits and never exceeds the limit', () => {
    expect(dedupeByNote([], 5)).toEqual([])
    expect(dedupeByNote([hit('c1', 'n1'), hit('c2', 'n2')], 0)).toEqual([])
  })
})
