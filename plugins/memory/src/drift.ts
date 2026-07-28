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
    // linear scan rather than /\/+$/, which CodeQL flags as polynomial on agent-authored input.
    // A note may declare 'packages/kernel/' or 'packages/kernel'.
    let end = p.length
    while (end > 0 && p[end - 1] === '/') end -= 1
    const declared = p.slice(0, end)
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

// ─── corpus-level drift ──────────────────────────────────────────────────────────────────────
//
// `noteHasDrifted` answers "is THIS note stale" for a reader pulling one. It cannot say that the
// GRAPH has fallen behind — when the repo moves without orc (another editor, a merge, a refactor
// landed elsewhere) every affected note is flagged individually, an agent works around them one at
// a time, and nothing ever suggests re-grounding.
//
// UNDERCOUNTS by construction: `paths` are DECLARED, so a note naming none is uncheckable and
// counts as not-drifted (the module's "fail toward not drifted" rule). Report "at least".
export interface CorpusDrift {
  checkable: number // notes carrying both a sourceRevision and at least one declared path
  drifted: number
  total: number
  /** drifted / checkable, or null when nothing could be checked — never a fabricated 0. */
  ratio: number | null
}

// Past this share of checkable notes, the graph has fallen far enough behind the tree that
// re-grounding beats patching it one note at a time. A guess, and labelled as one: it is a prompt
// for a human decision, never a trigger — a rebuild firing on its own because someone rebased would
// cost more than the staleness it cures.
export const CORPUS_DRIFT_ADVISORY = 0.34

export async function corpusDrift(
  notes: ReadonlyArray<{ sourceRevision: string | null; paths?: readonly string[] }>,
  changedSince: ChangedSince,
): Promise<CorpusDrift> {
  let checkable = 0
  let drifted = 0
  for (const n of notes) {
    const paths = n.paths ?? []
    if (n.sourceRevision === null || paths.length === 0) continue
    checkable += 1
    // one git diff per DISTINCT revision — notes from one run share theirs, so this collapses
    const changed = await changedSince(n.sourceRevision)
    if (changed === null) { checkable -= 1; continue } // unreachable revision is unknown, not drifted
    if (noteHasDrifted({ sourceRevision: n.sourceRevision, paths }, changed)) drifted += 1
  }
  return { checkable, drifted, total: notes.length, ratio: checkable === 0 ? null : drifted / checkable }
}

// Has the graph fallen far enough behind to be worth re-grounding wholesale? A verdict, not a
// sentence: what to SAY about it, and which command to name, belongs to whoever is talking to a
// human. This module measures.
// Takes only what it reads, so a caller holding a narrower shape (MemoryHealth's drift field, which
// has no use for `total`) does not have to fabricate the rest.
export const needsReground = (d: Pick<CorpusDrift, 'ratio'>): boolean =>
  d.ratio !== null && d.ratio >= CORPUS_DRIFT_ADVISORY
