import { noteKey, type ClaimHit, type ClaimSearchOptions, type MemorySearchOpts } from '@orc/contracts'

// re-exported so this module reads as the one place claim retrieval is defined, even though the
// SHAPE belongs to contracts (MemoryStore.searchClaims and MemorySearchResult both need it)
export type { ClaimHit }

// `limit` counts NOTES, not claims — dedupeByNote runs last, so it is the note cap. Local to claim
// search rather than on MemorySearchOpts: the note search does not honour a limit, and putting it
// on the shared type would advertise one it ignores.
// `perNote` picks WHICH question the caller is asking. 'best' (the default) is retrieval: one note
// must not occupy every slot. 'all' is enumeration — "which claims cite this path", where the
// answer is a SET and collapsing it to one per note silently hides the siblings. The retirement
// prompt needs the set: a note asserting three claims about a file the step just edited had two of
// them silently withheld, so the agent retired one and left two standing that its own change had
// falsified.
export interface ClaimSearchOpts extends MemorySearchOpts, ClaimSearchOptions {}

// One note must not occupy every slot: a note with twelve claims about the query would otherwise
// crowd out eleven other notes that each answer it once. Keyed by (scope, id) — ids repeat across
// scopes, so the same id in two scopes is two notes. Input order IS the ranking, so the first hit
// for a note is its best one.
export function dedupeByNote(hits: readonly ClaimHit[], limit: number): ClaimHit[] {
  const seen = new Set<string>()
  const out: ClaimHit[] = []
  for (const h of hits) {
    if (out.length >= limit) break
    const k = noteKey(h.scope, h.noteId)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(h)
  }
  return out
}
