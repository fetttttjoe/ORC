// Has the code a note describes moved since the note was written?
//
// Distinct from sweep.ts's `staleNotes`, which retires EXPIRABLE notes nobody has touched in N days
// — that axis is age and access. This one is correctness: a six-month-old note about an untouched
// file is still true, a ten-minute-old note about a file just refactored is not. Age would rank
// both backwards, which is why this reads `sourceRevision` (the commit each note was stamped with
// at write time) instead of a timestamp.
//
// Detection alone would only make the graph bigger and less trustworthy, so the loop closes on the
// write side: memory_write is an upsert and the store re-stamps sourceRevision from current HEAD,
// so an agent that re-grounds a drifted note and writes it back under the SAME id clears the drift.
// Correcting a note is the same call as writing one.

// Every check fails toward "not drifted". A note we cannot check is not evidence of rot, and
// treating unknown as drifted collapses the graph back into re-read-everything — the exact cost
// the graph exists to avoid.
export interface NoteDrift { sourceRevision: string | null; paths: readonly string[] }

// `changed` is null when the comparison could not be made at all (no repo, unreachable revision).
export function noteHasDrifted(note: NoteDrift, changed: ReadonlySet<string> | null): boolean {
  if (changed === null || note.sourceRevision === null || note.paths.length === 0) return false
  for (const p of note.paths) {
    const declared = p.replace(/\/+$/, '') // a note may declare 'packages/kernel/' or 'packages/kernel'
    if (declared === '') continue
    for (const f of changed)
      // a note may point at a FILE or a directory; a directory drifts when anything under it does
      if (f === declared || f.startsWith(`${declared}/`)) return true
  }
  return false
}

// Files differing between `rev` and the working tree — the working tree, not HEAD, because a note
// describes what was on disk when it was written and an uncommitted edit has already invalidated it.
export type ChangedSince = (rev: string) => Promise<ReadonlySet<string> | null>

// One `git diff` per distinct revision per process. Notes written in the same run share a revision,
// so this collapses to a single call in practice.
export function createDriftProbe(dir: string): ChangedSince {
  const cache = new Map<string, Promise<ReadonlySet<string> | null>>()
  return rev => {
    let hit = cache.get(rev)
    if (!hit) {
      hit = (async () => {
        try {
          const proc = Bun.spawn(['git', '-C', dir, 'diff', '--name-only', rev, '--'], { stdout: 'pipe', stderr: 'ignore' })
          const out = await new Response(proc.stdout).text()
          // a revision git cannot reach (rebased away, shallow clone) is UNKNOWN, never "drifted"
          if ((await proc.exited) !== 0) return null
          return new Set(out.split('\n').map(l => l.trim()).filter(l => l !== ''))
        } catch {
          return null
        }
      })()
      cache.set(rev, hit)
    }
    return hit
  }
}
